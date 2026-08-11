'use strict';

const crypto = require('crypto');
const { db, save } = require('./db');
const { now } = require('./clock');
const { logEvent } = require('./tokens');
const { defaultProfile } = require('./materials');
const { ensureCampaignTokens } = require('./campaign');

// The onboarding page is public - no token, no session - so the OTP is the only
// thing standing between a typed number and a row in the set. It is deliberately
// a fixed mock code, the same one the Replit prototype uses: a real OTP needs an
// approved authentication template and an already-opted-in number, which would
// dead-end every demo run at the second screen.
const MOCK_OTP = process.env.SIGNUP_OTP || '987654';

/**
 * Digits only, with an India country code on the front.
 *
 * Everything downstream - the provider adapters, the token rows, the console -
 * expects a bare `919876543210`, so normalising here means the rest of the
 * system never has to wonder which shape it got.
 */
function normalizePhone(raw) {
  let d = String(raw || '').replace(/[^0-9]/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = '91' + d;
  return d;
}

const isValidPhone = (wa) => /^[0-9]{12,15}$/.test(wa);

/** Signups are users, so this is the whole "set": one row per number, deduped. */
function allSignups() {
  return db().users.filter((u) => u.signup);
}

const findByPhone = (wa) => db().users.find((u) => u.signup && u.wa_id === wa);

// Stable, sequential ids. The permanent campaign token is derived from the id
// (see campaign.js), so an id must never be reused for a different person -
// hence max+1 rather than length+1.
function nextSeq() {
  const nums = allSignups()
    .map((u) => Number(String(u.id).replace(/^sg/, '')))
    .filter((n) => Number.isFinite(n));
  return nums.length ? Math.max(...nums) + 1 : 1;
}

// What the approval template puts in front of the buyer as "your customer ID",
// so it has to look like one - sg7 does not. Derived from the same sequence as
// the internal id, so the two never drift apart.
const custIdFor = (seq) => 'RM' + String(10000 + seq);

/**
 * Capture the number. Called the moment the OTP checks out, before the documents
 * step, precisely so an abandoned signup still leaves us a number to follow up -
 * which is the point of collecting the set at all.
 *
 * Idempotent by number: signing up twice from the same handset returns the same
 * row rather than minting a second one with a second permanent token.
 */
function captureSignup({ phone, name }) {
  const wa = normalizePhone(phone);
  if (!isValidPhone(wa)) return { error: 'bad_phone' };

  const existing = findByPhone(wa);
  if (existing) {
    // A returning number may be putting a name to itself for the first time.
    if (name && !existing.name_given) {
      existing.name = String(name).trim().slice(0, 60);
      existing.name_given = true;
      save();
    }
    return { user: existing, already: true };
  }

  const d = db();
  const seq = nextSeq();
  const id = 'sg' + seq;
  const person = String(name || '').trim().slice(0, 60);

  const user = {
    id,
    cust_id: custIdFor(seq),
    name: person || '+' + wa,
    name_given: !!person,
    // A login they can't use: the console's bearer auth matches email AND
    // password, and this password is never shown to anyone.
    email: `${wa}@signup.local`,
    password: crypto.randomBytes(9).toString('base64url'),
    role: 'seller',
    wa_id: wa,
    city: null,
    // The onboarding markers. `status` is what the approval broadcast flips.
    signup: true,
    status: 'pending',
    signed_up_at: now(),
    approved_at: null,
    docs: { gst: false, pan: false, pcb: false },
    docs_submitted_at: null,
    company: null,
    // material is null, which is what puts the portal into its first-run picker.
    profile: defaultProfile(now())
  };
  d.users.push(user);
  d.kyc.push({ id: 'K-' + id, seller_id: id, status: 'pending', account_last4: null });

  logEvent('signup.captured', `New signup +${wa}${person ? ' - ' + person : ''}`, { seller_id: id });
  save();

  // Mint the permanent portal and lot-deck tokens now, so the approval blast is
  // just the existing campaign send over a new list.
  ensureCampaignTokens();
  return { user, already: false };
}

/** The documents step. Mock uploads - we record that they happened, not the file. */
function submitDocuments({ id, company, docs }) {
  const user = db().users.find((u) => u.id === id && u.signup);
  if (!user) return { error: 'unknown_signup' };

  const given = docs || {};
  user.docs = { gst: !!given.gst, pan: !!given.pan, pcb: !!given.pcb };
  if (!(user.docs.gst && user.docs.pan && user.docs.pcb)) return { error: 'documents_incomplete' };

  user.docs_submitted_at = now();
  if (company) {
    user.company = String(company).trim().slice(0, 80);
    // The portal greets the business, not the person.
    user.profile.company = user.company;
  }

  const kyc = db().kyc.find((k) => k.seller_id === user.id);
  if (kyc) kyc.status = 'submitted';

  logEvent('signup.documents', `${user.name} submitted GST, PAN and PCB`, { seller_id: user.id });
  save();
  return { user };
}

/** Flipped by the approval broadcast, so "approved" always means "we told them". */
function markApproved(user) {
  if (user.status === 'approved') return;
  user.status = 'approved';
  user.approved_at = now();
  logEvent('signup.approved', `${user.name} approved and notified`, { seller_id: user.id });
  save();
}

module.exports = {
  MOCK_OTP,
  normalizePhone,
  isValidPhone,
  allSignups,
  findByPhone,
  captureSignup,
  submitDocuments,
  markApproved
};
