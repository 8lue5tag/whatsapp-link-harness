'use strict';

const { request, parseJson } = require('./http');

// Shapes taken from the official collection:
//   github.com/ClareAI/wati-postman-collection
//
// Two things that differ from most providers and will bite you:
//
//  1. Template variables are NAMED, not positional:
//       parameters: [{ name: "name", value: "John" }, ...]
//     The names are whatever you called them when building the template. A
//     dynamic URL button's variable is just another named parameter.
//
//  2. sendSessionMessage takes multipart form-data, not JSON and not a query
//     string. Set WATI_SESSION_VIA_QUERY=1 if your tenant wants ?messageText=.
//
// Base URL is per-tenant - copy it from WATI's own API docs page. The published
// environment file uses https://app-server.wati.io, but live tenants are usually
// https://live-mt-server.wati.io/<tenantId> or https://live-server-<id>.wati.io.

function bearer(token) {
  const t = String(token || '').trim();
  return t.toLowerCase().startsWith('bearer ') ? t : `Bearer ${t}`;
}

function interpret(text, httpOk) {
  const json = parseJson(text);
  if (!json) return { ok: httpOk, detail: String(text).slice(0, 300) };
  // WATI answers HTTP 200 with {"result":false,"info":"..."} on rejection.
  const ok = json.result === true || json.result === 'success' || (httpOk && json.result === undefined);
  const detail =
    json.info ||
    json.message ||
    (json.validWhatsAppNumber === false ? 'not a valid WhatsApp number' : null) ||
    JSON.stringify(json).slice(0, 300);
  return { ok, detail };
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
      broadcastName: env.WATI_BROADCAST_NAME || 'harness-test',
      sessionViaQuery: String(env.WATI_SESSION_VIA_QUERY || '') === '1'
    };
  },

  missing(cfg) {
    return [...(cfg.base ? [] : ['WATI_BASE_URL']), ...(cfg.token ? [] : ['WATI_TOKEN'])];
  },

  /** Session reply - allowed for 24h after the customer's last message. */
  async sendText({ cfg, destination, text }) {
    const path = `${cfg.base}/api/v1/sendSessionMessage/${encodeURIComponent(destination)}`;
    const headers = { authorization: bearer(cfg.token) };

    const out = cfg.sessionViaQuery
      ? await request({ url: `${path}?messageText=${encodeURIComponent(text)}`, headers })
      : await request({ url: path, headers, multipart: { messageText: text } });

    const v = interpret(out.response, out.httpOk);
    return { ...out, ok: out.httpOk && v.ok, detail: v.detail };
  },

  /**
   * Named parameters, straight through. The URL button's variable is simply one
   * of them - whichever name you gave it in the template builder.
   */
  async sendTemplate({ cfg, destination, templateId, params }) {
    const parameters = (params || []).map((p) => ({ name: String(p.name), value: String(p.value) }));

    const out = await request({
      url: `${cfg.base}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(destination)}`,
      headers: { authorization: bearer(cfg.token) },
      json: {
        template_name: templateId,
        broadcast_name: cfg.broadcastName || templateId,
        parameters
      }
    });
    const v = interpret(out.response, out.httpOk);
    return { ...out, ok: out.httpOk && v.ok, detail: v.detail };
  },

  /** Handy for a real campaign: one call, many recipients, per-recipient params. */
  async sendTemplateBulk({ cfg, templateId, receivers }) {
    const out = await request({
      url: `${cfg.base}/api/v1/sendTemplateMessages`,
      headers: { authorization: bearer(cfg.token) },
      json: {
        template_name: templateId,
        broadcast_name: cfg.broadcastName || templateId,
        receivers: receivers.map((r) => ({
          whatsappNumber: String(r.whatsappNumber),
          customParams: (r.params || []).map((p) => ({ name: String(p.name), value: String(p.value) }))
        }))
      }
    });
    const v = interpret(out.response, out.httpOk);
    return { ...out, ok: out.httpOk && v.ok, detail: v.detail };
  },

  /** Useful for discovering the exact variable names your template declares. */
  async listTemplates({ cfg }) {
    const out = await request({
      url: `${cfg.base}/api/v1/getMessageTemplates?pageSize=50&pageNumber=1`,
      method: 'GET',
      headers: { authorization: bearer(cfg.token) }
    });
    return { ...out, ok: out.httpOk, json: parseJson(out.response) };
  }
};
