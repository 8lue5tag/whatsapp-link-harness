'use strict';

const { request, parseJson } = require('./http');

// MSG91 mirrors Meta's own component model more closely than the others, which
// makes the dynamic URL button the clearest here: it goes in as
//   button_1: { subtype: 'url', type: 'text', value: '<suffix>' }
// while body variables are body_1, body_2, ... in declaration order.
const BASE = 'https://api.msg91.com/api/v5/whatsapp';

function interpret(text, httpOk) {
  const json = parseJson(text);
  if (!json) return { ok: httpOk, detail: String(text).slice(0, 300) };
  const status = String(json.status || json.type || '').toLowerCase();
  const ok = httpOk && status !== 'error' && status !== 'fail' && !json.errors;
  return { ok, detail: json.message || json.errors ? JSON.stringify(json.errors || json.message) : JSON.stringify(json).slice(0, 300) };
}

module.exports = {
  key: 'msg91',
  label: 'MSG91',
  requires: { default: ['MSG91_AUTHKEY', 'MSG91_INTEGRATED_NUMBER'] },

  config(env) {
    return {
      flavour: 'default',
      authkey: env.MSG91_AUTHKEY || '',
      integratedNumber: env.MSG91_INTEGRATED_NUMBER || '',
      lang: env.MSG91_TEMPLATE_LANG || 'en'
    };
  },

  missing(cfg) {
    return [
      ...(cfg.authkey ? [] : ['MSG91_AUTHKEY']),
      ...(cfg.integratedNumber ? [] : ['MSG91_INTEGRATED_NUMBER'])
    ];
  },

  /** Session reply - allowed for 24h after the customer's last message. */
  async sendText({ cfg, destination, text }) {
    const out = await request({
      url: `${BASE}/whatsapp-outbound-message/bulk/`,
      headers: { authkey: cfg.authkey },
      json: {
        integrated_number: cfg.integratedNumber,
        content_type: 'text',
        payload: {
          messaging_product: 'whatsapp',
          type: 'text',
          to: [String(destination)],
          text: { body: text, preview_url: false }
        }
      }
    });
    const v = interpret(out.response, out.httpOk);
    return { ...out, ok: out.httpOk && v.ok, detail: v.detail };
  },

  async sendTemplate({ cfg, destination, templateId, bodyParams, buttonSuffix }) {
    const components = {};
    (bodyParams || []).forEach((value, i) => {
      components[`body_${i + 1}`] = { type: 'text', value: String(value) };
    });
    if (buttonSuffix) {
      components.button_1 = { subtype: 'url', type: 'text', value: buttonSuffix };
    }

    const out = await request({
      url: `${BASE}/whatsapp-outbound-message/bulk/`,
      headers: { authkey: cfg.authkey },
      json: {
        integrated_number: cfg.integratedNumber,
        content_type: 'template',
        payload: {
          messaging_product: 'whatsapp',
          type: 'template',
          template: {
            name: templateId,
            language: { code: cfg.lang, policy: 'deterministic' },
            to_and_components: [{ to: [String(destination)], components }]
          }
        }
      }
    });
    const v = interpret(out.response, out.httpOk);
    return { ...out, ok: out.httpOk && v.ok, detail: v.detail };
  }
};
