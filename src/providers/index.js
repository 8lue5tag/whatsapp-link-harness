'use strict';

const simulate = {
  key: 'simulate',
  label: 'Simulate (no network call)',
  requires: { default: [] },
  config: () => ({ flavour: 'default' }),
  missing: () => [],
  async sendText() {
    return { ok: true, status: 0, response: 'simulated', request: null, detail: 'simulated' };
  },
  async sendTemplate() {
    return { ok: true, status: 0, response: 'simulated', request: null, detail: 'simulated' };
  }
};

const ADAPTERS = [simulate, require('./gupshup'), require('./wati'), require('./msg91')];
const BY_KEY = Object.fromEntries(ADAPTERS.map((a) => [a.key, a]));

function get(key) {
  return BY_KEY[key] || null;
}

/** Which providers are actually usable right now, and what each is missing. */
function status(env) {
  return ADAPTERS.map((a) => {
    const cfg = a.config(env);
    const missing = a.missing(cfg);
    return {
      key: a.key,
      label: a.label,
      flavour: cfg.flavour,
      ready: missing.length === 0,
      missing
    };
  });
}

/**
 * Send via a named provider. `mode` picks free-form text (only legal inside the
 * 24h customer-care window) or an approved template.
 */
async function send({ providerKey, mode, env, destination, text, templateId, params, renderedText }) {
  const adapter = get(providerKey);
  if (!adapter) return { ok: false, status: 0, response: `unknown provider: ${providerKey}`, detail: 'unknown_provider' };

  const cfg = adapter.config(env);
  const missing = adapter.missing(cfg);
  if (missing.length) {
    return {
      ok: false,
      status: 0,
      response: `missing config: ${missing.join(', ')}`,
      detail: `missing ${missing.join(', ')}`
    };
  }
  if (mode === 'template' && !templateId) {
    return { ok: false, status: 0, response: 'no template name/id given', detail: 'missing_template' };
  }

  return mode === 'template'
    ? adapter.sendTemplate({ cfg, destination, templateId, params, renderedText })
    : adapter.sendText({ cfg, destination, text });
}

module.exports = { get, status, send, ADAPTERS };
