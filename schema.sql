-- Harness schema. Timestamps are epoch milliseconds.
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS listings;
DROP TABLE IF EXISTS bids;
DROP TABLE IF EXISTS kyc;
DROP TABLE IF EXISTS tokens;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS bearers;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS otps;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS meta;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT, email TEXT UNIQUE, password TEXT,
  role TEXT, wa_id TEXT, city TEXT
);

CREATE TABLE listings (
  id TEXT PRIMARY KEY,
  seller_id TEXT, title TEXT, status TEXT,
  pickup_at INTEGER, draft_notes TEXT DEFAULT '',
  pickup_confirmed INTEGER DEFAULT 0
);

CREATE TABLE bids (
  id TEXT PRIMARY KEY,
  listing_id TEXT, seller_id TEXT, amount INTEGER,
  buyer TEXT, status TEXT, settled_at INTEGER
);

CREATE TABLE kyc (
  id TEXT PRIMARY KEY,
  seller_id TEXT, status TEXT, account_last4 TEXT
);

-- Only the SHA-256 of a token is ever stored.
CREATE TABLE tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE,
  hint TEXT,
  seller_id TEXT, wa_id TEXT,
  intent TEXT, resource_id TEXT,
  issued_at INTEGER,
  expires_at INTEGER,        -- absolute ceiling, written once, never updated
  use_count INTEGER DEFAULT 0,
  last_used_at INTEGER,
  fraud_alert INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  issued_by TEXT,
  revoke_reason TEXT
);
CREATE INDEX idx_tokens_hash ON tokens(token_hash);
CREATE INDEX idx_tokens_scope ON tokens(seller_id, intent, resource_id, status);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  seller_id TEXT, intent TEXT, resource_id TEXT, token_id TEXT,
  created_at INTEGER, last_seen_at INTEGER,
  idle_ms INTEGER, absolute_expires_at INTEGER,
  otp_verified_at INTEGER, status TEXT DEFAULT 'active'
);

CREATE TABLE bearers (
  token TEXT PRIMARY KEY,
  user_id TEXT, created_at INTEGER
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  at INTEGER, wa_id TEXT, seller_id TEXT,
  template TEXT, body TEXT, button_label TEXT, url TEXT,
  intent TEXT, resource_id TEXT, note TEXT,
  channel TEXT,              -- simulate | gupshup_selfserve | gupshup_enterprise
  provider_ok INTEGER,
  provider_status INTEGER,
  provider_response TEXT,
  provider_request TEXT
);

CREATE TABLE otps (
  id TEXT PRIMARY KEY,
  session_id TEXT, code TEXT, created_at INTEGER, used INTEGER DEFAULT 0
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  at INTEGER, type TEXT, message TEXT, detail TEXT
);

CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);

-- ---------------------------------------------------------------- seed ----
INSERT INTO users VALUES
  ('s1','Ramesh Kumar','ramesh@test.local','test1234','seller','919876500001','Warangal'),
  ('s2','Sunita Patil','sunita@test.local','test1234','seller','919876500002','Nashik'),
  ('s3','Iqbal Rahman','iqbal@test.local','test1234','seller','919876500003','Kochi'),
  ('ops1','Ops Console','ops@test.local','ops1234','ops',NULL,NULL);

INSERT INTO listings (id,seller_id,title,status,pickup_at) VALUES
  ('L-1001','s1','8.2 MT PET bottles - Warangal','draft', (unixepoch()*1000) + 172800000),
  ('L-1002','s1','3.5 MT HDPE drums - Karimnagar','draft', (unixepoch()*1000) + 21600000),
  ('L-1003','s2','12 MT mixed paper - Nashik','draft', (unixepoch()*1000) + 259200000),
  ('L-1004','s3','1.1 MT aluminium scrap - Kochi','draft', (unixepoch()*1000) + 93600000);

INSERT INTO bids (id,listing_id,seller_id,amount,buyer,status) VALUES
  ('B-2001','L-1001','s1',42000,'Sriram Polymers','open'),
  ('B-2002','L-1003','s2',186000,'Deccan Fibres','open'),
  ('B-2003','L-1004','s3',97500,'Metro Metals','open');

INSERT INTO kyc VALUES
  ('K-s1','s1','pending',NULL),
  ('K-s2','s2','pending',NULL),
  ('K-s3','s3','pending',NULL);

INSERT INTO meta VALUES
  ('clock_offset_ms','0'),
  -- Per-intent Gupshup template config, editable from the console.
  -- params is a JSON array; {{token}} and {{url}} are substituted at send time.
  ('tpl_listing_draft','{"template_id":"","params":["{{token}}"]}'),
  ('tpl_pickup_slot','{"template_id":"","params":["{{token}}"]}'),
  ('tpl_bid_response','{"template_id":"","params":["{{token}}"]}'),
  ('tpl_kyc','{"template_id":"","params":["{{token}}"]}'),
  ('send_mode','');
