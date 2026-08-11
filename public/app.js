'use strict';

const $ = (sel) => document.querySelector(sel);
let bearer = localStorage.getItem('bearer') || '';
let me = JSON.parse(localStorage.getItem('me') || 'null');
let state = null;
let timer = null;

// Chosen per send, remembered locally so it survives a refresh.
// Matches the approved template:
//   Hi {{NAME}}, your recent {{mat}} buying rate was Rs {{price}} per kg.
//   Confirm rate change if any.        button -> .../s/{{1}}
// Names are case-sensitive and must match the template exactly.
const DEFAULT_PARAMS = [
  '[',
  '  { "name": "NAME",  "value": "{{first_name}}" },',
  '  { "name": "mat",   "value": "{{material}}" },',
  '  { "name": "price", "value": "{{rate}}" },',
  '  { "name": "1",     "value": "{{token}}", "button": true }',
  ']'
].join('\n');

// The lot-review template, approved separately with its own frozen base:
//   Hi {{name}}, There are {{num}} lots totaling {{qty}} MT for {{mat}}
//   pending your confirmation.        button -> .../lots/{{1}}
// Sent by the lot picker's own button, so it never has to be typed in.
const LOT_TEMPLATE = 'omp_test_buyer_check_lots';
const LOT_PARAMS = [
  { name: 'name', value: '{{first_name}}' },
  { name: 'num', value: '{{lot_count}}' },
  { name: 'qty', value: '{{lot_mt}}' },
  { name: 'mat', value: '{{lot_material}}' },
  { name: '1', value: '{{token}}', button: true }
];

const send = {
  provider: localStorage.getItem('send.provider') || 'simulate',
  mode: localStorage.getItem('send.mode') || 'text',
  // WATI elementName of the approved rate-confirmation template. Its button is a
  // dynamic URL on .../s/{{1}} with buttonParamMapping.paramName = "1".
  template: localStorage.getItem('send.template') || 'omp_test_token_buyer1',
  paramsText: localStorage.getItem('send.paramsText') || DEFAULT_PARAMS
};

function parsedParams() {
  try {
    const v = JSON.parse(send.paramsText);
    return Array.isArray(v) ? v : null;
  } catch (err) {
    return null;
  }
}
function setSend(k, v) {
  send[k] = v;
  localStorage.setItem('send.' + k, v);
  renderSendSettings();
}

/* ------------------------------ helpers -------------------------------- */

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: 'Bearer ' + bearer } : {}),
      ...(options.headers || {})
    }
  });
  if (res.status === 401 && bearer) signOut();
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || res.statusText), { body });
  return body;
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clockTime = (ms) => new Date(ms).toLocaleTimeString('en-IN', { hour12: false });

function rel(ms) {
  if (ms == null) return 'never';
  const d = ms - state.now;
  const past = d < 0;
  const a = Math.abs(d);
  const unit =
    a < 60000 ? Math.round(a / 1000) + 's' :
    a < 3600000 ? Math.round(a / 60000) + 'm' :
    a < 86400000 ? (a / 3600000).toFixed(1) + 'h' :
    (a / 86400000).toFixed(1) + 'd';
  return past ? unit + ' ago' : 'in ' + unit;
}

/* -------------------------------- auth --------------------------------- */

async function signIn() {
  $('#loginErr').textContent = '';
  try {
    const out = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: $('#email').value.trim(), password: $('#password').value })
    });
    bearer = out.token;
    me = out.user;
    localStorage.setItem('bearer', bearer);
    localStorage.setItem('me', JSON.stringify(me));
    boot();
  } catch (err) {
    $('#loginErr').textContent = err.body && err.body.error === 'bad_credentials' ? 'Wrong email or password' : err.message;
  }
}

function signOut() {
  bearer = '';
  me = null;
  localStorage.removeItem('bearer');
  localStorage.removeItem('me');
  clearInterval(timer);
  $('#app').hidden = true;
  $('#login').hidden = false;
}

/* ------------------------------ rendering ------------------------------ */

function renderClock() {
  const el = $('#clock');
  const off = state.clock_offset_ms;
  el.textContent = clockTime(state.now) + (off ? `  (+${Math.round(off / 60000)}m virtual)` : '  (real time)');
  el.classList.toggle('shifted', off !== 0);

  // Sellers don't get the time machine or the reset button.
  $('#clockControls').hidden = !state.can.move_clock;
  $('#resetAll').hidden = !state.can.reset_data;

  const badge = $('#mode');
  const p = (state.send_mode.providers || []).find((x) => x.key === send.provider);
  const broken = p && !p.ready && p.key !== 'simulate';
  badge.textContent = `${send.provider} · ${send.mode}${broken ? ' — not configured' : ''}`;
  badge.className = 'pill ' + (broken ? 'revoked' : send.provider === 'simulate' ? '' : 'active');
}

function renderSellers() {
  const sellers = state.users.filter((u) => u.role === 'seller');
  $('#sellers').innerHTML = sellers
    .map((s) => {
      const listings = state.listings.filter((l) => l.seller_id === s.id);
      const bids = state.bids.filter((b) => b.seller_id === s.id);
      const kyc = state.kyc.find((k) => k.seller_id === s.id);
      return `
      <div class="card">
        <h3>${esc(s.name)}</h3>
        <div class="row small" style="margin:2px 0 8px">
          <span class="muted">${esc(s.city)}</span>
          <input class="mono" style="max-width:150px;padding:3px 8px" value="${esc(s.wa_id || '')}"
                 placeholder="91XXXXXXXXXX" data-phone-for="${s.id}" />
          <button class="tiny" data-save-phone="${s.id}">save number</button>
        </div>
        ${listings
          .map(
            (l) => `
          <div class="small" style="margin-bottom:6px">
            <div>${esc(l.title)}
              <span class="pill ${l.status === 'published' ? 'revoked' : ''}">${esc(l.status)}</span>
              ${l.pickup_confirmed ? '<span class="pill active">pickup ok</span>' : ''}
            </div>
            <div class="row" style="margin-top:4px">
              <button class="tiny" data-send="listing_draft" data-res="${l.id}">send: resume draft (7d)</button>
              <button class="tiny" data-send="pickup_slot" data-res="${l.id}">send: confirm pickup (${rel(l.pickup_at)})</button>
            </div>
          </div>`
          )
          .join('')}
        ${bids
          .map(
            (b) => `
          <div class="small" style="margin-bottom:6px">
            <div>Bid ${esc(b.id)} &middot; ₹${b.amount.toLocaleString('en-IN')} from ${esc(b.buyer)}
              <span class="pill ${b.status === 'open' ? 'active' : 'revoked'}">${esc(b.status)}</span></div>
            <div class="row" style="margin-top:4px">
              <button class="tiny" data-send="bid_response" data-res="${b.id}">send: respond to bid (3h)</button>
            </div>
          </div>`
          )
          .join('')}
        <div class="small">
          <div>KYC ${esc(kyc.id)} <span class="pill ${kyc.status === 'pending' ? '' : 'active'}">${esc(kyc.status)}</span></div>
          <div class="row" style="margin-top:4px">
            <button class="tiny" data-send="kyc" data-res="${kyc.id}">send: KYC (15m, single use)</button>
          </div>
        </div>
      </div>`;
    })
    .join('');
}

function renderSendSettings() {
  const list = (state.send_mode && state.send_mode.providers) || [];
  $('#sendSettings').innerHTML = `
    <div class="row" style="margin-bottom:8px">
      <select id="provSel" style="max-width:190px">
        ${list
          .map(
            (p) =>
              `<option value="${esc(p.key)}" ${p.key === send.provider ? 'selected' : ''}>
                 ${esc(p.label)}${p.ready || p.key === 'simulate' ? '' : ' — not configured'}
               </option>`
          )
          .join('')}
      </select>
      <select id="modeSel" style="max-width:200px">
        <option value="text" ${send.mode === 'text' ? 'selected' : ''}>Free text (24h window)</option>
        <option value="template" ${send.mode === 'template' ? 'selected' : ''}>Approved template</option>
      </select>
    </div>
    <input id="tplInput" placeholder="template name (WATI: elementName)" value="${esc(send.template)}"
           ${send.mode === 'template' ? '' : 'disabled'} />
    ${
      send.mode === 'template'
        ? `<div style="margin-top:8px">
             <div class="row" style="justify-content:space-between">
               <span class="small muted">Parameters — WATI matches by <em>name</em></span>
               ${state.can.see_all_sellers ? '<button class="tiny" id="pullTpl">pull WATI templates</button>' : ''}
             </div>
             <textarea id="paramsInput" rows="6" class="mono" style="margin-top:4px">${esc(send.paramsText)}</textarea>
             <p class="small ${parsedParams() ? 'muted' : 'err'}" style="margin:4px 0 0">
               ${
                 parsedParams()
                   ? 'Placeholders: {{token}} {{url}} {{name}} {{first_name}} {{title}} {{amount}} {{buyer}} {{city}} · mark the URL button param with "button": true'
                   : 'Not valid JSON — sends will fall back to no parameters.'
               }
             </p>
             <div class="small mono muted" id="tplList" style="margin-top:6px"></div>
           </div>`
        : ''
    }
    <p class="small muted" style="margin-bottom:0">
      ${
        send.mode === 'text'
          ? 'Free text carries the whole URL and needs no approval — but only works if this person messaged you in the last 24 hours.'
          : 'Template sends only the 22-char token; the URL base is frozen at approval.'
      }
    </p>
    ${list
      .filter((p) => !p.ready && p.key !== 'simulate')
      .map((p) => `<p class="small" style="color:var(--warn);margin:4px 0 0">${esc(p.label)}: set ${esc(p.missing.join(', '))}</p>`)
      .join('')}`;

  $('#provSel').onchange = (e) => setSend('provider', e.target.value);
  $('#modeSel').onchange = (e) => setSend('mode', e.target.value);
  $('#tplInput').oninput = (e) => {
    send.template = e.target.value;
    localStorage.setItem('send.template', e.target.value);
  };

  const pi = $('#paramsInput');
  if (pi) {
    pi.oninput = (e) => {
      send.paramsText = e.target.value;
      localStorage.setItem('send.paramsText', e.target.value);
    };
    // Re-render only on blur, so typing isn't interrupted by the 2s refresh.
    pi.onblur = () => renderSendSettings();
  }

  const pull = $('#pullTpl');
  if (pull) {
    pull.onclick = async () => {
      const out = $('#tplList');
      out.textContent = 'asking WATI…';
      try {
        const r = await api('/api/providers/wati/templates');
        out.innerHTML = r.templates
          ? r.templates
              .map(
                (t) =>
                  `<div>${esc(t.name)} <span class="muted">${esc(t.status || '')}</span>` +
                  (t.variables && t.variables.length
                    ? ` — vars: ${esc(t.variables.join(', '))}`
                    : ' — no variables listed') +
                  `</div>`
              )
              .join('')
          : esc(r.raw || 'no templates returned');
      } catch (err) {
        out.textContent = err.body ? JSON.stringify(err.body) : err.message;
      }
    };
  }
}

/* ------------------------------ signups --------------------------------- */

// Which captured numbers the next broadcast goes to. Held here rather than read
// off the checkboxes, because the panel is redrawn every two seconds and the
// selection has to survive that.
const selected = new Set();
// seller_id -> what the provider said about the last broadcast to them.
const bcastResults = new Map();
let lastBroadcast = '';

const tplFor = (key, fallback) => localStorage.getItem('bcast.tpl.' + key) || fallback;

function renderSignups() {
  const el = $('#signups');
  // Never rip the DOM out from under someone typing a template name.
  if (el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT'
      && document.activeElement.type === 'text') return;

  const rows = state.signups || [];
  const casts = state.broadcasts || [];
  for (const id of [...selected]) if (!rows.some((r) => r.id === id)) selected.delete(id);

  const joinRow = `
    <div class="row small" style="margin-bottom:10px">
      <span class="muted">public onboarding link</span>
      <span class="mono" style="color:var(--blue);word-break:break-all">${esc(state.join_url || '/join')}</span>
      <button class="tiny" data-copy-url="${esc(state.join_url || '')}">copy</button>
      <a class="small" href="${esc(state.join_url || '/join')}" target="_blank" rel="noopener">open</a>
    </div>`;

  if (!rows.length) {
    el.innerHTML = joinRow +
      `<p class="muted small" style="margin-bottom:0">
         Nobody has signed up yet. Open the link above, finish the flow, and the number appears here.
       </p>`;
    return;
  }

  const approved = rows.filter((r) => r.status === 'approved').length;
  const allOn = rows.every((r) => selected.has(r.id));

  el.innerHTML = joinRow + `
    <div class="row small" style="justify-content:space-between;margin-bottom:8px">
      <label class="row small" style="gap:6px">
        <input type="checkbox" id="selAll" ${allOn ? 'checked' : ''} />
        <span>select all</span>
      </label>
      <span class="muted">${rows.length} captured &middot; ${approved} approved &middot; ${selected.size} selected</span>
    </div>` +
    rows
      .map(
        (r) => `
      <div class="card" style="padding:10px 12px">
        <div class="row small" style="justify-content:space-between">
          <label class="row small" style="gap:8px;min-width:0">
            <input type="checkbox" data-pick="${esc(r.id)}" ${selected.has(r.id) ? 'checked' : ''} />
            <span><strong>${esc(r.name)}</strong> <span class="muted">+${esc(r.wa_id)}</span></span>
          </label>
          <span class="pill ${r.status === 'approved' ? 'active' : ''}">${esc(r.status)}</span>
        </div>
        <div class="small muted" style="margin-top:4px">
          <span class="mono">${esc(r.cust_id || r.id)}</span> &middot;
          ${esc(r.company || 'no business name')} &middot;
          ${r.docs_submitted_at ? 'docs in' : '<span style="color:var(--warn)">docs pending</span>'} &middot;
          ${esc(r.material || 'no material yet')}${r.last_rate ? ' @ ₹' + r.last_rate + '/kg' : ''} &middot;
          signed up ${rel(r.signed_up_at)} &middot; opened ${r.opened}×
        </div>
        <div class="row small" style="margin-top:6px">
          <button class="tiny" data-copy-url="${esc(r.url || '')}">copy portal link</button>
          <a class="small" href="${esc(r.url || '#')}" target="_blank" rel="noopener">open</a>
        </div>
        ${(() => {
          const last = bcastResults.get(r.id);
          return last ? `<div class="small ${last.ok ? 'ok' : 'err'}">${esc(last.text)}</div>` : '';
        })()}
      </div>`
      )
      .join('') + `
    <div class="card">
      <div class="small muted" style="margin-bottom:8px">
        Broadcast to the selected numbers, one send each, through the provider and mode above.
      </div>
      ${casts
        .map(
          (b) => `
        <div style="margin-bottom:10px">
          <button class="tiny primary" data-broadcast="${esc(b.key)}" style="width:100%">${esc(b.label)}</button>
          <div class="row small" style="margin-top:4px;flex-wrap:nowrap">
            <input class="mono" style="flex:1;min-width:0;padding:3px 8px"
                   data-tpl-for="${esc(b.key)}" value="${esc(tplFor(b.key, b.template))}" />
            <span class="muted" style="white-space:nowrap">${esc(b.intent)}</span>
          </div>
        </div>`
        )
        .join('')}
      <p class="small muted" style="margin:8px 0 0">
        Template names apply to <em>template</em> mode only. Free text and simulate use each
        broadcast's own wording, so all three work before anything is approved.
      </p>
      <div class="small" id="bcastOut" style="margin-top:6px">${esc(lastBroadcast)}</div>
    </div>`;

  $('#selAll').onchange = (e) => {
    rows.forEach((r) => (e.target.checked ? selected.add(r.id) : selected.delete(r.id)));
    renderSignups();
  };
  el.querySelectorAll('[data-pick]').forEach((c) => {
    c.onchange = () => {
      c.checked ? selected.add(c.dataset.pick) : selected.delete(c.dataset.pick);
      renderSignups();
    };
  });
  el.querySelectorAll('[data-tpl-for]').forEach((i) => {
    i.oninput = () => localStorage.setItem('bcast.tpl.' + i.dataset.tplFor, i.value);
  });
}

function renderCampaign() {
  const rows = state.campaign || [];
  $('#campaign').innerHTML =
    `<p class="small muted" style="margin-top:0">
       These never expire and are rebuilt identically on every restart, so they are safe to
       paste into a Gupshup campaign. One row per recipient.
     </p>` +
    rows
      .map(
        (c) => `
      <div class="card">
        <div class="row" style="justify-content:space-between">
          <div><strong>${esc(c.name)}</strong> <span class="muted small">+${esc(c.wa_id || 'no number')}</span></div>
          <span class="pill ${c.status === 'active' ? 'active' : esc(c.status)}">${esc(c.status)}</span>
        </div>
        <div class="muted small" style="margin-top:8px">price screen</div>
        <div class="mono small" style="word-break:break-all;margin:4px 0;color:var(--blue)">${esc(c.url)}</div>
        <div class="row small">
          <button class="tiny" data-copy-url="${esc(c.url)}">copy URL</button>
          <button class="tiny" data-copy-url="${esc(c.token)}">copy token only</button>
          <button class="tiny primary" data-campaign-send="${esc(c.seller_id)}">send this link</button>
          <a class="small" href="${esc(c.url)}" target="_blank" rel="noopener">open</a>
          <span class="muted">opened ${c.use_count}×</span>
        </div>
        <div class="muted small" style="margin-top:10px">lot picker</div>
        <div class="mono small" style="word-break:break-all;margin:4px 0;color:var(--blue)">${esc(c.lots_url || '')}</div>
        <div class="row small">
          <button class="tiny" data-copy-url="${esc(c.lots_url || '')}">copy URL</button>
          <button class="tiny" data-copy-url="${esc(c.lots_token || '')}">copy token only</button>
          <button class="tiny primary" data-campaign-send="${esc(c.seller_id)}" data-intent="lot_select">send this link</button>
          <a class="small" href="${esc(c.lots_url || '')}" target="_blank" rel="noopener">open</a>
          <span class="muted">opened ${c.lots_use_count || 0}×</span>
        </div>
        <div class="small lots" data-cmsg="${esc(c.seller_id)}"></div>
        <div class="small" data-cmsg="${esc(c.seller_id)}"></div>
      </div>`
      )
      .join('');
}

function renderIntents() {
  $('#intents').innerHTML =
    '<tr><th>Intent</th><th>Ceiling</th><th>Reuse</th><th>Step-up</th></tr>' +
    state.intents
      .map(
        (i) => `<tr>
          <td>${esc(i.label)}<div class="muted">${esc(i.rationale)}</div></td>
          <td>${i.ceiling_ms == null ? 'slot time' : i.ceiling_ms >= 86400000 ? i.ceiling_ms / 86400000 + 'd' : i.ceiling_ms / 60000 + 'm'}</td>
          <td>${i.renewable ? 'unlimited until ceiling' : 'single'}</td>
          <td>${i.step_up ? 'OTP' : '—'}</td>
        </tr>`
      )
      .join('');
}

function renderMessages() {
  const el = $('#messages');
  if (!state.messages.length) {
    el.innerHTML = '<p class="muted small">No messages yet. Send a link from the left.</p>';
    return;
  }
  el.innerHTML = state.messages
    .slice(0, 8)
    .map(
      (m) => `
      <div class="bubble">
        <div class="tpl">${esc(m.template)}${m.note ? ' &middot; ' + esc(m.note) : ''}</div>
        <div>${esc(m.body)}</div>
        <a class="cta" href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.button_label)}</a>
        <div class="time">to +${esc(m.wa_id)} &middot; ${clockTime(m.at)} &middot; ${esc(m.provider || m.channel)}/${esc(m.send_mode || '')}</div>
        ${(m.provider || m.channel) === 'simulate' ? '' : `
        <div class="small" style="margin-top:6px;border-top:1px solid #2a3942;padding-top:6px">
          <span class="pill ${m.provider_ok ? 'active' : 'revoked'}">${m.provider_ok ? 'accepted' : 'failed'}</span>
          <span class="muted">HTTP ${esc(m.provider_status)}</span>
          <div class="mono muted" style="word-break:break-all;margin-top:4px">${esc(String(m.provider_response || '').slice(0, 300))}</div>
        </div>`}
      </div>`
    )
    .join('');
}

function renderTokens() {
  const rows = state.tokens.slice(0, 25);
  $('#tokens').innerHTML =
    '<tr><th>Token</th><th>Intent / resource</th><th>Ceiling</th><th>Uses</th><th>Status</th><th></th></tr>' +
    (rows.length
      ? rows
          .map(
            (t) => `<tr>
        <td class="mono">${esc(t.hint)}<div class="muted">${esc(t.seller_id)}</div></td>
        <td>${esc(t.intent)}<div class="muted">${esc(t.resource_id)}</div></td>
        <td>${rel(t.expires_at)}<div class="muted">never extends</div></td>
        <td>${t.use_count}${t.fraud_alert ? ' <span class="pill alert">flagged</span>' : ''}</td>
        <td><span class="pill ${esc(t.status)}">${esc(t.status)}</span></td>
        <td>${t.status === 'active' ? `<button class="tiny danger" data-revoke="${t.id}">revoke</button>` : ''}</td>
      </tr>`
          )
          .join('')
      : '<tr><td colspan="6" class="muted">No tokens issued yet.</td></tr>');
}

function renderSessions() {
  const rows = state.sessions.slice(0, 12);
  $('#sessions').innerHTML =
    '<tr><th>Session</th><th>Scope</th><th>Idle left</th><th>Hard cap</th><th></th></tr>' +
    (rows.length
      ? rows
          .map((s) => {
            const idleLeft = s.idle_ms - (state.now - s.last_seen_at);
            const dead = s.status === 'ended' || idleLeft <= 0 || state.now >= s.absolute_expires_at;
            return `<tr>
          <td class="mono">${esc(s.id.slice(5, 13))}<div class="muted">${esc(s.seller_id)}</div></td>
          <td>${esc(s.intent)}<div class="muted">${esc(s.resource_id)}</div></td>
          <td>${dead ? '<span class="pill expired">expired</span>' : Math.max(0, Math.round(idleLeft / 1000)) + 's'}</td>
          <td>${rel(s.absolute_expires_at)}</td>
          <td>${dead ? '' : `<button class="tiny danger" data-end="${s.id}">end</button>`}</td>
        </tr>`;
          })
          .join('')
      : '<tr><td colspan="5" class="muted">No sessions yet.</td></tr>');
}

function renderEvents() {
  $('#events').innerHTML = state.events
    .map((e) => `<div class="event"><span class="t">${clockTime(e.at)}</span><span>${esc(e.message)}</span></div>`)
    .join('');
}

function renderAll() {
  renderClock();
  renderSendSettings();
  renderSignups();
  renderCampaign();
  renderSellers();
  renderIntents();
  renderMessages();
  renderTokens();
  renderSessions();
  renderEvents();
}

/* ------------------------------- actions -------------------------------- */

async function refresh() {
  try {
    state = await api('/api/state');
    renderAll();
  } catch (err) {
    /* signOut already handled on 401 */
  }
}

document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('button');
  if (!t) return;

  if (t.id === 'loginBtn') return signIn();
  if (t.id === 'logout') return signOut();

  if (t.dataset.send) {
    t.disabled = true;
    try {
      await api('/api/links', {
        method: 'POST',
        body: JSON.stringify({
          intent: t.dataset.send,
          resource_id: t.dataset.res,
          provider: send.provider,
          mode: send.mode,
          template: send.template,
          params: parsedParams() || []
        })
      });
    } catch (err) {
      alert('Could not issue link: ' + (err.body ? err.body.error : err.message));
    }
    t.disabled = false;
    return refresh();
  }

  if (t.dataset.campaignSend) {
    const id = t.dataset.campaignSend;
    const lots = t.dataset.intent === 'lot_select';
    const out = document.querySelector(`[data-cmsg="${id}"]${lots ? '.lots' : ':not(.lots)'}`);
    t.disabled = true;
    out.textContent = `sending via ${send.provider}…`;
    try {
      const r = await api('/api/campaign/send', {
        method: 'POST',
        body: JSON.stringify({
          seller_id: id,
          intent: lots ? 'lot_select' : 'seller_portal',
          provider: send.provider,
          mode: send.mode,
          // The lot template's names are fixed by its approval, so they come from
          // here rather than from the shared params box.
          template: lots ? LOT_TEMPLATE : send.template,
          params: lots ? LOT_PARAMS : parsedParams() || []
        })
      });
      out.className = 'small ' + (r.ok ? 'ok' : 'err');
      out.textContent = `${r.provider}/${r.send_mode} → HTTP ${r.status} ${String(r.response || '').slice(0, 160)}`;
    } catch (err) {
      out.className = 'small err';
      out.textContent = err.body ? JSON.stringify(err.body) : err.message;
    }
    t.disabled = false;
    return refresh();
  }

  if (t.dataset.broadcast) {
    const ids = [...selected];
    if (!ids.length) return alert('Pick at least one number first.');

    const def = (state.broadcasts || []).find((b) => b.key === t.dataset.broadcast);
    const out = $('#bcastOut');
    t.disabled = true;
    out.className = 'small muted';
    out.textContent = `sending to ${ids.length} number(s) via ${send.provider}…`;

    try {
      const r = await api('/api/campaign/broadcast', {
        method: 'POST',
        body: JSON.stringify({
          broadcast: def.key,
          seller_ids: ids,
          provider: send.provider,
          mode: send.mode,
          template: tplFor(def.key, def.template)
          // params deliberately omitted: each broadcast's own parameter names
          // travel with it on the server, so the shared params box - which
          // belongs to the rate template - can't corrupt them.
        })
      });
      lastBroadcast = `${def.label}: ${r.sent} sent, ${r.failed} failed`;
      // Kept per recipient, because a provider will happily accept nine and drop
      // one - and held in state, not in the DOM, so the 2s refresh doesn't erase
      // the only evidence of which one it dropped.
      for (const one of r.results) {
        bcastResults.set(one.seller_id, {
          ok: one.ok,
          text: `${def.label} → ${one.ok ? 'accepted' : 'failed'} ` +
            `${one.status == null ? '' : 'HTTP ' + one.status} ${String(one.response || '').slice(0, 120)}`
        });
      }
    } catch (err) {
      lastBroadcast = err.body ? JSON.stringify(err.body) : err.message;
    }
    t.disabled = false;
    return refresh();
  }

  if (t.dataset.copyUrl) {
    await navigator.clipboard.writeText(t.dataset.copyUrl);
    const was = t.textContent;
    t.textContent = 'copied';
    setTimeout(() => (t.textContent = was), 1200);
    return;
  }

  if (t.dataset.savePhone) {
    const input = document.querySelector(`[data-phone-for="${t.dataset.savePhone}"]`);
    try {
      await api(`/api/users/${t.dataset.savePhone}`, {
        method: 'PATCH',
        body: JSON.stringify({ wa_id: input.value.trim() })
      });
    } catch (err) {
      alert('Could not save number: ' + (err.body ? err.body.error : err.message));
    }
    return refresh();
  }

  if (t.dataset.revoke) {
    await api(`/api/tokens/${t.dataset.revoke}/revoke`, { method: 'POST' });
    return refresh();
  }

  if (t.dataset.end) {
    await api(`/api/ops/sessions/${t.dataset.end}/end`, { method: 'POST' });
    return refresh();
  }

  if (t.dataset.adv) {
    await api('/api/dev/clock', { method: 'POST', body: JSON.stringify({ advance_ms: Number(t.dataset.adv) }) });
    return refresh();
  }

  if (t.id === 'clockReset') {
    await api('/api/dev/clock', { method: 'POST', body: JSON.stringify({ reset: true }) });
    return refresh();
  }

  if (t.id === 'resetAll') {
    if (!confirm('Wipe tokens, sessions, messages and reseed test data?')) return;
    await api('/api/dev/reset', { method: 'POST' });
    return refresh();
  }

  if (t.id === 'copyToken') {
    await navigator.clipboard.writeText(bearer);
    t.textContent = 'copied';
    setTimeout(() => (t.textContent = 'copy bearer'), 1200);
  }

  if (t.id === 'copyCurl') {
    await navigator.clipboard.writeText(
      `curl -s ${location.origin}/api/state -H "Authorization: Bearer ${bearer}"`
    );
    t.textContent = 'copied';
    setTimeout(() => (t.textContent = 'copy curl'), 1200);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !$('#login').hidden) signIn();
});

/* --------------------------------- boot --------------------------------- */

function boot() {
  if (!bearer) {
    $('#login').hidden = false;
    $('#app').hidden = true;
    return;
  }
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#who').textContent = me ? `${me.name} (${me.role})` : '';
  refresh();
  clearInterval(timer);
  timer = setInterval(refresh, 2000);
}

boot();
