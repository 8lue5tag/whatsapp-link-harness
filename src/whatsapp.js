'use strict';

const crypto = require('crypto');
const { db, save } = require('./db');
const { now } = require('./clock');
const { logEvent } = require('./tokens');
const providers = require('./providers');

// Meta constraint: in an approved template the variable can only sit at the END
// of the URL. So the route ends in {{1}} and nothing follows it - no path
// segments after the token, no fragment.
//
// Each template freezes its own base at approval, so the base is per intent and
// must match what Meta approved, character for character:
//   omp_test_token_buyer1     -> .../s/{{1}}
//   omp_test_buyer_check_lots -> .../lots/{{1}}
const TEMPLATE_URL = '/s/{{1}}';
const TEMPLATE_URLS = { lot_select: '/lots/{{1}}' };

const TEMPLATES = {
  seller_portal: {
    name: 'seller_portal_v1',
    button: 'Open my portal',
    body: (r) => `Hi ${r.name}, open your Rapidue portal to manage your material.`
  },
  lot_select: {
    name: 'omp_test_buyer_check_lots',
    button: 'Check Lots',
    body: (r) => `Hi ${r.name}, there are lots pending your confirmation.`
  },
  listing_draft: {
    name: 'listing_draft_resume_v1',
    button: 'Resume listing',
    body: (r) => `Your listing "${r.title}" is still a draft. Tap below to finish it.`
  },
  pickup_slot: {
    name: 'pickup_slot_confirm_v1',
    button: 'Confirm pickup',
    body: (r) => `Please confirm the pickup slot for "${r.title}".`
  },
  bid_response: {
    name: 'bid_response_v1',
    button: 'View bid',
    body: (r) => `${r.buyer} bid Rs ${r.amount.toLocaleString('en-IN')} on your material. Accept or reject below.`
  },
  kyc: {
    name: 'kyc_complete_v1',
    button: 'Complete KYC',
    body: () => 'Complete your KYC to receive payouts. This link is valid for 15 minutes.'
  }
};

/**
 * Record the message, then deliver it through whichever provider the caller
 * chose. Provider, mode and template come per send - not from config - so you
 * can fire the same link at Gupshup, WATI and MSG91 and compare what comes back.
 *
 *  mode 'text'     - free-form. Legal only inside the 24h customer-care window
 *                    (the customer messaged you last). Any URL, no approval.
 *  mode 'template' - approved template. buttonSuffix carries the token into the
 *                    dynamic URL button; each provider expresses that its own way.
 *
 * The raw request and response are always stored: providers routinely accept a
 * message and then never deliver it, and that payload is the only evidence.
 */
/**
 * Template parameters are written once in the console and resolved per send.
 * Providers disagree about naming: WATI wants the template's own variable names,
 * MSG91 ignores names and uses order. So we carry both, and each adapter takes
 * what it needs. Flag the URL button's parameter with button:true.
 */
function resolveParams(list, vars) {
  return (list || [])
    .filter((p) => p && p.name)
    .map((p) => ({
      name: String(p.name),
      button: !!p.button,
      value: String(p.value == null ? '' : p.value).replace(
        /\{\{(\w+)\}\}/g,
        (m, k) => (vars[k] == null ? m : String(vars[k]))
      )
    }));
}

async function sendTemplate({ seller, intent, resource, secret, baseUrl, note, send }) {
  const d = db();
  const tpl = TEMPLATES[intent.key];
  const url = `${baseUrl}${(TEMPLATE_URLS[intent.key] || TEMPLATE_URL).replace('{{1}}', secret)}`;
  const opts = send || {};
  const providerKey = opts.provider || process.env.SEND_PROVIDER || 'simulate';
  const mode = opts.mode || process.env.SEND_MODE || 'text';
  const templateId = opts.template || process.env['TEMPLATE_' + intent.key.toUpperCase()] || '';
  const bodyText = tpl.body(resource);

  // A campaign token is scoped to the seller, not a listing, so material and
  // rate come from that seller's own first listing / open bid.
  const d0 = db();
  const firstListing = d0.listings.find((l) => l.seller_id === seller.id);
  const firstBid = d0.bids.find((b) => b.seller_id === seller.id && b.status === 'open');

  // Placeholders usable in any parameter value.
  const params = resolveParams(opts.params, {
    token: secret,
    url: url,
    name: seller.name,
    first_name: String(seller.name || '').split(' ')[0],
    wa_id: seller.wa_id || '',
    city: seller.city || '',
    title: resource.title || resource.id || '',
    amount: resource.amount == null ? '' : String(resource.amount),
    buyer: resource.buyer || '',
    // Material name without the tonnage/location prefix, e.g. "PET bottles".
    material: (() => {
      const t = (resource.title || (firstListing && firstListing.title) || 'scrap').split(' - ')[0];
      return t.replace(/^[\d.]+\s*MT\s*/i, '').trim() || 'scrap';
    })(),
    // Per-kg rate, because the approved template says "per kg". Bid amounts are
    // lot totals and would read as nonsense there.
    rate: String(
      resource.rate_per_kg != null
        ? resource.rate_per_kg
        : firstListing && firstListing.rate_per_kg != null
          ? firstListing.rate_per_kg
          : firstBid
            ? firstBid.amount
            : ''
    ),
    // For omp_test_buyer_check_lots: "{{num}} lots totaling {{qty}} MT for
    // {{mat}}". Counts only what this buyer has not decided on yet, so the
    // message and the deck they open agree with each other.
    ...(() => {
      const { allLots, decisionsFor } = require('./lots');
      const pending = allLots().filter((l) => !decisionsFor(seller.id)[l.id]);
      const byMaterial = {};
      for (const l of pending) byMaterial[l.material] = (byMaterial[l.material] || 0) + 1;
      const top = Object.entries(byMaterial).sort((a, b) => b[1] - a[1])[0];
      return {
        lot_count: String(pending.length),
        lot_mt: String(Math.round(pending.reduce((s, l) => s + Number(l.quantity_mt), 0) * 10) / 10),
        lot_material: top ? top[0] : 'scrap'
      };
    })()
  });

  const msg = {
    id: 'm_' + crypto.randomBytes(6).toString('hex'),
    at: now(),
    wa_id: seller.wa_id,
    seller_id: seller.id,
    template: mode === 'template' ? templateId || '(none given)' : tpl.name,
    body: bodyText,
    button_label: tpl.button,
    url,
    intent: intent.key,
    resource_id: resource.id,
    note: note || null,
    provider: providerKey,
    send_mode: mode,
    // Recorded even when simulating, so you can check the resolution before
    // spending a real send on it.
    params_sent: mode === 'template' ? params : null,
    channel: providerKey, // kept for older console builds
    provider_ok: null,
    provider_status: null,
    provider_response: null,
    provider_request: null
  };

  if (providerKey === 'simulate') {
    msg.provider_ok = true;
    logEvent('whatsapp.sent', `Simulated ${tpl.name} to +${seller.wa_id}`, {
      message_id: msg.id,
      seller_id: seller.id
    });
  } else if (!seller.wa_id) {
    msg.provider_ok = false;
    msg.provider_response = 'seller has no phone number - set one in the console';
    logEvent('whatsapp.error', `Send skipped - ${seller.name} has no phone number`, {
      message_id: msg.id,
      seller_id: seller.id
    });
  } else {
    const out = await providers.send({
      providerKey,
      mode,
      env: process.env,
      destination: seller.wa_id,
      // Free-form carries the whole link in the text. A template carries only
      // the token, because its URL base is frozen at approval.
      text: `${bodyText}\n\n${url}`,
      templateId,
      params,
      renderedText: `${bodyText}\n\n${url}`
    });

    msg.provider_ok = out.ok;
    msg.provider_status = out.status;
    msg.provider_response = out.response;
    msg.provider_request = out.request;
    logEvent(
      out.ok ? 'whatsapp.sent' : 'whatsapp.error',
      `${providerKey}/${mode} -> +${seller.wa_id}: HTTP ${out.status} ${String(out.detail || out.response).slice(0, 160)}`,
      { message_id: msg.id, seller_id: seller.id }
    );
  }

  d.messages.unshift(msg);
  d.messages = d.messages.slice(0, 60);
  save();
  return msg;
}

/** What the console shows in its header and send panel. */
function sendMode() {
  return {
    providers: providers.status(process.env),
    default_provider: process.env.SEND_PROVIDER || 'simulate',
    default_mode: process.env.SEND_MODE || 'text'
  };
}

module.exports = { sendTemplate, sendMode, TEMPLATES, TEMPLATE_URL };
