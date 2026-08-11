'use strict';

const express = require('express');
const path = require('path');
const { db } = require('../db');
const { redeemToken, issueToken, hashToken, resourceFor } = require('../tokens');
const { INTENTS } = require('../intents');
const { createSession } = require('../auth');
const { sendTemplate } = require('../whatsapp');

const router = express.Router();
const PUBLIC = path.join(__dirname, '..', '..', 'public');

function baseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

// Where each intent lands once its token has been redeemed. A campaign token
// opens a whole screen (price or lot board); a task token opens its one task.
const PAGES = { seller_portal: '/portal.html', lot_select: '/lots.html' };

/**
 * The landing route. Hash the incoming token, look it up, check the ceiling,
 * and on success mint a scoped session cookie. The token has now done its job.
 *
 * Mounted on more than one base, because a Meta template freezes its URL base at
 * approval and the base is the only part that can't change afterwards:
 *
 *   /s/{{1}}    - the original, frozen into the approved price-screen template
 *   /lots/{{1}} - for the lot-review template
 *
 * The destination still comes from the token's intent, not from the path, so a
 * token opens the same page whichever base it arrives on. The separate bases are
 * for legibility in the template builder, not for routing.
 */
function landing(req, res) {
  const secret = req.params.token;
  const result = redeemToken(secret);

  if (!result.ok) {
    const q = new URLSearchParams({ reason: result.reason, t: secret });
    return res.redirect('/expired.html?' + q.toString());
  }

  createSession(res, result.row);
  const q = new URLSearchParams({ intent: result.row.intent, r: result.row.resource_id });
  const page = PAGES[result.row.intent] || '/land.html';
  return res.redirect(page + '?' + q.toString());
}

router.get('/s/:token', landing);
router.get('/lots/:token', landing);

/**
 * The dead-link page's only button. Looks the old token up by hash (whatever its
 * status), and issues a fresh one for the same seller / intent / resource.
 */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.post('/api/link/resend', express.json(), wrap(async (req, res) => {
  const secret = (req.body && req.body.t) || '';
  const row = db().tokens.find((t) => t.token_hash === hashToken(secret));
  if (!row) return res.status(404).json({ error: 'unknown_token' });

  const issued = issueToken({ intentKey: row.intent, resourceId: row.resource_id, actor: 'seller_resend' });
  if (issued.error) return res.status(409).json({ error: issued.error });

  const msg = await sendTemplate({
    seller: issued.seller,
    intent: issued.intent,
    resource: issued.resource,
    secret: issued.secret,
    baseUrl: baseUrl(req),
    note: 'resent from dead-link page'
  });
  res.json({ ok: true, message_id: msg.id, wa_id: issued.seller.wa_id });
}));

/** Context for the dead-link page, so it can name the task without leaking much. */
router.get('/api/link/context', (req, res) => {
  const row = db().tokens.find((t) => t.token_hash === hashToken(req.query.t || ''));
  if (!row) return res.json({ known: false });
  const intent = INTENTS[row.intent];
  const resource = resourceFor(intent, row.resource_id);
  res.json({
    known: true,
    intent: intent.key,
    intent_label: intent.label,
    status: row.status,
    expires_at: row.expires_at,
    title: (resource && resource.title) || row.resource_id
  });
});

router.get('/land.html', (req, res) => res.sendFile(path.join(PUBLIC, 'land.html')));
router.get('/portal.html', (req, res) => res.sendFile(path.join(PUBLIC, 'portal.html')));
router.get('/lots.html', (req, res) => res.sendFile(path.join(PUBLIC, 'lots.html')));

module.exports = router;
