'use strict';

const { request, parseJson } = require('./http');

// Gupshup has two unrelated APIs. Enterprise is the legacy gateway
// (media.smsgupshup.com, userid/password); self-serve is api.gupshup.io with an
// apikey header. Which one you have depends on when the account was created.
const ENTERPRISE_BASE = 'https://media.smsgupshup.com/GatewayAPI/rest';
const SELFSERVE_BASE = 'https://api.gupshup.io/wa/api/v1';

/**
 * Enterprise answers HTTP 200 and puts the real outcome in the body as
 * status:"success" | "error". Never trust its status code.
 */
function interpretEnterprise(text) {
  const json = parseJson(text);
  if (json) {
    const r = json.response || json;
    return { ok: String(r.status).toLowerCase() === 'success', detail: r.details || r.status || text };
  }
  return { ok: /^success/i.test(text.trim()), detail: text.trim().slice(0, 300) };
}

module.exports = {
  key: 'gupshup',
  label: 'Gupshup',
  requires: {
    enterprise: ['GUPSHUP_USERID', 'GUPSHUP_PASSWORD'],
    selfserve: ['GUPSHUP_API_KEY', 'GUPSHUP_SOURCE', 'GUPSHUP_APP_NAME']
  },

  config(env) {
    const flavour = env.GUPSHUP_FLAVOUR || (env.GUPSHUP_API_KEY ? 'selfserve' : 'enterprise');
    return {
      flavour,
      base: env.GUPSHUP_BASE || (flavour === 'selfserve' ? SELFSERVE_BASE : ENTERPRISE_BASE),
      userid: env.GUPSHUP_USERID || '',
      password: env.GUPSHUP_PASSWORD || '',
      apiKey: env.GUPSHUP_API_KEY || '',
      source: env.GUPSHUP_SOURCE || '',
      appName: env.GUPSHUP_APP_NAME || '',
      // Enterprise accounts differ in the params they demand; this avoids edits.
      extra: env.GUPSHUP_EXTRA_PARAMS || '',
      httpMethod: (env.GUPSHUP_HTTP_METHOD || 'POST').toUpperCase()
    };
  },

  missing(cfg) {
    const need = this.requires[cfg.flavour] || [];
    const have = {
      GUPSHUP_USERID: cfg.userid,
      GUPSHUP_PASSWORD: cfg.password,
      GUPSHUP_API_KEY: cfg.apiKey,
      GUPSHUP_SOURCE: cfg.source,
      GUPSHUP_APP_NAME: cfg.appName
    };
    return need.filter((k) => !have[k]);
  },

  enterpriseForm(cfg, fields) {
    const form = {
      method: 'SendMessage',
      userid: cfg.userid,
      password: cfg.password,
      v: '1.1',
      format: 'json',
      auth_scheme: 'plain',
      ...fields
    };
    for (const [k, v] of new URLSearchParams(cfg.extra)) form[k] = v;
    return form;
  },

  /** Free-form text. Only permitted inside the 24h customer-care window. */
  async sendText({ cfg, destination, text }) {
    if (cfg.flavour === 'selfserve') {
      const out = await request({
        url: cfg.base + '/msg',
        headers: { apikey: cfg.apiKey },
        form: {
          channel: 'whatsapp',
          source: cfg.source,
          destination,
          'src.name': cfg.appName,
          message: JSON.stringify({ type: 'text', text, previewUrl: false })
        }
      });
      return { ...out, ok: out.httpOk };
    }

    const useGet = cfg.httpMethod === 'GET';
    const form = this.enterpriseForm(cfg, { send_to: destination, msg_type: 'TEXT', msg: text });
    const out = useGet
      ? await request({ url: `${cfg.base}?${new URLSearchParams(form)}`, method: 'GET' })
      : await request({ url: cfg.base, form });
    const v = interpretEnterprise(out.response);
    return { ...out, ok: out.httpOk && v.ok, detail: v.detail };
  },

  /**
   * Enterprise HSM has no params array - it takes the fully rendered text and
   * matches it against the approved template, so the text must line up exactly.
   */
  async sendTemplate({ cfg, destination, templateId, params: named, renderedText }) {
    if (cfg.flavour === 'selfserve') {
      // Positional, body variables first, the URL button's suffix last.
      const params = [
        ...(named || []).filter((p) => !p.button).map((p) => String(p.value)),
        ...(named || []).filter((p) => p.button).map((p) => String(p.value))
      ];
      const out = await request({
        url: cfg.base + '/template/msg',
        headers: { apikey: cfg.apiKey },
        form: {
          channel: 'whatsapp',
          source: cfg.source,
          destination,
          'src.name': cfg.appName,
          template: JSON.stringify({ id: templateId, params })
        }
      });
      return { ...out, ok: out.httpOk };
    }

    const form = this.enterpriseForm(cfg, {
      send_to: destination,
      msg_type: 'HSM',
      isTemplate: 'true',
      msg: renderedText
    });
    const out = await request({ url: cfg.base, form });
    const v = interpretEnterprise(out.response);
    return { ...out, ok: out.httpOk && v.ok, detail: v.detail };
  }
};
