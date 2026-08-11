'use strict';
// Delivery providers.
//
// Email goes over SMTP when SMTP_HOST is set, and falls back to a mock sender
// otherwise — so the stack still boots with no mail server configured, and CI
// never tries to reach the internet. Locally SMTP_HOST points at Mailpit (see
// docker-compose.yml); against Gmail it is smtp.gmail.com with an App
// Password. SMS stays mocked; swap sendSms for a Twilio client the same way.
const nodemailer = require('nodemailer');
const { render } = require('./templates');

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
// Port 465 is implicit TLS; 587 and 1025 (Mailpit) start plaintext and upgrade.
const SMTP_SECURE = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : SMTP_PORT === 465;
const SMTP_FROM = process.env.SMTP_FROM || 'Crumb & Ember <no-reply@crumb-and-ember.example>';
// Gmail throttles parallel sessions, so the pool is deliberately narrow.
// Real throughput comes from WORKER_CONCURRENCY x replicas, not from this.
const SMTP_MAX_CONNECTIONS = Number(process.env.SMTP_MAX_CONNECTIONS || 1);
const SMTP_TIMEOUT_MS = Number(process.env.SMTP_TIMEOUT_MS || 10000);

// Mock-only knobs, kept so the retry/dead-letter paths stay exercisable
// without a mail server: NOTIFY_FAILURE_RATE=0.3 docker compose up
const LATENCY_MS = Number(process.env.NOTIFY_PROVIDER_LATENCY_MS || 50);
const FAILURE_RATE = Math.min(1, Math.max(0, Number(process.env.NOTIFY_FAILURE_RATE || 0)));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SMS_RE = /^\+?[0-9][0-9 ()-]{5,19}$/;

const smtpEnabled = Boolean(SMTP_HOST);

const transport = smtpEnabled ? nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_SECURE,
  auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  pool: true,
  maxConnections: SMTP_MAX_CONNECTIONS,
  connectionTimeout: SMTP_TIMEOUT_MS,
  greetingTimeout: SMTP_TIMEOUT_MS,
  socketTimeout: SMTP_TIMEOUT_MS
}) : null;

// --- SMTP failure classification -----------------------------------------
// The worker retries by default and only dead-letters when told the failure is
// permanent, so this mapping decides whether a bounce costs one attempt or the
// whole message.
//
//   4xx           -> transient (greylisting, rate limits, server busy)
//   535 / 534     -> transient ON PURPOSE. A bad App Password is a config
//                    error; dead-lettering on it would destroy every queued
//                    message before anyone could fix the credential.
//   550/551/553/554 and other 5xx -> permanent (bad mailbox, rejected content)
//   no code at all (ECONNREFUSED, ETIMEDOUT, DNS) -> transient
const AUTH_CODES = new Set([534, 535]);
const INFRA_CODES = new Set([421, 534, 535]);   // server gone, or we can't log in

function isPermanent(err) {
  const code = Number(err.responseCode);
  if (!Number.isFinite(code)) return false;   // network-level: always retry
  if (AUTH_CODES.has(code)) return false;     // fixable config, keep the queue
  return code >= 500;
}

// Infrastructure failures are not the message's fault: a wrong App Password or
// an unreachable host fails every job identically. Retrying cannot fix them, so
// the worker requeues without consuming an attempt — otherwise a single bad
// credential quietly dead-letters the entire backlog while someone looks for
// it. These jobs wait, indefinitely if need be, and drain once the config is
// fixed.
function isInfrastructure(err) {
  const code = Number(err.responseCode);
  if (!Number.isFinite(code)) return true;    // ECONNREFUSED, ETIMEDOUT, DNS
  return INFRA_CODES.has(code);
}

async function sendViaSmtp(job) {
  // Rendered here rather than at enqueue time, so a template fix reaches jobs
  // that are already sitting in the queue.
  const rendered = job.template ? render(job.template, job.payload || {}, { subject: job.subject }) : null;
  try {
    const info = await transport.sendMail({
      from: SMTP_FROM,
      to: job.recipient,
      subject: (rendered ? rendered.subject : job.subject) || '(no subject)',
      // Both parts, always: text/plain keeps the message readable in previews
      // and out of spam filters that distrust HTML-only mail.
      text: rendered ? rendered.text : (job.body || ''),
      ...(rendered ? { html: rendered.html } : {}),
      // Lets a delivery in the mail server's logs be traced back to the API
      // request that queued it, same as the JSON logs.
      headers: { 'X-Trace-Id': job.traceId || '', 'X-Notification-Job-Id': job.id }
    });
    return { providerMessageId: info.messageId, accepted: info.accepted };
  } catch (err) {
    if (isPermanent(err)) err.permanent = true;
    else if (isInfrastructure(err)) err.infrastructure = true;
    err.message = `smtp: ${err.message}`;
    throw err;
  }
}

async function sendMock(channel, job) {
  if (LATENCY_MS > 0) await sleep(LATENCY_MS);
  if (FAILURE_RATE && Math.random() < FAILURE_RATE) {
    throw new Error(`${channel} provider temporarily unavailable`);
  }
  return { providerMessageId: `mock-${channel}-${job.id}` };
}

async function sendEmail(job) {
  // A malformed recipient will never succeed, so fail it permanently rather
  // than burning five retries on it.
  if (!EMAIL_RE.test(job.recipient)) {
    throw Object.assign(new Error('invalid email recipient'), { permanent: true });
  }
  return smtpEnabled ? sendViaSmtp(job) : sendMock('email', job);
}

async function sendSms(job) {
  if (!SMS_RE.test(job.recipient)) {
    throw Object.assign(new Error('invalid sms recipient'), { permanent: true });
  }
  return sendMock('sms', job);
}

async function deliver(job) {
  switch (job.channel) {
    case 'email': return sendEmail(job);
    case 'sms': return sendSms(job);
    default: throw Object.assign(new Error(`unknown channel: ${job.channel}`), { permanent: true });
  }
}

// Called once on worker boot: surfaces a bad host or a rejected App Password
// in the logs immediately instead of one failed delivery at a time.
async function verify(logger) {
  if (!smtpEnabled) {
    logger.warn({ event: 'smtp_disabled' },
      'SMTP_HOST unset — emails are mocked, not delivered');
    return false;
  }
  try {
    await transport.verify();
    logger.info({
      event: 'smtp_ready', host: SMTP_HOST, port: SMTP_PORT,
      secure: SMTP_SECURE, authenticated: Boolean(SMTP_USER), maxConnections: SMTP_MAX_CONNECTIONS
    }, 'smtp transport verified');
    return true;
  } catch (err) {
    // Not fatal: jobs stay queued and retry, so fixing the secret and
    // restarting drains the backlog rather than losing it.
    logger.error({ event: 'smtp_verify_failed', host: SMTP_HOST, port: SMTP_PORT, message: err.message },
      'smtp transport unavailable — notifications will queue and retry');
    return false;
  }
}

function close() {
  if (transport) transport.close();
}

module.exports = { deliver, sendEmail, sendSms, verify, close, smtpEnabled, isPermanent, isInfrastructure };
