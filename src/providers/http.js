'use strict';

const TIMEOUT_MS = 15000;

const SECRET_KEYS = ['password', 'apikey', 'authkey', 'token', 'authorization'];

function redactObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SECRET_KEYS.includes(k.toLowerCase()) ? '***' : redactObject(v);
  }
  return out;
}

function redactForm(params) {
  const clone = new URLSearchParams(params);
  for (const k of [...clone.keys()]) {
    if (SECRET_KEYS.includes(k.toLowerCase())) clone.set(k, '***');
  }
  return clone.toString();
}

/**
 * One HTTP path for every provider, so each adapter only has to describe its
 * payload. Always returns - a provider that throws or hangs must never take the
 * process with it, because a dead process turns every CTA into a 404.
 */
async function request({ url, method = 'POST', headers = {}, form, json, multipart, timeoutMs = TIMEOUT_MS }) {
  let body;
  if (multipart) {
    // Let undici set the multipart boundary itself - never set content-type here.
    body = new FormData();
    for (const [k, v] of Object.entries(multipart)) body.append(k, String(v));
  } else if (form) {
    body = new URLSearchParams(form);
  } else if (json) {
    body = JSON.stringify(json);
  }

  const sentHeaders = {
    accept: 'application/json',
    ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    ...(json ? { 'content-type': 'application/json' } : {}),
    ...headers
  };

  const requestLog = JSON.stringify({
    url,
    method,
    headers: redactObject(sentHeaders),
    body: form ? redactForm(form) : json ? redactObject(json) : multipart ? redactObject(multipart) : null
  });

  try {
    const res = await fetch(url, {
      method,
      headers: sentHeaders,
      body,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await res.text();
    return { httpOk: res.ok, status: res.status, response: text, request: requestLog };
  } catch (err) {
    // Never reached the provider at all - worth distinguishing from a rejection.
    const why = err.name === 'TimeoutError' ? `timed out after ${timeoutMs}ms` : err.message;
    return { httpOk: false, status: 0, response: `request failed: ${why}`, request: requestLog };
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

module.exports = { request, parseJson, redactObject };
