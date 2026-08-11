'use strict';

const express = require('express');
const { db, save, reset } = require('../db');
const clock = require('../clock');
const { INTENTS, USE_ALERT_THRESHOLD } = require('../intents');
const { issueToken, revokeToken, sweep, logEvent, resourceFor, ownerOf } = require('../tokens');
const { issueBearer, requireBearer } = require('../auth');
const { sendTemplate, sendMode } = require('../whatsapp');
const { campaignLinks, campaignSecretFor, ensureCampaignTokens } = require('../campaign');
const { BROADCASTS } = require('../broadcasts');
const { allSignups, markApproved } = require('../signup');

const router = express.Router();
router.use(express.json());

function baseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

/** Ops-only powers: the clock, resets, other people's sessions. */
function requireOps(req, res, next) {
  if (req.user.role !== 'ops') return res.status(403).json({ error: 'ops_only', role: req.user.role });
  next();
}

const isOps = (user) => user.role === 'ops';

/**
 * A seller sees strictly their own data. This is enforced here rather than in the
 * browser, so a seller's bearer token cannot read another seller's listings even
 * with hand-made requests.
 */
function mine(user, rows, field) {
  return isOps(user) ? rows : rows.filter((r) => r[field || 'seller_id'] === user.id);
}

// Express 4 needs async throws handed to next() explicitly, or they escape as
// unhandled rejections and take the process with them.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ------------------------------- auth ---------------------------------- */

router.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db().users.find((u) => u.email === email && u.password === password);
  if (!user) return res.status(401).json({ error: 'bad_credentials' });
  logEvent('auth.login', `${user.name} signed in`, { user_id: user.id });
  save();
  res.json({
    token: issueBearer(user),
    user: { id: user.id, name: user.name, email: user.email, role: user.role, wa_id: user.wa_id }
  });
});

router.get('/api/me', requireBearer, (req, res) => {
  const u = req.user;
  res.json({ id: u.id, name: u.name, email: u.email, role: u.role, wa_id: u.wa_id });
});

/* ------------------------------- state --------------------------------- */

router.get('/api/state', requireBearer, (req, res) => {
  sweep();
  const d = db();

  // Signups get their own panel, so they are kept out of the seeded test-user
  // and campaign lists - otherwise both grow without limit as a demo runs.
  const links = campaignLinks(baseUrl(req), isOps(req.user) ? null : [req.user.id]);
  const signupIds = new Set(allSignups().map((u) => u.id));
  const linkFor = new Map(links.map((c) => [c.seller_id, c]));

  res.json({
    now: clock.now(),
    clock_offset_ms: clock.getOffset(),
    send_mode: sendMode(),
    use_alert_threshold: USE_ALERT_THRESHOLD,
    intents: Object.values(INTENTS).map((i) => ({
      key: i.key,
      label: i.label,
      resource: i.resource,
      ceiling_kind: i.ceilingKind,
      ceiling_ms: i.ceilingMs,
      renewable: i.renewable,
      step_up: i.stepUp,
      rationale: i.rationale
    })),
    me: { id: req.user.id, name: req.user.name, role: req.user.role },
    can: {
      move_clock: isOps(req.user),
      reset_data: isOps(req.user),
      see_all_sellers: isOps(req.user),
      end_any_session: isOps(req.user)
    },
    users: mine(req.user, d.users, 'id')
      .filter((u) => !u.signup)
      .map((u) => ({
        id: u.id,
        name: u.name,
        role: u.role,
        wa_id: u.wa_id,
        city: u.city
      })),
    // The captured set. One row per number, in signup order, each already
    // carrying the permanent link the approval blast will send.
    signups: isOps(req.user)
      ? allSignups().map((u) => ({
          id: u.id,
          // Shown because the approval message tells the buyer this is their
          // customer ID, so ops needs to be able to find it here.
          cust_id: u.cust_id || null,
          name: u.name,
          company: u.company,
          wa_id: u.wa_id,
          status: u.status,
          signed_up_at: u.signed_up_at,
          approved_at: u.approved_at,
          docs: u.docs,
          docs_submitted_at: u.docs_submitted_at,
          material: (u.profile && u.profile.material) || null,
          last_rate: (u.profile && u.profile.last_rate) || null,
          url: (linkFor.get(u.id) || {}).url || null,
          lots_url: (linkFor.get(u.id) || {}).lots_url || null,
          opened: (linkFor.get(u.id) || {}).use_count || 0
        }))
      : [],
    broadcasts: Object.values(BROADCASTS).map((b) => ({
      key: b.key,
      label: b.label,
      intent: b.intent,
      template: b.template,
      params: b.params,
      approves: !!b.approves
    })),
    requirements: mine(req.user, d.requirements || []),
    listings: mine(req.user, d.listings),
    bids: mine(req.user, d.bids),
    kyc: mine(req.user, d.kyc),
    // token_hash is never returned - the console sees the ledger, not the secret
    tokens: mine(req.user, d.tokens).map(({ token_hash, ...rest }) => rest),
    sessions: mine(req.user, d.sessions),
    messages: mine(req.user, d.messages),
    otps: isOps(req.user) ? d.otps.slice(0, 10) : [],
    // A seller's log is only their own activity.
    events: isOps(req.user)
      ? d.events.slice(0, 60)
      : d.events.filter((e) => JSON.stringify(e.meta || {}).includes(req.user.id)).slice(0, 60),
    campaign: links.filter((c) => !signupIds.has(c.seller_id)),
    join_url: `${baseUrl(req)}/join`
  });
});

/* ------------------------------- links --------------------------------- */

router.post('/api/links', requireBearer, wrap(async (req, res) => {
  const { intent, resource_id, provider, mode, template, params } = req.body || {};

  // A seller may only mint links for resources they own.
  const def = INTENTS[intent];
  if (!def) return res.status(409).json({ error: 'unknown_intent' });
  const target = resourceFor(def, resource_id);
  if (!target) return res.status(409).json({ error: 'unknown_resource' });
  if (!isOps(req.user) && ownerOf(def, target) !== req.user.id) {
    return res.status(403).json({ error: 'not_your_resource' });
  }

  const issued = issueToken({ intentKey: intent, resourceId: resource_id, actor: req.user.id });
  if (issued.error) return res.status(409).json({ error: issued.error });

  const msg = await sendTemplate({
    seller: issued.seller,
    intent: issued.intent,
    resource: issued.resource,
    secret: issued.secret,
    baseUrl: baseUrl(req),
    // Chosen per send, so the same link can be fired at each provider in turn.
    send: { provider, mode, template, params }
  });

  res.json({
    ok: true,
    token: { ...issued.row, token_hash: undefined },
    // The raw secret exists exactly once, here, on its way into the message.
    url: msg.url,
    message_id: msg.id
  });
}));

router.post('/api/tokens/:id/revoke', requireBearer, (req, res) => {
  const existing = db().tokens.find((t) => t.id === req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  if (!isOps(req.user) && existing.seller_id !== req.user.id) {
    return res.status(403).json({ error: 'not_your_token' });
  }
  const out = revokeToken(req.params.id, isOps(req.user) ? 'ops_manual' : 'seller_manual');
  if (out.error) return res.status(404).json(out);
  res.json({ ok: true, token: { ...out.row, token_hash: undefined } });
});

/**
 * Set a test user's real phone number. Nothing reaches a real handset until this
 * is a number that has opted in to your Gupshup app.
 */
router.patch('/api/users/:id', requireBearer, (req, res) => {
  const user = db().users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'not_found' });
  if (!isOps(req.user) && user.id !== req.user.id) {
    return res.status(403).json({ error: 'not_your_profile' });
  }
  const wa = String((req.body && req.body.wa_id) || '').replace(/[^0-9]/g, '');
  if (wa && wa.length < 10) return res.status(400).json({ error: 'wa_id_too_short' });
  user.wa_id = wa || null;
  save();
  logEvent('user.updated', `${user.name} phone set to ${wa ? '+' + wa : '(none)'}`, { user_id: user.id });
  res.json({ ok: true, user: { id: user.id, name: user.name, wa_id: user.wa_id } });
});

/* ------------------- ops-side state changes (revocation) ---------------- */

router.post('/api/ops/sessions/:id/end', requireBearer, requireOps, (req, res) => {
  const s = db().sessions.find((x) => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'not_found' });
  s.status = 'ended';
  save();
  logEvent('session.ended', `Session ${s.id} ended by ops`, { session_id: s.id });
  res.json({ ok: true });
});

/* ------------------------- harness controls ----------------------------- */

router.post('/api/dev/clock', requireBearer, requireOps, (req, res) => {
  const { advance_ms, reset: doReset } = req.body || {};
  if (doReset) clock.setOffset(0);
  else clock.advance(Number(advance_ms) || 0);
  db().clock_offset_ms = clock.getOffset();
  sweep();
  logEvent('clock.changed', `Virtual clock offset now ${Math.round(clock.getOffset() / 60000)} min`, null);
  save();
  res.json({ ok: true, now: clock.now(), clock_offset_ms: clock.getOffset() });
});

router.post('/api/dev/reset', requireBearer, requireOps, (req, res) => {
  reset();
  clock.setOffset(0);
  // Reseeding wipes the ledger, so put the permanent campaign tokens back.
  require('../campaign').ensureCampaignTokens();
  res.json({ ok: true });
});

/**
 * Ask WATI what templates exist and what variables they declare. WATI parameters
 * are named, so guessing the names is the usual reason a template send fails.
 */
router.get('/api/providers/wati/templates', requireBearer, requireOps, wrap(async (req, res) => {
  const wati = require('../providers/wati');
  const cfg = wati.config(process.env);
  const missing = wati.missing(cfg);
  if (missing.length) return res.status(409).json({ error: 'missing_config', missing });

  const out = await wati.listTemplates({ cfg });
  const list = out.json && (out.json.messageTemplates || out.json.result || out.json.data);
  res.json({
    ok: out.ok,
    status: out.status,
    templates: Array.isArray(list)
      ? list.map((t) => ({
          name: t.elementName || t.name,
          status: t.status,
          category: t.category,
          language: t.language && (t.language.text || t.language.key || t.language),
          body: t.body || (t.data && t.data.slice && t.data.slice(0, 200)),
          // The names you must use in `params`.
          variables: (t.customParams || t.parameters || []).map((p) => p.paramName || p.name)
        }))
      : null,
    raw: Array.isArray(list) ? undefined : String(out.response).slice(0, 800)
  });
}));

/** The pasteable campaign URLs. Sellers see only their own. */
router.get('/api/campaign', requireBearer, (req, res) => {
  res.json({ links: campaignLinks(baseUrl(req), isOps(req.user) ? null : [req.user.id]) });
});

/**
 * Send the EXISTING permanent campaign link through a provider. Deliberately
 * separate from /api/links, which mints a new token - here the whole point is
 * that the URL is the same one you pasted into your campaign.
 */
router.post('/api/campaign/send', requireBearer, wrap(async (req, res) => {
  const { seller_id, provider, mode, template, params } = req.body || {};
  const seller = db().users.find((u) => u.id === seller_id && u.role === 'seller');
  if (!seller) return res.status(404).json({ error: 'unknown_seller' });
  if (!isOps(req.user) && seller.id !== req.user.id) {
    return res.status(403).json({ error: 'not_your_profile' });
  }

  // Which of the two campaign links to send. Each has its own token, its own
  // page and its own approved template, so this picks all three at once.
  const intentKey = (req.body && req.body.intent) === 'lot_select' ? 'lot_select' : 'seller_portal';

  ensureCampaignTokens();
  const msg = await sendTemplate({
    seller,
    intent: INTENTS[intentKey],
    resource: seller,
    secret: campaignSecretFor(seller.id, intentKey),
    baseUrl: baseUrl(req),
    note: 'campaign link',
    send: { provider, mode, template, params }
  });

  res.json({
    ok: msg.provider_ok !== false,
    url: msg.url,
    provider: msg.provider,
    send_mode: msg.send_mode,
    status: msg.provider_status,
    response: msg.provider_response
  });
}));

/**
 * One of the three onboarding messages, to a chosen set of signups.
 *
 * Deliberately a loop over the same sendTemplate that a single send uses, rather
 * than a bulk provider API: every recipient gets their own row in the ledger with
 * its own raw request and response, which is the only way to see that a provider
 * accepted twenty and delivered nineteen.
 *
 * Sends are sequential on purpose. Providers rate-limit, and a burst of parallel
 * posts is the fastest way to turn a working broadcast into a wall of 429s.
 */
router.post('/api/campaign/broadcast', requireBearer, requireOps, wrap(async (req, res) => {
  const { broadcast, seller_ids, provider, mode, template, params } = req.body || {};
  const def = BROADCASTS[broadcast];
  if (!def) return res.status(409).json({ error: 'unknown_broadcast' });

  const ids = Array.isArray(seller_ids) ? seller_ids : [];
  if (!ids.length) return res.status(400).json({ error: 'no_recipients' });

  ensureCampaignTokens();
  const intent = INTENTS[def.intent];
  const results = [];

  for (const id of ids) {
    const seller = db().users.find((u) => u.id === id && u.role === 'seller');
    if (!seller) {
      results.push({ seller_id: id, ok: false, response: 'unknown_seller' });
      continue;
    }

    const msg = await sendTemplate({
      seller,
      intent,
      resource: seller,
      secret: campaignSecretFor(seller.id, def.intent),
      baseUrl: baseUrl(req),
      note: def.label,
      send: {
        provider,
        mode,
        // The console may override the template name - a broadcast's default is
        // only the name we expect you to have approved.
        template: template || def.template,
        params: params && params.length ? params : def.params,
        copy: def.copy
      }
    });

    // Only after the send: "approved" should never be able to mean "we changed a
    // flag but the message never left".
    if (def.approves && msg.provider_ok !== false && seller.signup) markApproved(seller);

    results.push({
      seller_id: seller.id,
      name: seller.name,
      wa_id: seller.wa_id,
      ok: msg.provider_ok !== false,
      status: msg.provider_status,
      response: msg.provider_response,
      url: msg.url
    });
  }

  res.json({
    ok: results.every((r) => r.ok),
    broadcast: def.key,
    sent: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results
  });
}));

module.exports = router;
