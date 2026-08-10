'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

let data = null;

function seed() {
  const t = Date.now();
  return {
    clock_offset_ms: 0,
    users: [
      {
        id: 's1',
        name: 'Ramesh Kumar',
        email: 'ramesh@test.local',
        password: 'test1234',
        role: 'seller',
        wa_id: '919876500001',
        city: 'Warangal'
      },
      {
        id: 's2',
        name: 'Sunita Patil',
        email: 'sunita@test.local',
        password: 'test1234',
        role: 'seller',
        wa_id: '919876500002',
        city: 'Nashik'
      },
      {
        id: 's3',
        name: 'Iqbal Rahman',
        email: 'iqbal@test.local',
        password: 'test1234',
        role: 'seller',
        wa_id: '919876500003',
        city: 'Kochi'
      },
      {
        id: 'ops1',
        name: 'Ops Console',
        email: 'ops@test.local',
        password: 'ops1234',
        role: 'ops',
        wa_id: null,
        city: null
      }
    ],
    listings: [
      {
        id: 'L-1001',
        seller_id: 's1',
        title: '8.2 MT PET bottles - Warangal',
        status: 'draft',
        pickup_at: t + 2 * DAY,
        rate_per_kg: 32,
        draft_notes: ''
      },
      {
        id: 'L-1002',
        seller_id: 's1',
        title: '3.5 MT HDPE drums - Karimnagar',
        status: 'draft',
        pickup_at: t + 6 * HOUR,
        rate_per_kg: 28,
        draft_notes: ''
      },
      {
        id: 'L-1003',
        seller_id: 's2',
        title: '12 MT mixed paper - Nashik',
        status: 'draft',
        pickup_at: t + 3 * DAY,
        rate_per_kg: 12,
        draft_notes: ''
      },
      {
        id: 'L-1004',
        seller_id: 's3',
        title: '1.1 MT aluminium scrap - Kochi',
        status: 'draft',
        pickup_at: t + 26 * HOUR,
        rate_per_kg: 145,
        draft_notes: ''
      }
    ],
    bids: [
      { id: 'B-2001', listing_id: 'L-1001', seller_id: 's1', amount: 42000, buyer: 'Sriram Polymers', status: 'open' },
      { id: 'B-2002', listing_id: 'L-1003', seller_id: 's2', amount: 186000, buyer: 'Deccan Fibres', status: 'open' },
      { id: 'B-2003', listing_id: 'L-1004', seller_id: 's3', amount: 97500, buyer: 'Metro Metals', status: 'open' }
    ],
    kyc: [
      { id: 'K-s1', seller_id: 's1', status: 'pending', account_last4: null },
      { id: 'K-s2', seller_id: 's2', status: 'pending', account_last4: null },
      { id: 'K-s3', seller_id: 's3', status: 'pending', account_last4: null }
    ],
    tokens: [],
    sessions: [],
    messages: [],
    otps: [],
    events: []
  };
}

function load() {
  if (data) return data;
  try {
    data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (err) {
    data = seed();
    save();
  }
  return data;
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function reset() {
  data = seed();
  save();
  return data;
}

function db() {
  return load();
}

/**
 * Real phone numbers, pinned in the environment rather than typed into the UI.
 *
 * Render's free disk is wiped on every restart and every idle spin-down, so a
 * number entered in the console silently reverts to the fake seed value. Setting
 * SELLER_PHONES makes it survive:
 *
 *   SELLER_PHONES=s1=919876543210,s2=919812345678,s3=919800000000
 *
 * Keys may be a seller id (s1) or an email (ramesh@test.local). Anything
 * non-numeric in the value is stripped, so +91 98765 43210 is fine.
 */
function applySellerPhones(env) {
  const spec = String((env && env.SELLER_PHONES) || '').trim();
  if (!spec) return [];

  const d = load();
  const applied = [];
  for (const pair of spec.split(',')) {
    const [rawKey, rawVal] = pair.split('=');
    if (!rawKey || !rawVal) continue;
    const key = rawKey.trim().toLowerCase();
    const wa = rawVal.replace(/[^0-9]/g, '');
    if (wa.length < 10) continue;

    const user = d.users.find((u) => u.id.toLowerCase() === key || String(u.email).toLowerCase() === key);
    if (!user) continue;
    user.wa_id = wa;
    applied.push(`${user.name} -> +${wa}`);
  }
  if (applied.length) save();
  return applied;
}

module.exports = { db, save, reset, load, applySellerPhones, DB_FILE };
