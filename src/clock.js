'use strict';

// Every time read in the app goes through now(). That lets the console fast-forward
// the world by 16 minutes or 8 days instead of making you sit and wait for a TTL.
let offsetMs = 0;

function now() {
  return Date.now() + offsetMs;
}

function advance(ms) {
  offsetMs += ms;
  return offsetMs;
}

function setOffset(ms) {
  offsetMs = ms;
  return offsetMs;
}

function getOffset() {
  return offsetMs;
}

module.exports = { now, advance, setOffset, getOffset };
