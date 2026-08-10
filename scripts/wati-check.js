'use strict';

/**
 * Which WATI token works?
 *
 *   npm run wati:check
 *
 * WATI hands out two things that both look like credentials:
 *   - a long JWT starting "eyJ..."  - the classic Access Token, used as
 *     Authorization: Bearer <jwt> against the /api/v1 endpoints this harness
 *     integrates (and the ones in WATI's own Postman collection)
 *   - a key starting "wati_..."     - belongs to WATI's newer API surface
 *
 * Rather than argue about it, this calls getMessageTemplates with each token you
 * put in .env and reports which one WATI actually accepts. Put them in .env as
 * WATI_TOKEN and WATI_TOKEN_ALT so neither ends up in your shell history.
 */

const wati = require('../src/providers/wati');

function label(token) {
  const t = String(token || '').replace(/^bearer\s+/i, '');
  if (!t) return '(empty)';
  if (t.startsWith('eyJ')) return `JWT  ${t.slice(0, 6)}…${t.slice(-4)} (${t.length} chars)`;
  if (t.startsWith('wati_')) return `key  wati_…${t.slice(-4)} (${t.length} chars)`;
  return `?    ${t.slice(0, 4)}…${t.slice(-4)} (${t.length} chars)`;
}

async function tryToken(base, token) {
  const out = await wati.listTemplates({ cfg: { base, token } });
  const names =
    out.json && Array.isArray(out.json.messageTemplates)
      ? out.json.messageTemplates.map((t) => t.elementName || t.name)
      : null;
  return { status: out.status, ok: out.ok, names, body: String(out.response).slice(0, 200) };
}

(async () => {
  const base = String(process.env.WATI_BASE_URL || '').replace(/\/+$/, '');
  if (!base) {
    console.error('Set WATI_BASE_URL in .env first — copy it from WATI\'s API docs page.');
    console.error('Usually https://live-mt-server.wati.io/<tenantId> or https://live-server-<id>.wati.io');
    process.exit(1);
  }
  console.log('base: ' + base + '\n');

  const candidates = [
    ['WATI_TOKEN', process.env.WATI_TOKEN],
    ['WATI_BEARER_TOKEN', process.env.WATI_BEARER_TOKEN],
    ['WATI_TOKEN_ALT', process.env.WATI_TOKEN_ALT]
  ].filter(([, v]) => v);

  if (!candidates.length) {
    console.error('Put your token(s) in .env as WATI_TOKEN and/or WATI_BEARER_TOKEN.');
    process.exit(1);
  }

  for (const [name, token] of candidates) {
    const r = await tryToken(base, token);
    console.log(`${name.padEnd(15)} ${label(token)}`);
    console.log(`  -> HTTP ${r.status} ${r.ok ? 'ACCEPTED' : 'rejected'}`);
    if (r.names) {
      console.log(`  -> ${r.names.length} template(s): ${r.names.join(', ')}`);
    } else if (!r.ok) {
      console.log(`  -> ${r.body}`);
    }
    console.log('');
  }

  console.log('Use whichever one says ACCEPTED as WATI_TOKEN, in .env and in Render.');
})();
