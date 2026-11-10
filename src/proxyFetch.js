/**
 * proxyFetch.js — fetch wrapper for grammy.
 *
 * Three mismatches between grammy 1.46 and this sandbox:
 * 1. grammy bundles node-fetch, which ignores the egress proxy env vars
 *    (https_proxy / NODE_USE_ENV_PROXY) and fails TLS with EPROTO
 *    ("wrong version number") because the sandbox requires a CONNECT tunnel.
 *    Node's built-in fetch honours the proxy env, so we use that instead.
 * 2. grammy hands fetch an AbortSignal from the `abort-controller` polyfill,
 *    which is not an instance of Node's global AbortSignal, and undici's
 *    fetch rejects it ("Expected signal to be an instance of AbortSignal").
 *    This wrapper bridges grammy's signal onto a genuine AbortController.
 * 3. POST requests to api.telegram.org HANG indefinitely from this sandbox
 *    (verified: curl POST hangs >60s, curl GET answers in ~1.2s; POST to
 *    other hosts such as boltbook.fun works). Telegram's Bot API accepts
 *    GET with query parameters for every method, so JSON POSTs are
 *    translated to GETs. This bot only sends text (no file uploads), so
 *    GET translation covers everything grammy does here.
 */
function stripHeaders(headers, names) {
  if (!headers) return headers;
  const lower = names.map((n) => n.toLowerCase());
  if (typeof headers.delete === 'function') {
    for (const n of lower) headers.delete(n);
    return headers;
  }
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!lower.includes(k.toLowerCase())) out[k] = v;
  }
  return out;
}

function translatePostToGet(url, init) {
  if ((init.method || 'GET').toUpperCase() !== 'POST') return null;
  const headers = init.headers || {};
  const ct =
    (typeof headers.get === 'function'
      ? headers.get('content-type')
      : headers['content-type'] || headers['Content-Type']) || '';
  if (!String(ct).includes('application/json')) return null;
  if (typeof init.body !== 'string') return null;
  let payload;
  try {
    payload = JSON.parse(init.body);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(payload)) {
    if (v === undefined || v === null) continue;
    params.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const qs = params.toString();
  const getUrl = qs ? url + (url.includes('?') ? '&' : '?') + qs : url;
  const getInit = { ...init, method: 'GET', body: undefined };
  delete getInit.body;
  getInit.headers = stripHeaders({ ...(headers || {}) }, ['content-type', 'content-length']);
  return { url: getUrl, init: getInit };
}

function createProxyFetch(fetchFn = globalThis.fetch) {
  const realFetch = fetchFn.bind(globalThis);
  return function proxyFetch(url, init = {}) {
    // node-fetch-only options are meaningless to undici; drop them.
    const { agent, compress, duplex, ...rest } = init;
    let reqUrl = url;
    let reqInit = rest;
    const translated = translatePostToGet(url, rest);
    if (translated) {
      reqUrl = translated.url;
      reqInit = translated.init;
    }
    // Bridge grammy's polyfilled AbortSignal to a genuine one.
    const sig = reqInit.signal;
    if (sig && !(sig instanceof AbortSignal)) {
      const ctrl = new AbortController();
      if (sig.aborted) {
        ctrl.abort(sig.reason);
      } else if (typeof sig.addEventListener === 'function') {
        sig.addEventListener('abort', () => ctrl.abort(sig.reason), { once: true });
      }
      reqInit = { ...reqInit, signal: ctrl.signal };
    }
    return realFetch(reqUrl, reqInit);
  };
}

module.exports = { createProxyFetch };
