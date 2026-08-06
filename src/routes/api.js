'use strict';

const express = require('express');
const { db, save, reset } = require('../db');
const clock = require('../clock');
const { INTENTS, USE_ALERT_THRESHOLD } = require('../intents');
const { issueToken, revokeToken, sweep, logEvent } = require('../tokens');
const { issueBearer, requireBearer } = require('../auth');
const { sendTemplate, sendMode } = require('../whatsapp');

const router = express.Router();
router.use(express.json());

function baseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

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
      ceiling_ms: i.ceilingMs,
      renewable: i.renewable,
      step_up: i.stepUp,
      rationale: i.rationale
    })),
    users: d.users.map((u) => ({ id: u.id, name: u.name, role: u.role, wa_id: u.wa_id, city: u.city })),
    listings: d.listings,
    bids: d.bids,
    kyc: d.kyc,
    // token_hash is never returned - the console sees the ledger, not the secret
    tokens: d.tokens.map(({ token_hash, ...rest }) => rest),
    sessions: d.sessions,
    messages: d.messages,
    otps: d.otps.slice(0, 10),
    events: d.events.slice(0, 60)
  });
});

/* ------------------------------- links --------------------------------- */

router.post('/api/links', requireBearer, async (req, res) => {
  const { intent, resource_id } = req.body || {};
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
});

router.post('/api/tokens/:id/revoke', requireBearer, (req, res) => {
  const out = revokeToken(req.params.id, 'ops_manual');
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
  const wa = String((req.body && req.body.wa_id) || '').replace(/[^0-9]/g, '');
  if (wa && wa.length < 10) return res.status(400).json({ error: 'wa_id_too_short' });
  user.wa_id = wa || null;
  save();
  logEvent('user.updated', `${user.name} phone set to ${wa ? '+' + wa : '(none)'}`, { user_id: user.id });
  res.json({ ok: true, user: { id: user.id, name: user.name, wa_id: user.wa_id } });
});

/* ------------------- ops-side state changes (revocation) ---------------- */

router.post('/api/ops/sessions/:id/end', requireBearer, (req, res) => {
  const s = db().sessions.find((x) => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'not_found' });
  s.status = 'ended';
  save();
  logEvent('session.ended', `Session ${s.id} ended by ops`, { session_id: s.id });
  res.json({ ok: true });
});

/* ------------------------- harness controls ----------------------------- */

router.post('/api/dev/clock', requireBearer, (req, res) => {
  const { advance_ms, reset: doReset } = req.body || {};
  if (doReset) clock.setOffset(0);
  else clock.advance(Number(advance_ms) || 0);
  db().clock_offset_ms = clock.getOffset();
  sweep();
  logEvent('clock.changed', `Virtual clock offset now ${Math.round(clock.getOffset() / 60000)} min`, null);
  save();
  res.json({ ok: true, now: clock.now(), clock_offset_ms: clock.getOffset() });
});

router.post('/api/dev/reset', requireBearer, (req, res) => {
  reset();
  clock.setOffset(0);
  res.json({ ok: true });
});

module.exports = router;
