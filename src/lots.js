'use strict';

const { db, save } = require('./db');
const { now } = require('./clock');

// Bump when the shape or the contents of the board change. An existing
// data/db.json (Render's disk, or a local one from an earlier build) re-seeds
// itself on the next boot instead of needing a manual reset.
const LOTS_VERSION = 2;

/**
 * The review deck. Marketplace-wide and reviewed one lot at a time: the buyer
 * approves or excludes each card, and the deck ends with a summary.
 *
 * Deliberately mixed - some lots have photos, some don't; some sellers are new,
 * some have history; some fields are missing on purpose so the "Not Provided" /
 * "TBD" states are exercised rather than imagined.
 */
function defaultLots() {
  return [
    {
      id: 'LTO52611014',
      material_code: 'PLASTICGHG',
      material: 'PET Bottle Scrap Baled - Clear',
      seller: 'PRATIBHA PLASTIC',
      new_seller: true,
      quantity_mt: 0.066,
      location: 'Chincholi',
      rate_per_kg: 24000,
      seller_rating: null,
      payment_terms_days: 15,
      photos: 2,
      past_orders: 0,
      geo_verified: null,
      distance_km: null,
      dispatch_window: null,
      logistic_cost: 'Included in price',
      tag: null
    },
    {
      id: 'LTO52611022',
      material_code: 'PLASTICPET',
      material: 'PET Bottle Scrap Baled - Mixed',
      seller: 'SRIRAM POLYMERS',
      new_seller: false,
      quantity_mt: 12.5,
      location: 'Hosur',
      rate_per_kg: 29,
      seller_rating: 7.4,
      payment_terms_days: 30,
      photos: 4,
      past_orders: 6,
      geo_verified: true,
      distance_km: 41,
      dispatch_window: '2-3 days',
      logistic_cost: 'Included in price',
      tag: 'PREFERRED'
    },
    {
      id: 'LTO52611037',
      material_code: 'PLASTICHDPE',
      material: 'HDPE Drums - Shredded',
      seller: 'KRISHNA POLY TRADERS',
      new_seller: false,
      quantity_mt: 3.5,
      location: 'Karimnagar',
      rate_per_kg: 28,
      seller_rating: 9.1,
      payment_terms_days: 30,
      photos: 9,
      past_orders: 14,
      geo_verified: true,
      distance_km: 118,
      dispatch_window: 'Next day',
      logistic_cost: 'Buyer to arrange',
      tag: null
    },
    {
      id: 'LTO52611048',
      material_code: 'PAPERMIX',
      material: 'Mixed Paper - Grade A',
      seller: 'DECCAN FIBRES',
      new_seller: false,
      quantity_mt: 12,
      location: 'Nashik MIDC',
      rate_per_kg: 12.5,
      seller_rating: 6.8,
      payment_terms_days: 45,
      photos: 3,
      past_orders: 2,
      geo_verified: false,
      distance_km: 620,
      dispatch_window: 'TBD',
      logistic_cost: 'Included in price',
      tag: null
    },
    {
      id: 'LTO52611055',
      material_code: 'METALUBC',
      material: 'Aluminium Scrap - UBC',
      seller: 'METRO METALS',
      new_seller: false,
      quantity_mt: 1.1,
      location: 'Kochi',
      rate_per_kg: 145,
      seller_rating: 9.6,
      payment_terms_days: 15,
      photos: 7,
      past_orders: 21,
      geo_verified: true,
      distance_km: 355,
      dispatch_window: 'Same day',
      logistic_cost: 'Included in price',
      tag: 'PREFERRED'
    },
    {
      id: 'LTO52611061',
      material_code: 'PLASTICLDPE',
      material: 'LDPE Film - Natural',
      seller: 'ANJALI ENTERPRISES',
      new_seller: true,
      quantity_mt: 6.4,
      location: 'Warangal',
      rate_per_kg: 41,
      seller_rating: 8.0,
      payment_terms_days: 30,
      photos: 0,
      past_orders: 0,
      geo_verified: null,
      distance_km: null,
      dispatch_window: null,
      logistic_cost: 'Included in price',
      tag: null
    },
    {
      id: 'LTO52611074',
      material_code: 'PLASTICPP',
      material: 'PP Woven Sacks - Baled',
      seller: 'GREENLOOP RECYCLERS',
      new_seller: false,
      quantity_mt: 4.8,
      location: 'Solapur',
      rate_per_kg: 36,
      seller_rating: 7.9,
      payment_terms_days: 30,
      photos: 5,
      past_orders: 4,
      geo_verified: true,
      distance_km: 210,
      dispatch_window: '2-3 days',
      logistic_cost: 'Buyer to arrange',
      tag: null
    },
    {
      id: 'LTO52611089',
      material_code: 'METALCOPPER',
      material: 'Copper Wire Scrap - Millberry',
      seller: 'RAHMAN METALS AND ALLOYS',
      new_seller: false,
      quantity_mt: 0.45,
      location: 'Kochi',
      rate_per_kg: 720,
      seller_rating: 9.2,
      payment_terms_days: 7,
      photos: 11,
      past_orders: 9,
      geo_verified: true,
      distance_km: 355,
      dispatch_window: 'Same day',
      logistic_cost: 'Included in price',
      tag: 'PREFERRED'
    },
    {
      id: 'LTO52611093',
      material_code: 'GLASSCULLET',
      material: 'Glass Cullet - Mixed Colour',
      seller: 'VINDHYA GLASS WORKS',
      new_seller: true,
      quantity_mt: 18.2,
      location: 'Rewa',
      rate_per_kg: 4.2,
      seller_rating: null,
      payment_terms_days: 45,
      photos: 1,
      past_orders: 0,
      geo_verified: false,
      distance_km: null,
      dispatch_window: null,
      logistic_cost: 'Buyer to arrange',
      tag: null
    },
    {
      id: 'LTO52611107',
      material_code: 'EWASTEPCB',
      material: 'E-waste - Low Grade PCB',
      seller: 'URBAN MINE SOLUTIONS',
      new_seller: false,
      quantity_mt: 2.3,
      location: 'Attibele, Bengaluru',
      rate_per_kg: 310,
      seller_rating: 8.6,
      payment_terms_days: 15,
      photos: 6,
      past_orders: 3,
      geo_verified: true,
      distance_km: 34,
      dispatch_window: 'Next day',
      logistic_cost: 'Included in price',
      tag: null
    }
  ];
}

function ensureLots() {
  const d = db();
  if (!Array.isArray(d.lots) || d.lots.length === 0 || d.lots_version !== LOTS_VERSION) {
    d.lots = defaultLots();
    d.lots_version = LOTS_VERSION;
    // The old board's decisions point at lot ids that no longer exist.
    d.lot_reviews = [];
    save();
  }
  if (!Array.isArray(d.lot_reviews)) {
    d.lot_reviews = [];
    save();
  }
  return d.lots;
}

/** The deck, in a fixed order so "Lot 4 of 10" means the same thing on a reopen. */
function allLots() {
  return ensureLots();
}

/** This buyer's decisions so far, as { [lot_id]: 'approved' | 'excluded' }. */
function decisionsFor(sellerId) {
  ensureLots();
  const out = {};
  for (const r of db().lot_reviews) {
    if (r.seller_id === sellerId) out[r.lot_id] = r.decision;
  }
  return out;
}

function recordDecision(sellerId, lotId, decision, sessionId) {
  const d = db();
  d.lot_reviews = d.lot_reviews.filter((r) => !(r.seller_id === sellerId && r.lot_id === lotId));
  d.lot_reviews.unshift({
    seller_id: sellerId,
    lot_id: lotId,
    decision,
    at: now(),
    session_id: sessionId || null
  });
  save();
  return decisionsFor(sellerId);
}

function clearDecisions(sellerId) {
  const d = db();
  const before = d.lot_reviews.length;
  d.lot_reviews = d.lot_reviews.filter((r) => r.seller_id !== sellerId);
  save();
  return before - d.lot_reviews.length;
}

module.exports = { ensureLots, allLots, decisionsFor, recordDecision, clearDecisions, defaultLots, LOTS_VERSION };
