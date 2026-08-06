'use strict';

const $ = (sel) => document.querySelector(sel);
let bearer = localStorage.getItem('bearer') || '';
let me = JSON.parse(localStorage.getItem('me') || 'null');
let state = null;
let timer = null;

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
  if (ms == null) return '—';
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

  const m = state.send_mode;
  const badge = $('#mode');
  const broken = m.mode !== 'simulate' && m.missing.length;
  badge.textContent = broken ? `${m.mode} — missing ${m.missing.join(', ')}` : m.mode;
  badge.className = 'pill ' + (broken ? 'revoked' : m.mode === 'simulate' ? '' : 'active');
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
        <div class="time">to +${esc(m.wa_id)} &middot; ${clockTime(m.at)} &middot; ${esc(m.channel)}</div>
        ${m.channel === 'simulate' ? '' : `
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
        body: JSON.stringify({ intent: t.dataset.send, resource_id: t.dataset.res })
      });
    } catch (err) {
      alert('Could not issue link: ' + (err.body ? err.body.error : err.message));
    }
    t.disabled = false;
    return refresh();
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
