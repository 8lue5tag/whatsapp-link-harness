'use strict';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// The ceiling column is the absolute expiry from the design: set once at issue,
// never extended. `renewable: false` means the token dies on first redemption
// (no second landing, no matter how much ceiling is left).
const INTENTS = {
  // Campaign token: opens the seller's own portal, never expires, and is scoped
  // to that seller rather than to a single listing. Deterministically derived
  // (see campaign.js) so the URL survives every restart and can be pasted into
  // a Gupshup campaign safely.
  seller_portal: {
    key: 'seller_portal',
    label: 'Your Rapidue portal',
    resource: 'seller',
    ceilingKind: 'none',
    ceilingMs: null,
    renewable: true,
    stepUp: false,
    sessionIdleMs: 30 * MIN,
    rationale: 'Campaign link. Never expires; sees only this seller’s own data.'
  },
  listing_draft: {
    key: 'listing_draft',
    label: 'Resume a listing draft',
    resource: 'listing',
    ceilingKind: 'fixed',
    ceilingMs: 7 * DAY,
    renewable: true,
    stepUp: false,
    sessionIdleMs: 15 * MIN,
    rationale: 'Low stakes, sellers are slow, forgiving is correct.'
  },
  pickup_slot: {
    key: 'pickup_slot',
    label: 'Confirm a pickup slot',
    resource: 'listing',
    ceilingKind: 'slot', // derived from the slot time itself
    ceilingMs: null,
    renewable: true,
    stepUp: false,
    sessionIdleMs: 15 * MIN,
    rationale: 'Naturally self-expiring - ceiling is the slot time.'
  },
  bid_response: {
    key: 'bid_response',
    label: 'Accept or reject a bid',
    resource: 'bid',
    ceilingKind: 'fixed',
    ceilingMs: 3 * HOUR,
    renewable: true,
    stepUp: false,
    sessionIdleMs: 15 * MIN,
    rationale: 'Commercially binding, prices move.'
  },
  kyc: {
    key: 'kyc',
    label: 'KYC / bank details',
    resource: 'kyc',
    ceilingKind: 'fixed',
    ceilingMs: 15 * MIN,
    renewable: false,
    stepUp: true,
    sessionIdleMs: 15 * MIN,
    rationale: 'Non-negotiable: 15 min, no renewal, OTP on the page.'
  }
};

// Tripwire, not a turnstile: hitting this raises a fraud flag, it does not block.
const USE_ALERT_THRESHOLD = 10;

// Hard cap on a scoped session regardless of how much the idle window slides.
const SESSION_ABSOLUTE_MS = 8 * HOUR;

// A verified OTP is only "fresh" for this long.
const OTP_FRESH_MS = 5 * MIN;

module.exports = { INTENTS, USE_ALERT_THRESHOLD, SESSION_ABSOLUTE_MS, OTP_FRESH_MS, MIN, HOUR, DAY };
