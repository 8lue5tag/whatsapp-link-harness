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

// The campaign intents, in the order the console lists them. seller_portal keeps
// its original derivation input so every URL already out in the wild stays valid.
const CAMPAIGN_INTENTS = ['seller_portal', 'lot_select'];

function campaignSecretFor(sellerId, intentKey) {
  const key = process.env.CAMPAIGN_SECRET || DEFAULT_SECRET;
  const scope = !intentKey || intentKey === 'seller_portal' ? sellerId : `${intentKey}:${sellerId}`;
  return crypto
    .createHmac('sha256', key)
    .update(`campaign:${VERSION}:${scope}`)
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
  const out = [];

  for (const seller of d.users.filter((u) => u.role === 'seller')) {
    for (const intentKey of CAMPAIGN_INTENTS) {
      const intent = INTENTS[intentKey];
      const secret = campaignSecretFor(seller.id, intentKey);
      const token_hash = hashToken(secret);
      let row = d.tokens.find((t) => t.token_hash === token_hash);

      if (!row) {
        row = {
          id: (intentKey === 'seller_portal' ? 'tc_' : 'tc_lots_') + seller.id,
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
        logEvent('campaign.token', `Permanent ${intent.label} token ready for ${seller.name}`, { token_id: row.id });
      }
      out.push({ seller, secret, row, intentKey });
    }
  }

  save();
  return out;
}

/**
 * The pasteable URLs, one row per seller. Both campaign links live on the same
 * `/s/{{1}}` base - the frozen Meta template only varies the last path segment,
 * so which page opens is decided by the token, not by a query string.
 * Secrets are recomputed, never read from storage.
 */
function campaignLinks(baseUrl, sellerIds) {
  const all = ensureCampaignTokens().filter(({ seller }) => !sellerIds || sellerIds.includes(seller.id));
  const bySeller = new Map();

  for (const { seller, secret, row, intentKey } of all) {
    if (!bySeller.has(seller.id)) {
      bySeller.set(seller.id, {
        seller_id: seller.id,
        name: seller.name,
        email: seller.email,
        wa_id: seller.wa_id,
        city: seller.city
      });
    }
    const entry = bySeller.get(seller.id);
    if (intentKey === 'seller_portal') {
      Object.assign(entry, {
        token: secret,
        url: `${baseUrl}/s/${secret}`,
        status: row.status,
        use_count: row.use_count,
        last_used_at: row.last_used_at
      });
    } else {
      Object.assign(entry, {
        lots_token: secret,
        lots_url: `${baseUrl}/s/${secret}`,
        lots_status: row.status,
        lots_use_count: row.use_count
      });
    }
  }

  return [...bySeller.values()];
}

module.exports = { ensureCampaignTokens, campaignLinks, campaignSecretFor, CAMPAIGN_INTENTS };
