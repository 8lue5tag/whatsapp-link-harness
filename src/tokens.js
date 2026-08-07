'use strict';

const crypto = require('crypto');
const { db, save } = require('./db');
const { now } = require('./clock');
const { INTENTS, USE_ALERT_THRESHOLD } = require('./intents');

function logEvent(type, message, meta) {
  const d = db();
  d.events.unshift({
    id: 'e_' + crypto.randomBytes(6).toString('hex'),
    at: now(),
    type,
    message,
    meta: meta || null
  });
  d.events = d.events.slice(0, 200);
}

// 128 bits from a cryptographic source, base64url -> 22 chars. Never a counter,
// never a timestamp.
function mintSecret() {
  return crypto.randomBytes(16).toString('base64url');
}

function hashToken(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function resourceFor(intent, resourceId) {
  const d = db();
  if (intent.resource === 'listing') return d.listings.find((l) => l.id === resourceId);
  if (intent.resource === 'bid') return d.bids.find((b) => b.id === resourceId);
  if (intent.resource === 'kyc') return d.kyc.find((k) => k.id === resourceId);
  if (intent.resource === 'seller') return d.users.find((u) => u.id === resourceId && u.role === 'seller');
  return null;
}

/** Who owns this resource. For a seller-scoped token, the resource *is* the seller. */
function ownerOf(intent, resource) {
  return intent.resource === 'seller' ? resource.id : resource.seller_id;
}

/** null means no ceiling at all - a campaign link that never expires. */
function ceilingFor(intent, resource) {
  if (intent.ceilingKind === 'none') return null;
  if (intent.ceilingKind === 'slot') return resource.pickup_at;
  return now() + intent.ceilingMs;
}

function isExpired(row) {
  return row.expires_at != null && now() >= row.expires_at;
}

/**
 * Issue a link token. Two things happen before any message goes out:
 * the secret is generated, and only its SHA-256 is stored.
 * Issuing also supersedes any live token for the same (seller, intent, resource)
 * - the kill switch, so three "resend link" taps don't leave three live tokens.
 */
function issueToken({ intentKey, resourceId, actor }) {
  const d = db();
  const intent = INTENTS[intentKey];
  if (!intent) return { error: 'unknown_intent' };

  const resource = resourceFor(intent, resourceId);
  if (!resource) return { error: 'unknown_resource' };

  const seller = d.users.find((u) => u.id === ownerOf(intent, resource));
  if (!seller) return { error: 'unknown_seller' };

  const expiresAt = ceilingFor(intent, resource);
  if (expiresAt != null && expiresAt <= now()) {
    return { error: 'ceiling_already_passed' };
  }

  let superseded = 0;
  for (const row of d.tokens) {
    if (
      row.status === 'active' &&
      row.seller_id === seller.id &&
      row.intent === intent.key &&
      row.resource_id === resourceId &&
      // Campaign tokens are permanent and already out in the wild. Reissuing must
      // never supersede them, or links already sent would go dead.
      !row.campaign
    ) {
      row.status = 'superseded';
      row.superseded_at = now();
      superseded += 1;
    }
  }

  const secret = mintSecret();
  const row = {
    id: 't_' + crypto.randomBytes(5).toString('hex'),
    token_hash: hashToken(secret),
    hint: secret.slice(0, 4) + '...' + secret.slice(-3),
    seller_id: seller.id,
    wa_id: seller.wa_id,
    intent: intent.key,
    resource_id: resourceId,
    issued_at: now(),
    // Absolute ceiling - written once, never touched again. null = never expires.
    expires_at: expiresAt,
    use_count: 0,
    last_used_at: null,
    fraud_alert: false,
    status: 'active',
    issued_by: actor || 'system'
  };
  d.tokens.unshift(row);

  logEvent('token.issued', `Issued ${intent.label} token for ${resourceId} to ${seller.name}`, {
    token_id: row.id,
    superseded
  });
  if (superseded > 0) {
    logEvent('token.superseded', `Kill switch: ${superseded} earlier token(s) for ${resourceId} invalidated`, {
      token_id: row.id
    });
  }

  save();
  return { row, secret, intent, resource, seller };
}

/**
 * Redeem. Hash the incoming value, look it up, check status and the ceiling.
 * The ceiling is never extended here - that is the whole point.
 */
function redeemToken(secret) {
  const d = db();
  const row = d.tokens.find((t) => t.token_hash === hashToken(secret));
  if (!row) return { ok: false, reason: 'not_found' };

  if (row.status === 'revoked') return { ok: false, reason: 'revoked', row };
  if (row.status === 'superseded') return { ok: false, reason: 'superseded', row };
  if (row.status === 'redeemed') return { ok: false, reason: 'already_redeemed', row };
  if (isExpired(row)) {
    row.status = 'expired';
    save();
    return { ok: false, reason: 'expired', row };
  }

  const intent = INTENTS[row.intent];
  row.use_count += 1;
  row.last_used_at = now();

  if (row.use_count > USE_ALERT_THRESHOLD && !row.fraud_alert) {
    row.fraud_alert = true;
    logEvent('token.fraud_alert', `Token ${row.id} passed ${USE_ALERT_THRESHOLD} uses - flagged, not blocked`, {
      token_id: row.id
    });
  }

  // Non-renewable intents (KYC) die on first landing.
  if (!intent.renewable) {
    row.status = 'redeemed';
    row.redeemed_at = now();
  }

  logEvent('token.redeemed', `Token ${row.id} redeemed (use #${row.use_count})`, { token_id: row.id });
  save();
  return { ok: true, row, intent };
}

function revokeToken(tokenId, reason) {
  const d = db();
  const row = d.tokens.find((t) => t.id === tokenId);
  if (!row) return { error: 'not_found' };
  row.status = 'revoked';
  row.revoked_at = now();
  row.revoke_reason = reason || 'manual';
  logEvent('token.revoked', `Token ${row.id} revoked (${row.revoke_reason})`, { token_id: row.id });
  save();
  return { row };
}

/** Revoke on state change: the task is done, the link has no reason to work. */
function revokeForResource(resourceId, reason) {
  const d = db();
  let n = 0;
  for (const row of d.tokens) {
    if (row.resource_id === resourceId && row.status === 'active') {
      row.status = 'revoked';
      row.revoked_at = now();
      row.revoke_reason = reason || 'state_change';
      n += 1;
    }
  }
  if (n > 0) {
    logEvent('token.revoked', `${n} token(s) for ${resourceId} revoked: ${reason}`, { resource_id: resourceId });
    save();
  }
  return n;
}

/** Lazily mark ceilings that have passed, so the ledger reads honestly. */
function sweep() {
  const d = db();
  let changed = false;
  for (const row of d.tokens) {
    if (row.status === 'active' && isExpired(row)) {
      row.status = 'expired';
      changed = true;
    }
  }
  if (changed) save();
}

module.exports = {
  issueToken,
  redeemToken,
  revokeToken,
  revokeForResource,
  hashToken,
  sweep,
  logEvent,
  resourceFor,
  ownerOf,
  isExpired
};
