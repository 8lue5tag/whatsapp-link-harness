'use strict';

const crypto = require('crypto');
const { db, save } = require('./db');
const { now } = require('./clock');
const { logEvent } = require('./tokens');
const gupshup = require('./gupshup');

// Meta constraint: in an approved template the variable can only sit at the END
// of the URL. So the route is /s/{{1}} and nothing follows it - no path segments
// after the token, no fragment.
const TEMPLATE_URL = '/s/{{1}}';

const TEMPLATES = {
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
 * Record the message, then deliver it according to GUPSHUP_MODE:
 *   simulate            - console only, no network call
 *   enterprise_text     - msg_type=TEXT, free-form, needs the 24h window
 *   enterprise_template - msg_type=HSM, needs an approved template
 *   selfserve_text | selfserve_template - api.gupshup.io, for a later migration
 * The raw request and response are stored either way. Enterprise answers HTTP
 * 200 with status:error in the body, so the payload is the only real evidence.
 */
async function sendTemplate({ seller, intent, resource, secret, baseUrl, note }) {
  const d = db();
  const tpl = TEMPLATES[intent.key];
  const url = `${baseUrl}${TEMPLATE_URL.replace('{{1}}', secret)}`;

  const msg = {
    id: 'm_' + crypto.randomBytes(6).toString('hex'),
    at: now(),
    wa_id: seller.wa_id,
    seller_id: seller.id,
    template: tpl.name,
    body: tpl.body(resource),
    button_label: tpl.button,
    url,
    intent: intent.key,
    resource_id: resource.id,
    note: note || null,
    channel: 'simulate',
    provider_ok: null,
    provider_status: null,
    provider_response: null
  };

  const cfg = gupshup.config(process.env);
  msg.channel = cfg.mode;

  if (cfg.mode !== 'simulate') {
    const missing = gupshup.missingConfig(cfg);
    if (missing.length) {
      msg.provider_ok = false;
      msg.provider_response = 'missing config: ' + missing.join(', ');
      logEvent('whatsapp.error', `Send skipped - missing ${missing.join(', ')}`, { message_id: msg.id });
    } else if (!seller.wa_id) {
      msg.provider_ok = false;
      msg.provider_response = 'seller has no wa_id - set a real phone number in the console';
      logEvent('whatsapp.error', `Send skipped - ${seller.name} has no phone number`, { message_id: msg.id });
    } else {
      const text = `${tpl.body(resource)}\n\n${url}`;
      const out = cfg.mode.endsWith('_template')
        ? await gupshup.sendTemplate({
            cfg,
            destination: seller.wa_id,
            templateId: process.env['GUPSHUP_TEMPLATE_' + intent.key.toUpperCase()] || '',
            params: [secret],
            renderedText: text
          })
        : await gupshup.sendText({ cfg, destination: seller.wa_id, text });

      msg.provider_ok = out.ok;
      msg.provider_status = out.status;
      msg.provider_response = out.response;
      msg.provider_request = out.request;
      logEvent(
        out.ok ? 'whatsapp.sent' : 'whatsapp.error',
        `Gupshup ${cfg.mode} -> +${seller.wa_id}: HTTP ${out.status} ${String(out.detail || out.response).slice(0, 160)}`,
        { message_id: msg.id }
      );
    }
  } else {
    logEvent('whatsapp.sent', `Simulated ${tpl.name} to +${seller.wa_id}`, { message_id: msg.id });
  }

  d.messages.unshift(msg);
  d.messages = d.messages.slice(0, 60);
  save();
  return msg;
}

function sendMode() {
  const cfg = gupshup.config(process.env);
  return { mode: cfg.mode, missing: gupshup.missingConfig(cfg), source: cfg.source, app_name: cfg.appName };
}

module.exports = { sendTemplate, sendMode, TEMPLATES, TEMPLATE_URL };
