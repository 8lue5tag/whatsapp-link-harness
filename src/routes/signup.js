'use strict';

const express = require('express');
const crypto = require('crypto');
const { logEvent } = require('../tokens');
const { db, save } = require('../db');
const { now } = require('../clock');
const {
  MOCK_OTP,
  normalizePhone,
  isValidPhone,
  findByPhone,
  captureSignup,
  submitDocuments
} = require('../signup');

const router = express.Router();
router.use(express.json());

// Everything below is PUBLIC. No bearer, no session cookie - a person arriving
// at /join is by definition someone we have never seen, so there is nothing yet
// to authenticate them with. The OTP is the gate, and this ticket is what keeps
// the documents step from being "POST any id you like".
const TICKET_SECRET = process.env.SIGNUP_SECRET || process.env.JWT_SECRET || 'dev-only-harness-secret';

const ticketFor = (id) =>
  crypto.createHmac('sha256', TICKET_SECRET).update('signup:' + id).digest('base64url').slice(0, 22);

function ticketOk(id, ticket) {
  const want = Buffer.from(ticketFor(id));
  const got = Buffer.from(String(ticket || ''));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

/**
 * Step 1. We do not send anything - the code is fixed (see signup.js) - but the
 * request is still recorded, because "how many people started and never
 * finished" is the number this whole flow exists to move.
 */
router.post('/api/signup/otp', (req, res) => {
  const wa = normalizePhone(req.body && req.body.phone);
  if (!isValidPhone(wa)) return res.status(400).json({ error: 'bad_phone' });

  const d = db();
  d.otps.unshift({
    id: 'otp_' + crypto.randomBytes(4).toString('hex'),
    session_id: null,
    signup_phone: wa,
    code: MOCK_OTP,
    created_at: now(),
    used: false
  });
  d.otps = d.otps.slice(0, 40);
  logEvent('signup.otp', `Onboarding OTP requested by +${wa}`, { wa_id: wa });
  save();

  // Harness only, and the page shows it as a hint - exactly like the prototype.
  res.json({ ok: true, dev_code: MOCK_OTP });
});

/**
 * Step 2. The number goes into the set here, not at the end: someone who verifies
 * and then abandons the documents screen is still a lead we can message.
 */
router.post('/api/signup/verify', (req, res) => {
  const { phone, code, name } = req.body || {};
  if (String(code || '') !== MOCK_OTP) return res.status(401).json({ error: 'bad_otp' });

  const out = captureSignup({ phone, name });
  if (out.error) return res.status(400).json({ error: out.error });

  res.json({
    ok: true,
    id: out.user.id,
    ticket: ticketFor(out.user.id),
    name: out.user.name,
    already: out.already,
    // A returning number that already finished gets told so, rather than being
    // walked through the documents again.
    docs_done: !!out.user.docs_submitted_at,
    status: out.user.status
  });
});

/** Step 3. Mock uploads: we record that all three happened, never a file. */
router.post('/api/signup/documents', (req, res) => {
  const { id, ticket, company, docs } = req.body || {};
  if (!id || !ticketOk(id, ticket)) return res.status(403).json({ error: 'bad_ticket' });

  const out = submitDocuments({ id, company, docs });
  if (out.error) return res.status(out.error === 'unknown_signup' ? 404 : 400).json(out);

  res.json({ ok: true, status: out.user.status });
});

/**
 * Whether this handset has already been through the flow. Lets /join reopen on
 * the "we'll get back to you" screen instead of asking for the same number
 * twice - the page is a permanent public URL, so re-taps are normal.
 */
router.get('/api/signup/status', (req, res) => {
  const wa = normalizePhone(req.query.phone);
  const user = isValidPhone(wa) ? findByPhone(wa) : null;
  if (!user) return res.json({ known: false });
  res.json({
    known: true,
    status: user.status,
    docs_done: !!user.docs_submitted_at,
    name: user.name
  });
});

module.exports = router;
