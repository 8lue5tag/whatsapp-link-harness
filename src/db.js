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

module.exports = { db, save, reset, load, DB_FILE };
