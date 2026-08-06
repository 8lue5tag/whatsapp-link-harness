'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { db, save } = require('./db');
const { now } = require('./clock');
const { INTENTS, SESSION_ABSOLUTE_MS, OTP_FRESH_MS } = require('./intents');
const { logEvent } = require('./tokens');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-harness-secret';
const JWT_TTL = '12h';
const SESSION_COOKIE = 'rq_sess';

/* ------------------------------------------------------------------ *
 * Credential type 1: operator / test-user bearer JWT (API + console)
 * ------------------------------------------------------------------ */

function issueBearer(user) {
  return jwt.sign({ sub: user.id, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: JWT_TTL });
}

function requireBearer(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, value] = header.split(' ');
  if (scheme !== 'Bearer' || !value) {
    return res.status(401).json({ error: 'missing_bearer_token' });
  }
  let claims;
  try {
    claims = jwt.verify(value, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'invalid_bearer_token', detail: err.message });
  }
  const user = db().users.find((u) => u.id === claims.sub);
  if (!user) return res.status(401).json({ error: 'unknown_user' });
  req.user = user;
  next();
}

/* ------------------------------------------------------------------ *
 * Credential type 2: scoped session cookie, minted by a link redemption
 * ------------------------------------------------------------------ */

function createSession(res, tokenRow) {
  const d = db();
  const intent = INTENTS[tokenRow.intent];
  const session = {
    id: 'sess_' + crypto.randomBytes(12).toString('hex'),
    seller_id: tokenRow.seller_id,
    intent: tokenRow.intent,
    resource_id: tokenRow.resource_id, // scope: this listing, this intent, nothing else
    token_id: tokenRow.id,
    created_at: now(),
    last_seen_at: now(),
    idle_ms: intent.sessionIdleMs,
    absolute_expires_at: now() + SESSION_ABSOLUTE_MS,
    otp_verified_at: null,
    status: 'active'
  };
  d.sessions.unshift(session);
  save();

  res.cookie(SESSION_COOKIE, session.id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: false, // localhost over http; flip to true behind TLS
    path: '/'
  });
  logEvent('session.created', `Scoped session for ${session.seller_id} on ${session.resource_id} (${session.intent})`, {
    session_id: session.id
  });
  return session;
}

function sessionState(session) {
  if (!session) return { state: 'none' };
  if (session.status === 'ended') return { state: 'ended' };
  if (now() >= session.absolute_expires_at) return { state: 'absolute_expired' };
  if (now() - session.last_seen_at >= session.idle_ms) return { state: 'idle_expired' };
  return { state: 'active' };
}

/**
 * Sliding idle window. Only non-GET requests count as a "meaningful action" and
 * push the window out - so polling the status endpoint cannot keep a session
 * alive forever. The absolute cap above it never slides.
 */
function requireSession(req, res, next) {
  const id = req.cookies[SESSION_COOKIE];
  const session = db().sessions.find((s) => s.id === id);
  const { state } = sessionState(session);

  if (state !== 'active') {
    return res.status(401).json({ error: 'session_' + (state === 'none' ? 'missing' : state) });
  }

  if (req.method !== 'GET') {
    session.last_seen_at = now();
    save();
  }
  req.session = session;
  req.seller = db().users.find((u) => u.id === session.seller_id);
  next();
}

/** The session is scoped: right intent, right resource, or nothing. */
function requireScope(intentKey, resourceIdFrom) {
  return function (req, res, next) {
    const wanted = resourceIdFrom(req);
    if (req.session.intent !== intentKey) {
      return res.status(403).json({ error: 'wrong_intent', have: req.session.intent, need: intentKey });
    }
    if (req.session.resource_id !== wanted) {
      return res.status(403).json({ error: 'wrong_resource', have: req.session.resource_id, need: wanted });
    }
    next();
  };
}

/**
 * Step-up. The link gets them to the desk; it does not get them into the safe.
 * Anything sensitive demands a fresh OTP regardless of how they arrived.
 */
function requireFreshOtp(req, res, next) {
  const verifiedAt = req.session.otp_verified_at;
  if (!verifiedAt || now() - verifiedAt > OTP_FRESH_MS) {
    return res.status(401).json({ error: 'otp_required', fresh_for_ms: OTP_FRESH_MS });
  }
  next();
}

function endSession(req) {
  const id = req.cookies && req.cookies[SESSION_COOKIE];
  const session = db().sessions.find((s) => s.id === id);
  if (session) {
    session.status = 'ended';
    save();
  }
}

module.exports = {
  issueBearer,
  requireBearer,
  createSession,
  requireSession,
  requireScope,
  requireFreshOtp,
  sessionState,
  endSession,
  SESSION_COOKIE
};
