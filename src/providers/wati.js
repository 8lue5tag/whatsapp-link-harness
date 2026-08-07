'use strict';

const { request, parseJson } = require('./http');

// WATI is per-tenant: your base URL contains your instance id, e.g.
//   https://live-mt-server.wati.io/123456      (newer accounts)
//   https://live-server-123456.wati.io         (older accounts)
// Copy it from the WATI dashboard's API docs page - guessing it will 404.
//
// WATI template variables are NAMED, not positional, and you choose the names
// when you create the template. So the dynamic URL button's parameter name is
// whatever you called it - hence WATI_BUTTON_PARAM rather than a fixed guess.

function bearer(token) {
  const t = String(token || '').trim();
  return t.toLowerCase().startsWith('bearer ') ? t : `Bearer ${t}`;
}

function interpret(text, httpOk) {
  const json = parseJson(text);
  if (!json) return { ok: httpOk, detail: String(text).slice(0, 300) };
  // WATI answers 200 with {"result":false,"info":"..."} on rejection.
  const ok = json.result === true || json.result === 'success' || (httpOk && json.result === undefined);
  return { ok, detail: json.info || json.message || JSON.stringify(json).slice(0, 300) };
}

module.exports = {
  key: 'wati',
  label: 'WATI',
  requires: { default: ['WATI_BASE_URL', 'WATI_TOKEN'] },

  config(env) {
    return {
      flavour: 'default',
      base: String(env.WATI_BASE_URL || '').replace(/\/+$/, ''),
      token: env.WATI_TOKEN || '',
      // The template variable name for the URL button's suffix.
      buttonParam: env.WATI_BUTTON_PARAM || 'token',
      broadcastName: env.WATI_BROADCAST_NAME || 'harness-test'
    };
  },

  missing(cfg) {
    return [
      ...(cfg.base ? [] : ['WATI_BASE_URL']),
      ...(cfg.token ? [] : ['WATI_TOKEN'])
    ];
  },

  /** Session reply - allowed for 24h after the customer's last message. */
  async sendText({ cfg, destination, text }) {
    const url = `${cfg.base}/api/v1/sendSessionMessage/${encodeURIComponent(destination)}?messageText=${encodeURIComponent(text)}`;
    const out = await request({ url, headers: { authorization: bearer(cfg.token) } });
    const v = interpret(out.response, out.httpOk);
    return { ...out, ok: out.httpOk && v.ok, detail: v.detail };
  },

  async sendTemplate({ cfg, destination, templateId, bodyParams, buttonSuffix }) {
    const parameters = (bodyParams || []).map((value, i) => ({ name: String(i + 1), value: String(value) }));
    if (buttonSuffix) parameters.push({ name: cfg.buttonParam, value: buttonSuffix });

    const out = await request({
      url: `${cfg.base}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(destination)}`,
      headers: { authorization: bearer(cfg.token) },
      json: {
        template_name: templateId,
        broadcast_name: cfg.broadcastName,
        parameters
      }
    });
    const v = interpret(out.response, out.httpOk);
    return { ...out, ok: out.httpOk && v.ok, detail: v.detail };
  }
};
