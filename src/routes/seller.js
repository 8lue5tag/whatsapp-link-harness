'use strict';

const express = require('express');
const crypto = require('crypto');
const { db, save } = require('../db');
const { now } = require('../clock');
const { INTENTS, OTP_FRESH_MS } = require('../intents');
const { requireSession, requireFreshOtp, sessionState, SESSION_COOKIE } = require('../auth');
const { revokeForResource, logEvent, resourceFor } = require('../tokens');

const router = express.Router();
router.use(express.json());

function lookup(kind, id) {
  const d = db();
  if (kind === 'listing') return d.listings.find((l) => l.id === id);
  if (kind === 'bid') return d.bids.find((b) => b.id === id);
  if (kind === 'kyc') return d.kyc.find((k) => k.id === id);
  return null;
}

/**
 * One guard for both kinds of link.
 *
 *  - A campaign token (seller_portal) may touch anything the seller owns, and
 *    nothing they don't.
 *  - A task token stays pinned to the single resource it was minted for, which
 *    is the narrower and stricter case.
 *
 * Ownership is checked first either way, so no session can ever reach another
 * seller's data.
 */
function requireAccess(intentKey, kind) {
  return function (req, res, next) {
    const id = req.params.id;
    const resource = lookup(kind, id);
    if (!resource) return res.status(404).json({ error: 'unknown_resource' });

    if (resource.seller_id !== req.session.seller_id) {
      return res.status(403).json({ error: 'not_your_resource' });
    }

    if (req.session.intent === 'seller_portal') return next();

    if (req.session.intent !== intentKey) {
      return res.status(403).json({ error: 'wrong_intent', have: req.session.intent, need: intentKey });
    }
    if (req.session.resource_id !== id) {
      return res.status(403).json({ error: 'wrong_resource', have: req.session.resource_id, need: id });
    }
    next();
  };
}

/** Status for the landing pages. A GET, so it deliberately does NOT slide the window. */
router.get('/api/session', (req, res) => {
  const session = db().sessions.find((s) => s.id === req.cookies[SESSION_COOKIE]);
  const { state } = sessionState(session);
  if (state !== 'active') return res.status(401).json({ state });

  const d = db();
  const intent = INTENTS[session.intent];
  const seller = d.users.find((u) => u.id === session.seller_id);
  const portal = session.intent === 'seller_portal';

  res.json({
    state,
    seller: { id: seller.id, name: seller.name, wa_id: seller.wa_id, city: seller.city },
    intent: intent.key,
    intent_label: intent.label,
    step_up_required: intent.stepUp,
    resource_id: session.resource_id,
    // A task link gets exactly its one resource. A portal link gets the
    // seller's own everything - and still nothing belonging to anyone else.
    resource: portal ? null : resourceFor(intent, session.resource_id),
    own: portal
      ? {
          listings: d.listings.filter((l) => l.seller_id === seller.id),
          bids: d.bids.filter((b) => b.seller_id === seller.id),
          kyc: d.kyc.find((k) => k.seller_id === seller.id) || null
        }
      : null,
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
  requireAccess('listing_draft', 'listing'),
  (req, res) => {
    const listing = lookup('listing', req.params.id);
    listing.draft_notes = String((req.body && req.body.notes) || '');
    save();
    logEvent('listing.draft_saved', `Draft saved on ${listing.id}`, {
      resource_id: listing.id,
      seller_id: listing.seller_id
    });
    res.json({ ok: true, listing, idle_ms_left: req.session.idle_ms });
  }
);

router.post(
  '/api/seller/listings/:id/publish',
  requireSession,
  requireAccess('listing_draft', 'listing'),
  (req, res) => {
    const listing = lookup('listing', req.params.id);
    listing.status = 'published';
    save();
    // Revoke on state change: the task is done. Campaign tokens are scoped to the
    // seller rather than the listing, so they deliberately survive this.
    const n = revokeForResource(listing.id, 'listing_published');
    res.json({ ok: true, listing, tokens_revoked: n });
  }
);

/* ---------------------------- pickup_slot ------------------------------ */

router.post('/api/seller/listings/:id/pickup', requireSession, requireAccess('pickup_slot', 'listing'), (req, res) => {
  const listing = lookup('listing', req.params.id);
  listing.pickup_confirmed = true;
  save();
  const n = revokeForResource(listing.id, 'pickup_confirmed');
  res.json({ ok: true, listing, tokens_revoked: n });
});

/* ---------------------------- bid_response ----------------------------- */

router.post('/api/seller/bids/:id/:decision', requireSession, requireAccess('bid_response', 'bid'), (req, res) => {
  const decision = req.params.decision;
  if (!['accept', 'reject'].includes(decision)) return res.status(400).json({ error: 'bad_decision' });
  const bid = lookup('bid', req.params.id);
  if (bid.status !== 'open') return res.status(409).json({ error: 'bid_already_' + bid.status });
  bid.status = decision === 'accept' ? 'accepted' : 'rejected';
  bid.settled_at = now();
  save();
  const n = revokeForResource(bid.id, 'bid_settled');
  res.json({ ok: true, bid, tokens_revoked: n });
});

/* -------------------------------- kyc ---------------------------------- */
/* Sensitive, so the link alone is never enough - fresh OTP every time.     */

router.post('/api/seller/kyc/:id/otp', requireSession, requireAccess('kyc', 'kyc'), (req, res) => {
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
  logEvent('otp.sent', `OTP sent to +${req.seller.wa_id} for ${req.params.id}`, {
    session_id: req.session.id,
    seller_id: req.seller.id
  });
  // Harness only: the console shows the code so you can test without a real SMS.
  res.json({ ok: true, dev_code: code });
});

router.post('/api/seller/kyc/:id/verify', requireSession, requireAccess('kyc', 'kyc'), (req, res) => {
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
  requireAccess('kyc', 'kyc'),
  requireFreshOtp,
  (req, res) => {
    const rec = lookup('kyc', req.params.id);
    rec.status = 'submitted';
    rec.account_last4 = String((req.body && req.body.account_last4) || '0000').slice(-4);
    save();
    logEvent('kyc.submitted', `KYC submitted for ${rec.seller_id}`, {
      resource_id: rec.id,
      seller_id: rec.seller_id
    });
    const n = revokeForResource(rec.id, 'kyc_submitted');
    res.json({ ok: true, kyc: rec, tokens_revoked: n });
  }
);

module.exports = router;
