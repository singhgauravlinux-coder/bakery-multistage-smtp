-- 0010_notification_events.sql
-- Append-only delivery trail for every notification.
--
-- Why this exists: notification_jobs is mutated in place. A message that
-- failed twice on a flaky SMTP host and then succeeded ends up as a single
-- row with status='sent' and attempts=3 — the failures themselves, their
-- timing, and their error text are gone. That is fine for running the queue
-- and useless for audit.
--
-- This table records every state transition instead, and is never updated or
-- deleted by the application. Typical audit queries:
--
--   -- what happened to one message
--   SELECT event, attempt, detail, created_at
--     FROM notification_events WHERE job_id = 'ntf-...' ORDER BY created_at;
--
--   -- every security email sent to one customer
--   SELECT created_at, template, event, detail
--     FROM notification_events
--    WHERE recipient = 'someone@example.com'
--    ORDER BY created_at DESC LIMIT 50;
--
--   -- delivery failure rate by template, last 24h
--   SELECT template,
--          count(*) FILTER (WHERE event = 'sent')   AS sent,
--          count(*) FILTER (WHERE event = 'failed') AS failed,
--          count(*) FILTER (WHERE event = 'dead')   AS dead
--     FROM notification_events
--    WHERE created_at > now() - interval '24 hours'
--    GROUP BY template ORDER BY dead DESC, failed DESC;
--
--   -- one IP triggering resets across many accounts = enumeration
--   SELECT client_ip, count(DISTINCT recipient) AS accounts, count(*) AS mails
--     FROM notification_events
--    WHERE template = 'password-reset' AND created_at > now() - interval '1 hour'
--    GROUP BY client_ip HAVING count(DISTINCT recipient) > 3
--    ORDER BY accounts DESC;
--
--   -- join a delivery back to the auth event that triggered it
--   SELECT a.action, a.email, e.event, e.detail, e.created_at
--     FROM security_audit_logs a
--     JOIN notification_events e ON e.job_id = a.metadata->>'jobId'
--    WHERE a.action LIKE 'security_email_%'
--    ORDER BY e.created_at DESC;
--
-- notification-service and the workers apply the same DDL at boot (it is
-- idempotent), so this file is for teams driving schema with a migration
-- tool instead.

CREATE TABLE IF NOT EXISTS notification_events (
  id         BIGSERIAL PRIMARY KEY,
  job_id     TEXT NOT NULL,
  event      TEXT NOT NULL,     -- queued | sent | failed | requeued | dead
  channel    TEXT,
  recipient  TEXT,
  template   TEXT,
  subject    TEXT,
  attempt    INTEGER,
  provider   TEXT,
  detail     TEXT,              -- SMTP response or error message, truncated to 500 chars
  trace_id   TEXT,
  worker_id  TEXT,
  -- The ORIGINATING client, forwarded by the calling service as x-client-ip
  -- etc. Not the socket peer: notification-service is called pod-to-pod, so
  -- its peer is the auth-service pod and recording that would be useless.
  client_ip         TEXT,
  client_user_agent TEXT,
  origin_user_id    TEXT,
  request_id        TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_events_job   ON notification_events (job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notification_events_recip ON notification_events (recipient, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_events_trace ON notification_events (trace_id);
CREATE INDEX IF NOT EXISTS idx_notification_events_event ON notification_events (event, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_events_ip    ON notification_events (client_ip, created_at DESC);

-- Existing deployments: CREATE TABLE IF NOT EXISTS will not add columns to a
-- table that already exists, so the client columns are added explicitly here
-- and on notification_jobs (the worker reads them from the job row, because
-- it sends the mail long after the HTTP request has gone).
ALTER TABLE notification_events ADD COLUMN IF NOT EXISTS client_ip         TEXT;
ALTER TABLE notification_events ADD COLUMN IF NOT EXISTS client_user_agent TEXT;
ALTER TABLE notification_events ADD COLUMN IF NOT EXISTS origin_user_id    TEXT;
ALTER TABLE notification_events ADD COLUMN IF NOT EXISTS request_id        TEXT;

ALTER TABLE notification_jobs   ADD COLUMN IF NOT EXISTS client_ip         TEXT;
ALTER TABLE notification_jobs   ADD COLUMN IF NOT EXISTS client_user_agent TEXT;
ALTER TABLE notification_jobs   ADD COLUMN IF NOT EXISTS origin_user_id    TEXT;
ALTER TABLE notification_jobs   ADD COLUMN IF NOT EXISTS request_id        TEXT;

-- Retention: this table only grows. Add a periodic prune once volume
-- justifies it, keeping a window long enough for your audit obligations:
--
--   DELETE FROM notification_events WHERE created_at < now() - interval '400 days';
