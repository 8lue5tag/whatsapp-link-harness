'use strict';

const express = require('express');
const crypto = require('crypto');
const { db, save } = require('../db');
const { now } = require('../clock');
const { INTENTS, OTP_FRESH_MS } = require('../intents');
const { requireSession, requireScope, requireFreshOtp, sessionState, SESSION_COOKIE } = require('../auth');
const { revokeForResource, logEvent, resourceFor } = require('../tokens');

const router = express.Router();
router.use(express.json());

const byParam = (name) => (req) => req.params[name];

/** Status for the landing page. A GET, so it deliberately does NOT slide the window. */
router.get('/api/session', (req, res) => {
  const session = db().sessions.find((s) => s.id === req.cookies[SESSION_COOKIE]);
  const { state } = sessionState(session);
  if (state !== 'active') return res.status(401).json({ state });

  const intent = INTENTS[session.intent];
  const seller = db().users.find((u) => u.id === session.seller_id);
  const resource = resourceFor(intent, session.resource_id);

  res.json({
    state,
    seller: { id: seller.id, name: seller.name, wa_id: seller.wa_id },
    intent: intent.key,
    intent_label: intent.label,
    step_up_required: intent.stepUp,
    resource_id: session.resource_id,
    resource,
    idle_ms_left: session.idle_ms - (now() - session.last_seen_at),
    idle_window_ms: session.idle_ms,
    absolute_ms_left: session.absolute_expires_at - now(),
    otp_fresh: !!session.otp_verified_at && now() - session.otp_verified_at <= OTP_FRESH_MS
  });
});

/* ---------------------------- listing_draft ---------------------------- */

router.post(
  '/api/seller/listings/:id/draft',
  requireSession,
  requireScope('listing_draft', byParam('id')),
  (req, res) => {
    const listing = db().listings.find((l) => l.id === req.params.id);
    listing.draft_notes = String((req.body && req.body.notes) || '');
    save();
    logEvent('listing.draft_saved', `Draft saved on ${listing.id}`, { resource_id: listing.id });
    res.json({ ok: true, listing, idle_ms_left: req.session.idle_ms });
  }
);

router.post(
  '/api/seller/listings/:id/publish',
  requireSession,
  requireScope('listing_draft', byParam('id')),
  (req, res) => {
    const listing = db().listings.find((l) => l.id === req.params.id);
    listing.status = 'published';
    save();
    // Revoke on state change: the task is done.
    const n = revokeForResource(listing.id, 'listing_published');
    res.json({ ok: true, listing, tokens_revoked: n });
  }
);

/* ---------------------------- pickup_slot ------------------------------ */

router.post(
  '/api/seller/listings/:id/pickup',
  requireSession,
  requireScope('pickup_slot', byParam('id')),
  (req, res) => {
    const listing = db().listings.find((l) => l.id === req.params.id);
    listing.pickup_confirmed = true;
    save();
    const n = revokeForResource(listing.id, 'pickup_confirmed');
    res.json({ ok: true, listing, tokens_revoked: n });
  }
);

/* ---------------------------- bid_response ----------------------------- */

router.post(
  '/api/seller/bids/:id/:decision',
  requireSession,
  requireScope('bid_response', byParam('id')),
  (req, res) => {
    const decision = req.params.decision;
    if (!['accept', 'reject'].includes(decision)) return res.status(400).json({ error: 'bad_decision' });
    const bid = db().bids.find((b) => b.id === req.params.id);
    if (bid.status !== 'open') return res.status(409).json({ error: 'bid_already_' + bid.status });
    bid.status = decision === 'accept' ? 'accepted' : 'rejected';
    bid.settled_at = now();
    save();
    const n = revokeForResource(bid.id, 'bid_settled');
    res.json({ ok: true, bid, tokens_revoked: n });
  }
);

/* -------------------------------- kyc ---------------------------------- */
/* Sensitive, so the link alone is never enough - fresh OTP every time.     */

router.post('/api/seller/kyc/:id/otp', requireSession, requireScope('kyc', byParam('id')), (req, res) => {
  const d = db();
  const code = String(crypto.randomInt(100000, 999999));
  d.otps.unshift({
    id: 'otp_' + crypto.randomBytes(4).toString('hex'),
    session_id: req.session.id,
    code,
    created_at: now(),
    used: false
  });
  d.otps = d.otps.slice(0, 40);
  save();
  logEvent('otp.sent', `OTP sent to +${req.seller.wa_id} for ${req.params.id}`, { session_id: req.session.id });
  // Harness only: the console shows the code so you can test without a real SMS.
  res.json({ ok: true, dev_code: code });
});

router.post('/api/seller/kyc/:id/verify', requireSession, requireScope('kyc', byParam('id')), (req, res) => {
  const d = db();
  const code = String((req.body && req.body.code) || '');
  const otp = d.otps.find((o) => o.session_id === req.session.id && o.code === code && !o.used);
  if (!otp) return res.status(401).json({ error: 'bad_otp' });
  if (now() - otp.created_at > 10 * 60 * 1000) return res.status(401).json({ error: 'otp_expired' });
  otp.used = true;
  req.session.otp_verified_at = now();
  save();
  res.json({ ok: true, fresh_for_ms: OTP_FRESH_MS });
});

router.post(
  '/api/seller/kyc/:id/submit',
  requireSession,
  requireScope('kyc', byParam('id')),
  requireFreshOtp,
  (req, res) => {
    const rec = db().kyc.find((k) => k.id === req.params.id);
    rec.status = 'submitted';
    rec.account_last4 = String((req.body && req.body.account_last4) || '0000').slice(-4);
    save();
    logEvent('kyc.submitted', `KYC submitted for ${rec.seller_id}`, { resource_id: rec.id });
    const n = revokeForResource(rec.id, 'kyc_submitted');
    res.json({ ok: true, kyc: rec, tokens_revoked: n });
  }
);

module.exports = router;
