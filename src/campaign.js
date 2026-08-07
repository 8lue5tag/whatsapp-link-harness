'use strict';

const crypto = require('crypto');
const { db, save } = require('./db');
const { now } = require('./clock');
const { INTENTS } = require('./intents');
const { hashToken, logEvent } = require('./tokens');

// Campaign tokens are DERIVED, not random. The same secret plus the same seller
// id always produces the same token, so the URL you paste into a Gupshup
// campaign keeps working across restarts, redeploys and a wiped database - which
// matters because Render's free disk is erased on every restart.
//
// Changing CAMPAIGN_SECRET changes all three URLs. Don't, once a campaign is out.
const DEFAULT_SECRET = 'rapidue-harness-campaign-v1';
const VERSION = 'v1';

function campaignSecretFor(sellerId) {
  const key = process.env.CAMPAIGN_SECRET || DEFAULT_SECRET;
  return crypto
    .createHmac('sha256', key)
    .update(`campaign:${VERSION}:${sellerId}`)
    .digest()
    .subarray(0, 16)
    .toString('base64url'); // 22 chars, same shape as a random token
}

/**
 * Make sure every seller has their permanent portal token. Idempotent: run it on
 * every boot. If the row was lost (disk wipe) it comes back identical; if it was
 * deliberately revoked, that stays revoked until someone reissues.
 */
function ensureCampaignTokens() {
  const d = db();
  const intent = INTENTS.seller_portal;
  const out = [];

  for (const seller of d.users.filter((u) => u.role === 'seller')) {
    const secret = campaignSecretFor(seller.id);
    const token_hash = hashToken(secret);
    let row = d.tokens.find((t) => t.token_hash === token_hash);

    if (!row) {
      row = {
        id: 'tc_' + seller.id,
        token_hash,
        hint: secret.slice(0, 4) + '...' + secret.slice(-3),
        seller_id: seller.id,
        wa_id: seller.wa_id,
        intent: intent.key,
        resource_id: seller.id,
        issued_at: now(),
        expires_at: null, // never expires
        use_count: 0,
        last_used_at: null,
        fraud_alert: false,
        status: 'active',
        issued_by: 'campaign',
        campaign: true
      };
      d.tokens.push(row);
      logEvent('campaign.token', `Permanent portal token ready for ${seller.name}`, { token_id: row.id });
    }
    out.push({ seller, secret, row });
  }

  save();
  return out;
}

/** The three pasteable URLs. Secrets are recomputed, never read from storage. */
function campaignLinks(baseUrl, sellerIds) {
  return ensureCampaignTokens()
    .filter(({ seller }) => !sellerIds || sellerIds.includes(seller.id))
    .map(({ seller, secret, row }) => ({
      seller_id: seller.id,
      name: seller.name,
      email: seller.email,
      wa_id: seller.wa_id,
      city: seller.city,
      token: secret,
      url: `${baseUrl}/s/${secret}`,
      status: row.status,
      use_count: row.use_count,
      last_used_at: row.last_used_at
    }));
}

module.exports = { ensureCampaignTokens, campaignLinks, campaignSecretFor };
