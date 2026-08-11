'use strict';

// The material catalogue the first-run picker shows. Only PET Clear is live for
// this demo; the rest are listed deliberately, greyed out, so the picker reads as
// a real catalogue with one thing switched on rather than a one-option form.
//
// The server validates against SUPPORTED, so a hand-made request can't set a
// material we don't actually trade.
const SUPPORTED = ['PET Bottle Scrap Baled - Clear'];

const COMING_SOON = [
  'PET Bottle Scrap Baled - Mixed',
  'HDPE Drums - Regrind',
  'Mixed Paper - Grade A',
  'Aluminium Scrap - UBC',
  'E-waste - Mixed'
];

// What a brand-new buyer gets for everything they were never asked. They are
// editable on the price screen, so nobody is stuck with them - and it keeps the
// first run down to one tap plus a price.
function defaultProfile(now) {
  const DAY = 24 * 3600 * 1000;
  return {
    material: null, // null is the first-run marker the portal keys off
    location: 'Attibele',
    payment_days: 30,
    need_by: now + 7 * DAY,
    min_rating: 'Any',
    last_rate: null
  };
}

const isSupported = (m) => SUPPORTED.includes(String(m));

module.exports = { SUPPORTED, COMING_SOON, defaultProfile, isSupported };
