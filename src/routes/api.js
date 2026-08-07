'use strict';

const express = require('express');
const { db, save, reset } = require('../db');
const clock = require('../clock');
const { INTENTS, USE_ALERT_THRESHOLD } = require('../intents');
const { issueToken, revokeToken, sweep, logEvent, resourceFor, ownerOf } = require('../tokens');
const { issueBearer, requireBearer } = require('../auth');
const { sendTemplate, sendMode } = require('../whatsapp');
const { campaignLinks } = require('../campaign');

const router = express.Router();
router.use(express.json());

function baseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

/** Ops-only powers: the clock, resets, other people's sessions. */
function requireOps(req, res, next) {
  if (req.user.role !== 'ops') return res.status(403).json({ error: 'ops_only', role: req.user.role });
  next();
}

const isOps = (user) => user.role === 'ops';

/**
 * A seller sees strictly their own data. This is enforced here rather than in the
 * browser, so a seller's bearer token cannot read another seller's listings even
 * with hand-made requests.
 */
function mine(user, rows, field) {
  return isOps(user) ? rows : rows.filter((r) => r[field || 'seller_id'] === user.id);
}

// Express 4 needs async throws handed to next() explicitly, or they escape as
// unhandled rejections and take the process with them.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ------------------------------- auth ---------------------------------- */

router.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db().users.find((u) => u.email === email && u.password === password);
  if (!user) return res.status(401).json({ error: 'bad_credentials' });
  logEvent('auth.login', `${user.name} signed in`, { user_id: user.id });
  save();
  res.json({
    token: issueBearer(user),
    user: { id: user.id, name: user.name, email: user.email, role: user.role, wa_id: user.wa_id }
  });
});

router.get('/api/me', requireBearer, (req, res) => {
  const u = req.user;
  res.json({ id: u.id, name: u.name, email: u.email, role: u.role, wa_id: u.wa_id });
});

/* ------------------------------- state --------------------------------- */

router.get('/api/state', requireBearer, (req, res) => {
  sweep();
  const d = db();
  res.json({
    now: clock.now(),
    clock_offset_ms: clock.getOffset(),
    send_mode: sendMode(),
    use_alert_threshold: USE_ALERT_THRESHOLD,
    intents: Object.values(INTENTS).map((i) => ({
      key: i.key,
      label: i.label,
      resource: i.resource,
      ceiling_kind: i.ceilingKind,
      ceiling_ms: i.ceilingMs,
      renewable: i.renewable,
      step_up: i.stepUp,
      rationale: i.rationale
    })),
    me: { id: req.user.id, name: req.user.name, role: req.user.role },
    can: {
      move_clock: isOps(req.user),
      reset_data: isOps(req.user),
      see_all_sellers: isOps(req.user),
      end_any_session: isOps(req.user)
    },
    users: mine(req.user, d.users, 'id').map((u) => ({
      id: u.id,
      name: u.name,
      role: u.role,
      wa_id: u.wa_id,
      city: u.city
    })),
    listings: mine(req.user, d.listings),
    bids: mine(req.user, d.bids),
    kyc: mine(req.user, d.kyc),
    // token_hash is never returned - the console sees the ledger, not the secret
    tokens: mine(req.user, d.tokens).map(({ token_hash, ...rest }) => rest),
    sessions: mine(req.user, d.sessions),
    messages: mine(req.user, d.messages),
    otps: isOps(req.user) ? d.otps.slice(0, 10) : [],
    // A seller's log is only their own activity.
    events: isOps(req.user)
      ? d.events.slice(0, 60)
      : d.events.filter((e) => JSON.stringify(e.meta || {}).includes(req.user.id)).slice(0, 60),
    campaign: campaignLinks(baseUrl(req), isOps(req.user) ? null : [req.user.id])
  });
});

/* ------------------------------- links --------------------------------- */

router.post('/api/links', requireBearer, wrap(async (req, res) => {
  const { intent, resource_id } = req.body || {};

  // A seller may only mint links for resources they own.
  const def = INTENTS[intent];
  if (!def) return res.status(409).json({ error: 'unknown_intent' });
  const target = resourceFor(def, resource_id);
  if (!target) return res.status(409).json({ error: 'unknown_resource' });
  if (!isOps(req.user) && ownerOf(def, target) !== req.user.id) {
    return res.status(403).json({ error: 'not_your_resource' });
  }

  const issued = issueToken({ intentKey: intent, resourceId: resource_id, actor: req.user.id });
  if (issued.error) return res.status(409).json({ error: issued.error });

  const msg = await sendTemplate({
    seller: issued.seller,
    intent: issued.intent,
    resource: issued.resource,
    secret: issued.secret,
    baseUrl: baseUrl(req)
  });

  res.json({
    ok: true,
    token: { ...issued.row, token_hash: undefined },
    // The raw secret exists exactly once, here, on its way into the message.
    url: msg.url,
    message_id: msg.id
  });
}));

router.post('/api/tokens/:id/revoke', requireBearer, (req, res) => {
  const existing = db().tokens.find((t) => t.id === req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  if (!isOps(req.user) && existing.seller_id !== req.user.id) {
    return res.status(403).json({ error: 'not_your_token' });
  }
  const out = revokeToken(req.params.id, isOps(req.user) ? 'ops_manual' : 'seller_manual');
  if (out.error) return res.status(404).json(out);
  res.json({ ok: true, token: { ...out.row, token_hash: undefined } });
});

/**
 * Set a test user's real phone number. Nothing reaches a real handset until this
 * is a number that has opted in to your Gupshup app.
 */
router.patch('/api/users/:id', requireBearer, (req, res) => {
  const user = db().users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'not_found' });
  if (!isOps(req.user) && user.id !== req.user.id) {
    return res.status(403).json({ error: 'not_your_profile' });
  }
  const wa = String((req.body && req.body.wa_id) || '').replace(/[^0-9]/g, '');
  if (wa && wa.length < 10) return res.status(400).json({ error: 'wa_id_too_short' });
  user.wa_id = wa || null;
  save();
  logEvent('user.updated', `${user.name} phone set to ${wa ? '+' + wa : '(none)'}`, { user_id: user.id });
  res.json({ ok: true, user: { id: user.id, name: user.name, wa_id: user.wa_id } });
});

/* ------------------- ops-side state changes (revocation) ---------------- */

router.post('/api/ops/sessions/:id/end', requireBearer, requireOps, (req, res) => {
  const s = db().sessions.find((x) => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'not_found' });
  s.status = 'ended';
  save();
  logEvent('session.ended', `Session ${s.id} ended by ops`, { session_id: s.id });
  res.json({ ok: true });
});

/* ------------------------- harness controls ----------------------------- */

router.post('/api/dev/clock', requireBearer, requireOps, (req, res) => {
  const { advance_ms, reset: doReset } = req.body || {};
  if (doReset) clock.setOffset(0);
  else clock.advance(Number(advance_ms) || 0);
  db().clock_offset_ms = clock.getOffset();
  sweep();
  logEvent('clock.changed', `Virtual clock offset now ${Math.round(clock.getOffset() / 60000)} min`, null);
  save();
  res.json({ ok: true, now: clock.now(), clock_offset_ms: clock.getOffset() });
});

router.post('/api/dev/reset', requireBearer, requireOps, (req, res) => {
  reset();
  clock.setOffset(0);
  // Reseeding wipes the ledger, so put the permanent campaign tokens back.
  require('../campaign').ensureCampaignTokens();
  res.json({ ok: true });
});

/** The pasteable campaign URLs. Sellers see only their own. */
router.get('/api/campaign', requireBearer, (req, res) => {
  res.json({ links: campaignLinks(baseUrl(req), isOps(req.user) ? null : [req.user.id]) });
});

module.exports = router;
