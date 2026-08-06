'use strict';

// Gupshup Enterprise API (media.smsgupshup.com/GatewayAPI/rest).
//
// Two ways to get a link onto a phone, with very different rules:
//
//  *_text     - msg_type=TEXT, free-form. Only allowed inside the 24h
//               customer-care window (the user messaged you first). Any URL,
//               no template, no Meta approval. This is the cheap test path.
//  *_template - msg_type=HSM, business-initiated. Needs an approved template.
//               The URL button's base is frozen at approval; only the suffix
//               varies, so it needs a permanent origin.
//
// Enterprise quirk that matters: it answers HTTP 200 and puts the real outcome
// in the body as status:"success" | "error". Never trust the status code alone.

const ENTERPRISE_BASE = 'https://media.smsgupshup.com/GatewayAPI/rest';
const SELFSERVE_BASE = 'https://api.gupshup.io/wa/api/v1';

function config(env) {
  return {
    mode: env.GUPSHUP_MODE || 'simulate',
    base: env.GUPSHUP_BASE || ENTERPRISE_BASE,
    userid: env.GUPSHUP_USERID || '',
    password: env.GUPSHUP_PASSWORD || '',
    // Self-serve only, kept for the eventual migration.
    apiKey: env.GUPSHUP_API_KEY || '',
    source: env.GUPSHUP_SOURCE || '',
    appName: env.GUPSHUP_APP_NAME || '',
    // Escape hatch: extra query params as `a=1&b=2`, merged into the request.
    // Enterprise accounts differ in what they require; this avoids code edits.
    extra: env.GUPSHUP_EXTRA_PARAMS || '',
    // Enterprise docs mostly show GET with query params, and some accounts only
    // accept that. Switchable because guessing wrong looks like an auth failure.
    httpMethod: (env.GUPSHUP_HTTP_METHOD || 'POST').toUpperCase()
  };
}

function missingConfig(cfg) {
  const missing = [];
  if (cfg.mode.startsWith('enterprise')) {
    if (!cfg.userid) missing.push('GUPSHUP_USERID');
    if (!cfg.password) missing.push('GUPSHUP_PASSWORD');
  } else if (cfg.mode.startsWith('selfserve')) {
    if (!cfg.apiKey) missing.push('GUPSHUP_API_KEY');
    if (!cfg.source) missing.push('GUPSHUP_SOURCE');
    if (!cfg.appName) missing.push('GUPSHUP_APP_NAME');
  }
  return missing;
}

function redact(params) {
  const clone = new URLSearchParams(params);
  if (clone.get('password')) clone.set('password', '***');
  if (clone.get('apikey')) clone.set('apikey', '***');
  return clone.toString();
}

/**
 * Enterprise puts the outcome in the body. Parse it, and treat an unparseable
 * body as a failure rather than optimistically assuming success.
 */
function interpretEnterprise(text) {
  try {
    const json = JSON.parse(text);
    const r = json.response || json;
    return { ok: String(r.status).toLowerCase() === 'success', detail: r.details || r.status || text };
  } catch (err) {
    // Enterprise sometimes replies in plain text: "error | 102 | ..."
    const ok = /^success/i.test(text.trim());
    return { ok, detail: text.trim().slice(0, 300) };
  }
}

async function postForm(url, params, headers, httpMethod) {
  let res, text;
  const useGet = httpMethod === 'GET';
  try {
    res = await fetch(useGet ? `${url}?${new URLSearchParams(params)}` : url, {
      method: useGet ? 'GET' : 'POST',
      headers: {
        accept: 'application/json',
        ...(useGet ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
        ...(headers || {})
      },
      ...(useGet ? {} : { body: new URLSearchParams(params) })
    });
    text = await res.text();
  } catch (err) {
    // Never reached Gupshup at all - worth distinguishing from a rejection.
    return { httpOk: false, status: 0, response: `fetch failed: ${err.message}`, request: redact(params) };
  }
  return { httpOk: res.ok, status: res.status, response: text, request: redact(params) };
}

function enterpriseParams(cfg, extraFields) {
  const params = {
    method: 'SendMessage',
    userid: cfg.userid,
    password: cfg.password,
    v: '1.1',
    format: 'json',
    auth_scheme: 'plain',
    ...extraFields
  };
  for (const [k, v] of new URLSearchParams(cfg.extra)) params[k] = v;
  return params;
}

/** Free-form text inside the 24h window. */
async function sendText({ cfg, destination, text }) {
  if (cfg.mode.startsWith('selfserve')) {
    const out = await postForm(
      SELFSERVE_BASE + '/msg',
      {
        channel: 'whatsapp',
        source: cfg.source,
        destination,
        'src.name': cfg.appName,
        message: JSON.stringify({ type: 'text', text, previewUrl: false })
      },
      { apikey: cfg.apiKey }
    );
    return { ...out, ok: out.httpOk };
  }

  const params = enterpriseParams(cfg, { send_to: destination, msg_type: 'TEXT', msg: text });
  const out = await postForm(cfg.base, params, null, cfg.httpMethod);
  const verdict = interpretEnterprise(out.response);
  return { ...out, ok: out.httpOk && verdict.ok, detail: verdict.detail };
}

/**
 * Approved template. Enterprise HSM takes the fully rendered message text - it
 * has no params array - and matches it against the approved template, so the
 * text must line up exactly or it is rejected.
 */
async function sendTemplate({ cfg, destination, templateId, params: vars, renderedText }) {
  if (cfg.mode.startsWith('selfserve')) {
    const out = await postForm(
      SELFSERVE_BASE + '/template/msg',
      {
        channel: 'whatsapp',
        source: cfg.source,
        destination,
        'src.name': cfg.appName,
        template: JSON.stringify({ id: templateId, params: vars })
      },
      { apikey: cfg.apiKey }
    );
    return { ...out, ok: out.httpOk };
  }

  const params = enterpriseParams(cfg, {
    send_to: destination,
    msg_type: 'HSM',
    isTemplate: 'true',
    msg: renderedText
  });
  const out = await postForm(cfg.base, params, null, cfg.httpMethod);
  const verdict = interpretEnterprise(out.response);
  return { ...out, ok: out.httpOk && verdict.ok, detail: verdict.detail };
}

module.exports = { config, missingConfig, sendText, sendTemplate, ENTERPRISE_BASE };
