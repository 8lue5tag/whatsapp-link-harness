'use strict';

const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

const { db, applySellerPhones } = require('./src/db');
const clock = require('./src/clock');

const app = express();
const PORT = process.env.PORT || 3000;

// Restore the virtual clock so stored timestamps still line up after a restart.
clock.setOffset(db().clock_offset_ms || 0);

// Recreate the permanent campaign tokens. They are derived, not random, so the
// same three URLs come back after a restart, a redeploy or a wiped disk.
require('./src/campaign').ensureCampaignTokens();

// Real phone numbers, if pinned in the environment. Without this they revert to
// the fake seed values whenever the disk is wiped.
const phones = applySellerPhones(process.env);
if (phones.length) console.log('  phones  : ' + phones.join(', '));

// Behind cloudflared the origin is HTTPS but the hop to us is HTTP. Without this,
// req.protocol is "http" and every link we mint is unopenable in the WhatsApp webview.
app.set('trust proxy', true);

app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', extensions: ['html'] }));

app.use(require('./src/routes/api'));
app.use(require('./src/routes/link'));
app.use(require('./src/routes/seller'));
// Public and unauthenticated on purpose: /join is for people we have never seen.
app.use(require('./src/routes/signup'));

app.use((req, res) => res.status(404).json({ error: 'not_found', path: req.path }));

// Express 4 does not catch throws from async handlers, so one rejected promise
// would otherwise kill the process - and a dead process turns every WhatsApp CTA
// into a 404 that looks exactly like an expired token. Log loudly, keep serving.
app.use((err, req, res, next) => {
  console.error(`[error] ${req.method} ${req.path}:`, err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'server_error', detail: String((err && err.message) || err) });
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
});

app.listen(PORT, () => {
  console.log(`\n  WhatsApp link-token harness`);
  console.log(`  console : http://localhost:${PORT}/`);
  console.log(`  join    : http://localhost:${PORT}/join`);
  console.log(`  login   : ops@test.local / ops1234\n`);
});
