'use strict';
// Postgres-backed notification queue, shared by server.js (producer) and
// worker.js (consumer). Falls back to an in-process queue when DATABASE_URL
// is unset so `docker compose up` still works without the database — the
// same pattern invoice-service uses.
const crypto = require('crypto');

// Mirrored in db/migrations/0007_notification_jobs.sql. Idempotent, so both
// the API and the workers can run it on boot without racing each other.
const MIGRATION = `
  CREATE TABLE IF NOT EXISTS notification_jobs (
    id           TEXT PRIMARY KEY,
    channel      TEXT NOT NULL,
    recipient    TEXT NOT NULL,
    subject      TEXT,
    body         TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'queued',
    attempts     INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    last_error   TEXT,
    trace_id     TEXT,
    template     TEXT,
    payload      JSONB,
    -- Originating client, forwarded by the calling service (x-client-ip and
    -- friends). Stored on the job because the worker sends the mail minutes
    -- later, with no HTTP request of its own to read them from.
    client_ip         TEXT,
    client_user_agent TEXT,
    origin_user_id    TEXT,
    request_id        TEXT,
    run_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    locked_by    TEXT,
    locked_at    TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE notification_jobs ADD COLUMN IF NOT EXISTS client_ip         TEXT;
  ALTER TABLE notification_jobs ADD COLUMN IF NOT EXISTS client_user_agent TEXT;
  ALTER TABLE notification_jobs ADD COLUMN IF NOT EXISTS origin_user_id    TEXT;
  ALTER TABLE notification_jobs ADD COLUMN IF NOT EXISTS request_id        TEXT;

  CREATE INDEX IF NOT EXISTS idx_notification_jobs_claim ON notification_jobs (status, run_at);
  CREATE INDEX IF NOT EXISTS idx_notification_jobs_trace ON notification_jobs (trace_id);

  -- Append-only delivery trail. notification_jobs is mutated in place, so a
  -- retried-then-sent message leaves no trace of having failed — fine for the
  -- queue, useless for audit. This table records every state transition, so
  -- "what happened to the reset mail we sent that customer" is answerable
  -- after the fact. Never updated, only inserted; see
  -- db/migrations/0010_notification_events.sql.
  CREATE TABLE IF NOT EXISTS notification_events (
    id         BIGSERIAL PRIMARY KEY,
    job_id     TEXT NOT NULL,
    event      TEXT NOT NULL,     -- queued | claimed | sent | failed | requeued | dead
    channel    TEXT,
    recipient  TEXT,
    template   TEXT,
    subject    TEXT,
    attempt    INTEGER,
    provider   TEXT,
    detail     TEXT,              -- SMTP response or error message, truncated
    trace_id   TEXT,
    worker_id  TEXT,
    client_ip         TEXT,   -- the customer's IP, not the calling pod's
    client_user_agent TEXT,
    origin_user_id    TEXT,
    request_id        TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_notification_events_job    ON notification_events (job_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_notification_events_recip  ON notification_events (recipient, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_notification_events_trace  ON notification_events (trace_id);
  CREATE INDEX IF NOT EXISTS idx_notification_events_event  ON notification_events (event, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_notification_events_ip     ON notification_events (client_ip, created_at DESC);

  ALTER TABLE notification_events ADD COLUMN IF NOT EXISTS client_ip         TEXT;
  ALTER TABLE notification_events ADD COLUMN IF NOT EXISTS client_user_agent TEXT;
  ALTER TABLE notification_events ADD COLUMN IF NOT EXISTS origin_user_id    TEXT;
  ALTER TABLE notification_events ADD COLUMN IF NOT EXISTS request_id        TEXT;
`;

// `id` is ambiguous inside UPDATE ... FROM claimed, so the claim query needs
// the table-qualified variant; everything else uses the bare one.
const cols = (p = '') => `${p}id, ${p}channel, ${p}recipient, ${p}subject, ${p}body, ${p}status,
  ${p}template, ${p}payload,
  ${p}attempts, ${p}max_attempts AS "maxAttempts", ${p}last_error AS "lastError",
  ${p}trace_id AS "traceId", ${p}run_at AS "runAt",
  ${p}client_ip AS "clientIp", ${p}client_user_agent AS "clientUserAgent",
  ${p}origin_user_id AS "originUserId", ${p}request_id AS "requestId",
  ${p}created_at AS "createdAt", ${p}updated_at AS "updatedAt"`;
const ROW = cols();
const ROW_J = cols('j.');

const newJobId = () => 'ntf-' + crypto.randomBytes(6).toString('hex');

function createQueue({ pool, logger }) {
  if (!pool) return memoryQueue({ logger });

  return {
    mode: 'postgres',

    async init() { await pool.query(MIGRATION); },

    async enqueue({ channel, recipient, subject, body, traceId, maxAttempts, template, payload,
                    clientIp, clientUserAgent, originUserId, requestId }) {
      const { rows } = await pool.query(
        `INSERT INTO notification_jobs
           (id, channel, recipient, subject, body, trace_id, max_attempts, template, payload,
            client_ip, client_user_agent, origin_user_id, request_id)
         VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7, 5),$8,$9,$10,$11,$12,$13) RETURNING ${ROW}`,
        [newJobId(), channel, recipient, subject || null, body || '', traceId || null, maxAttempts || null,
         template || null, payload ? JSON.stringify(payload) : null,
         clientIp || null, clientUserAgent || null, originUserId || null, requestId || null]);
      return rows[0];
    },

    async get(id) {
      const { rows } = await pool.query(`SELECT ${ROW} FROM notification_jobs WHERE id = $1`, [id]);
      return rows[0] || null;
    },

    // Atomic claim. SKIP LOCKED means a row already locked by another worker
    // is stepped over rather than waited on, so replicas scale linearly and
    // no job is ever delivered twice concurrently.
    async claim(workerId, batchSize) {
      const { rows } = await pool.query(
        `WITH claimed AS (
           SELECT id FROM notification_jobs
           WHERE status = 'queued' AND run_at <= now()
           ORDER BY run_at
           FOR UPDATE SKIP LOCKED
           LIMIT $2
         )
         UPDATE notification_jobs j
            SET status = 'processing', attempts = j.attempts + 1,
                locked_by = $1, locked_at = now(), updated_at = now()
           FROM claimed
          WHERE j.id = claimed.id
          RETURNING ${ROW_J}`,
        [workerId, batchSize]);
      return rows;
    },

    async markSent(id) {
      await pool.query(
        `UPDATE notification_jobs
            SET status = 'sent', last_error = NULL, locked_by = NULL, locked_at = NULL, updated_at = now()
          WHERE id = $1`, [id]);
    },

    // Requeue with backoff, or park the job as 'dead' once it has burned
    // through max_attempts so it stops consuming worker cycles forever.
    async markFailed(id, message, backoffSeconds) {
      const { rows } = await pool.query(
        `UPDATE notification_jobs
            SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
                run_at = CASE WHEN attempts >= max_attempts THEN run_at
                              ELSE now() + ($2 || ' seconds')::interval END,
                last_error = $3, locked_by = NULL, locked_at = NULL, updated_at = now()
          WHERE id = $1
          RETURNING status, attempts`,
        [id, String(backoffSeconds), String(message).slice(0, 500)]);
      return rows[0] || null;
    },

    // Put a job back WITHOUT charging it an attempt. Used for failures that
    // are not the message's fault (SMTP unreachable, bad credentials), where
    // counting attempts would dead-letter the whole backlog over one config
    // error. claim() already incremented, so this undoes that.
    async requeue(id, delaySeconds, message) {
      await pool.query(
        `UPDATE notification_jobs
            SET status = 'queued', attempts = GREATEST(0, attempts - 1),
                run_at = now() + ($2 || ' seconds')::interval,
                last_error = $3, locked_by = NULL, locked_at = NULL, updated_at = now()
          WHERE id = $1`,
        [id, String(delaySeconds), String(message).slice(0, 500)]);
    },

    // Errors that can never succeed on retry (invalid recipient, unknown
    // channel) skip the backoff ladder entirely.
    async markDead(id, message) {
      await pool.query(
        `UPDATE notification_jobs
            SET status = 'dead', last_error = $2, locked_by = NULL, locked_at = NULL, updated_at = now()
          WHERE id = $1`, [id, String(message).slice(0, 500)]);
    },

    // A worker killed mid-delivery leaves its rows in 'processing' forever.
    // Any surviving worker sweeps them back to 'queued' after the lock ages
    // out (at-least-once delivery — the mock providers are idempotent).
    async reclaimStale(staleSeconds) {
      const { rowCount } = await pool.query(
        `UPDATE notification_jobs
            SET status = 'queued', locked_by = NULL, locked_at = NULL, updated_at = now()
          WHERE status = 'processing' AND locked_at < now() - ($1 || ' seconds')::interval`,
        [String(staleSeconds)]);
      return rowCount;
    },

    async stats() {
      const { rows } = await pool.query(
        `SELECT status, count(*)::int AS count FROM notification_jobs GROUP BY status`);
      return rows.reduce((acc, r) => ({ ...acc, [r.status]: r.count }), {});
    },

    // Append-only. Deliberately swallows its own errors: an audit insert
    // must never fail a delivery or wedge the queue. A dropped event is
    // logged loudly instead.
    async record(event, job = {}, extra = {}) {
      try {
        await pool.query(
          `INSERT INTO notification_events
             (job_id, event, channel, recipient, template, subject, attempt, provider, detail,
              trace_id, worker_id, client_ip, client_user_agent, origin_user_id, request_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [job.id || extra.jobId || null, event, job.channel || null, job.recipient || null,
           job.template || null, job.subject || null,
           extra.attempt != null ? extra.attempt : (job.attempts != null ? job.attempts : null),
           extra.provider || null,
           extra.detail == null ? null : String(extra.detail).slice(0, 500),
           job.traceId || extra.traceId || null, extra.workerId || null,
           job.clientIp || extra.clientIp || null,
           job.clientUserAgent || extra.clientUserAgent || null,
           job.originUserId || extra.originUserId || null,
           job.requestId || extra.requestId || null]);
      } catch (err) {
        logger.error({ event: 'notification_event_insert_failed', jobId: job.id, kind: event, message: err.message },
          'delivery audit row could not be written');
      }
    },

    // Full trail for one job, oldest first — the "what happened to this
    // message" query.
    async history(jobId) {
      const { rows } = await pool.query(
        `SELECT id, job_id AS "jobId", event, channel, recipient, template, subject,
                attempt, provider, detail, trace_id AS "traceId", worker_id AS "workerId",
                client_ip AS "clientIp", client_user_agent AS "clientUserAgent",
                origin_user_id AS "originUserId", request_id AS "requestId", created_at AS "createdAt"
           FROM notification_events WHERE job_id = $1 ORDER BY created_at, id`, [jobId]);
      return rows;
    },

    // Recent activity for one recipient — the audit question that comes up
    // when a customer says they never got the mail.
    async historyForRecipient(recipient, limit = 50) {
      const { rows } = await pool.query(
        `SELECT id, job_id AS "jobId", event, channel, recipient, template, subject,
                attempt, provider, detail, trace_id AS "traceId",
                client_ip AS "clientIp", origin_user_id AS "originUserId", created_at AS "createdAt"
           FROM notification_events WHERE recipient = $1
          ORDER BY created_at DESC, id DESC LIMIT $2`, [recipient, Math.min(Number(limit) || 50, 200)]);
      return rows;
    },

    // Everything one IP triggered — enumeration and abuse investigation.
    async historyForIp(clientIp, limit = 50) {
      const { rows } = await pool.query(
        `SELECT id, job_id AS "jobId", event, channel, recipient, template, subject,
                attempt, detail, trace_id AS "traceId", client_ip AS "clientIp",
                origin_user_id AS "originUserId", created_at AS "createdAt"
           FROM notification_events WHERE client_ip = $1
          ORDER BY created_at DESC, id DESC LIMIT $2`, [clientIp, Math.min(Number(limit) || 50, 200)]);
      return rows;
    },

    async ping() { await pool.query('SELECT 1'); }
  };
}

// ---------------------------------------------------------------------------
// In-memory fallback. Single-process only: an in-process worker will drain it,
// but a separate worker container has no shared state, hence the loud warning.
function memoryQueue({ logger }) {
  const jobs = new Map();
  const events = [];
  if (logger) {
    logger.warn({ event: 'queue_memory_mode' },
      'DATABASE_URL unset — using in-memory queue; separate worker replicas will NOT see these jobs');
  }
  const now = () => new Date();

  return {
    mode: 'memory',
    async init() {},
    async enqueue({ channel, recipient, subject, body, traceId, maxAttempts, template, payload,
                    clientIp, clientUserAgent, originUserId, requestId }) {
      const job = {
        id: newJobId(), channel, recipient, subject: subject || null, body: body || '',
        status: 'queued', attempts: 0, maxAttempts: maxAttempts || 5, lastError: null,
        traceId: traceId || null, template: template || null, payload: payload || null,
        clientIp: clientIp || null, clientUserAgent: clientUserAgent || null,
        originUserId: originUserId || null, requestId: requestId || null,
        runAt: now(), createdAt: now(), updatedAt: now()
      };
      jobs.set(job.id, job);
      return job;
    },
    async get(id) { return jobs.get(id) || null; },
    async claim(workerId, batchSize) {
      const claimed = [];
      for (const job of jobs.values()) {
        if (claimed.length >= batchSize) break;
        if (job.status === 'queued' && job.runAt <= now()) {
          Object.assign(job, { status: 'processing', attempts: job.attempts + 1, lockedBy: workerId, updatedAt: now() });
          claimed.push({ ...job });
        }
      }
      return claimed;
    },
    async markSent(id) {
      const job = jobs.get(id);
      if (job) Object.assign(job, { status: 'sent', lastError: null, updatedAt: now() });
    },
    async markFailed(id, message, backoffSeconds) {
      const job = jobs.get(id);
      if (!job) return null;
      const dead = job.attempts >= job.maxAttempts;
      Object.assign(job, {
        status: dead ? 'dead' : 'queued',
        runAt: dead ? job.runAt : new Date(Date.now() + backoffSeconds * 1000),
        lastError: String(message).slice(0, 500),
        updatedAt: now()
      });
      return { status: job.status, attempts: job.attempts };
    },
    async requeue(id, delaySeconds, message) {
      const job = jobs.get(id);
      if (job) Object.assign(job, {
        status: 'queued', attempts: Math.max(0, job.attempts - 1),
        runAt: new Date(Date.now() + delaySeconds * 1000),
        lastError: String(message).slice(0, 500), updatedAt: now()
      });
    },
    async markDead(id, message) {
      const job = jobs.get(id);
      if (job) Object.assign(job, { status: 'dead', lastError: String(message).slice(0, 500), updatedAt: now() });
    },
    async reclaimStale() { return 0; },

    // Memory-mode parity for the delivery trail. Bounded so a long-running
    // dev container cannot grow it without limit.
    async record(event, job = {}, extra = {}) {
      events.push({
        id: events.length + 1, jobId: job.id || extra.jobId || null, event,
        channel: job.channel || null, recipient: job.recipient || null,
        template: job.template || null, subject: job.subject || null,
        attempt: extra.attempt != null ? extra.attempt : (job.attempts != null ? job.attempts : null),
        provider: extra.provider || null,
        detail: extra.detail == null ? null : String(extra.detail).slice(0, 500),
        traceId: job.traceId || extra.traceId || null, workerId: extra.workerId || null,
        clientIp: job.clientIp || extra.clientIp || null,
        clientUserAgent: job.clientUserAgent || extra.clientUserAgent || null,
        originUserId: job.originUserId || extra.originUserId || null,
        requestId: job.requestId || extra.requestId || null,
        createdAt: new Date().toISOString()
      });
      if (events.length > 5000) events.shift();
    },
    async history(jobId) { return events.filter((e) => e.jobId === jobId); },
    async historyForRecipient(recipient, limit = 50) {
      return events.filter((e) => e.recipient === recipient).slice(-Math.min(Number(limit) || 50, 200)).reverse();
    },
    async historyForIp(clientIp, limit = 50) {
      return events.filter((e) => e.clientIp === clientIp).slice(-Math.min(Number(limit) || 50, 200)).reverse();
    },
    async stats() {
      return [...jobs.values()].reduce((acc, j) => ({ ...acc, [j.status]: (acc[j.status] || 0) + 1 }), {});
    },
    async ping() {}
  };
}

module.exports = { createQueue, MIGRATION };
