'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns');
const https = require('node:https');
const net = require('node:net');

const USER_AGENT = 'odinsons-registry-ci (+https://github.com/odin-sons/launcher-server-registry)';

class FetchError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'FetchError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
];

function v4ToInt(address) {
  return address.split('.').reduce((total, part) => total * 256 + Number(part), 0);
}

function isBlockedV4(address) {
  const value = v4ToInt(address);
  return V4_BLOCKS.some(([base, bits]) => {
    const size = 2 ** (32 - bits);
    return value >= v4ToInt(base) && value < v4ToInt(base) + size;
  });
}

function v6ToBigInt(address) {
  let text = address.split('%')[0].toLowerCase();
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const value = v4ToInt(tail[1]);
    text = text.slice(0, tail.index) + ((value >>> 16) & 0xffff).toString(16) + ':' + (value & 0xffff).toString(16);
  }
  const [head, rest] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = rest === undefined ? [] : rest ? rest.split(':') : [];
  const fill = rest === undefined ? [] : Array(8 - left.length - right.length).fill('0');
  const groups = [...left, ...fill, ...right];
  if (groups.length !== 8) throw new Error('bad IPv6');
  return groups.reduce((total, group) => (total << 16n) | BigInt(parseInt(group, 16)), 0n);
}

function inV6(value, base, bits) {
  const shift = BigInt(128 - bits);
  return value >> shift === v6ToBigInt(base) >> shift;
}

function v4FromBits(value, shift) {
  const v4 = Number((value >> BigInt(shift)) & 0xffffffffn);
  return [v4 >>> 24, (v4 >>> 16) & 255, (v4 >>> 8) & 255, v4 & 255].join('.');
}

/** True for every address that is not a public unicast address. Unparseable input counts as blocked. */
function isBlockedAddress(address) {
  try {
    const family = net.isIP(address);
    if (family === 4) return isBlockedV4(address);
    if (family !== 6) return true;
    const value = v6ToBigInt(address);
    if (value === 0n || value === 1n) return true;
    if (inV6(value, '::ffff:0:0', 96) || inV6(value, '64:ff9b::', 96)) return isBlockedV4(v4FromBits(value, 0));
    if (inV6(value, '2002::', 16)) return isBlockedV4(v4FromBits(value, 80));
    return [
      ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['fc00::', 7],
      ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]
    ].some(([base, bits]) => inV6(value, base, bits));
  } catch {
    return true;
  }
}

function parseHttpsUrl(input, { requireHttps = true } = {}) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new FetchError('BAD_URL', 'Not a valid URL.');
  }
  if (requireHttps && url.protocol !== 'https:') throw new FetchError('BAD_URL', 'Only https URLs are allowed.');
  if (url.username || url.password) throw new FetchError('BAD_URL', 'URLs with credentials are not allowed.');
  if (!url.hostname) throw new FetchError('BAD_URL', 'The URL has no host.');
  return url;
}

const RETRYABLE = new Set(['NETWORK', 'TIMEOUT']);

/**
 * A downloader for URLs that come from untrusted entries: https only, no credentials, a bounded number of
 * redirects (each one re-checked), no private or loopback addresses (checked on the address that is actually
 * connected to), a hard size limit enforced while the body streams, and a deadline.
 */
function createFetcher(options = {}) {
  const requestImpl = options.request || https.request;
  const lookupImpl = options.lookup || dns.lookup;
  const isBlocked = options.isBlocked || isBlockedAddress;
  const requireHttps = options.requireHttps !== false;

  function safeLookup(hostname, lookupOptions, callback) {
    if (typeof lookupOptions === 'function') {
      callback = lookupOptions;
      lookupOptions = {};
    }
    lookupImpl(hostname, { ...lookupOptions, all: true }, (error, addresses) => {
      if (error) return callback(error);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(addresses) }];
      if (list.length === 0) return callback(new FetchError('NETWORK', 'The host has no address.'));
      const blocked = list.find((item) => isBlocked(item.address));
      if (blocked) return callback(new FetchError('BLOCKED_ADDRESS', 'The host resolves to a private or reserved address.'));
      if (lookupOptions.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  }

  function hop(url, { maxBytes, keep, deadline, headers }) {
    return new Promise((resolve, reject) => {
      const host = url.hostname.replace(/^\[|\]$/g, '');
      if (net.isIP(host) && isBlocked(host)) {
        reject(new FetchError('BLOCKED_ADDRESS', 'The URL points at a private or reserved address.'));
        return;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        reject(new FetchError('TIMEOUT', 'The time budget ran out.'));
        return;
      }

      let settled = false;
      let request = null;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const abort = (error) => {
        finish(reject, error);
        if (request) request.destroy();
      };
      const timer = setTimeout(() => abort(new FetchError('TIMEOUT', 'The download took too long.')), remaining);

      request = requestImpl(
        {
          protocol: url.protocol,
          hostname: host,
          port: url.port || undefined,
          path: url.pathname + url.search,
          method: 'GET',
          agent: false,
          lookup: safeLookup,
          timeout: 20000,
          headers: { 'user-agent': USER_AGENT, accept: '*/*', 'accept-encoding': 'identity', ...headers }
        },
        (response) => {
          const status = response.statusCode;
          if (status >= 300 && status < 400 && response.headers.location) {
            response.resume();
            finish(resolve, { redirect: response.headers.location });
            return;
          }
          if (status !== 200) {
            response.resume();
            abort(new FetchError('HTTP_STATUS', `HTTP ${status}`, { status }));
            return;
          }
          const encoding = response.headers['content-encoding'];
          if (encoding && encoding.toLowerCase() !== 'identity') {
            response.resume();
            abort(new FetchError('ENCODED', `The response uses content encoding ${String(encoding).slice(0, 20)}.`));
            return;
          }
          const declared = response.headers['content-length'];
          if (declared !== undefined && Number(declared) > maxBytes) {
            abort(new FetchError('TOO_LARGE', `The file is larger than the limit of ${maxBytes} bytes.`));
            return;
          }

          const hash = crypto.createHash('sha256');
          const chunks = [];
          let size = 0;
          response.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
              abort(new FetchError('TOO_LARGE', `The file is larger than the limit of ${maxBytes} bytes.`));
              return;
            }
            hash.update(chunk);
            if (keep) chunks.push(chunk);
          });
          response.on('end', () => {
            if (!response.complete) abort(new FetchError('NETWORK', 'The connection closed before the file was complete.'));
            else finish(resolve, { status, size, sha256: hash.digest('hex'), bytes: keep ? Buffer.concat(chunks) : null });
          });
          response.on('error', () => abort(new FetchError('NETWORK', 'The connection failed while downloading.')));
          response.on('aborted', () => abort(new FetchError('NETWORK', 'The connection closed before the file was complete.')));
        }
      );
      request.on('timeout', () => abort(new FetchError('TIMEOUT', 'The server stopped sending data.')));
      request.on('error', (error) => {
        const cause = error instanceof FetchError ? error : error.cause instanceof FetchError ? error.cause : null;
        abort(cause || new FetchError('NETWORK', String(error.code || error.message).slice(0, 80)));
      });
      request.end();
    });
  }

  async function downloadOnce(input, settings) {
    let url = parseHttpsUrl(input, { requireHttps });
    for (let redirects = 0; ; redirects++) {
      const result = await hop(url, settings);
      if (!result.redirect) return { ...result, url: url.href, redirects };
      if (redirects >= settings.maxRedirects) throw new FetchError('TOO_MANY_REDIRECTS', `More than ${settings.maxRedirects} redirects.`);
      url = parseHttpsUrl(new URL(result.redirect, url).href, { requireHttps });
    }
  }

  /**
   * Downloads `input`. Rejects with a FetchError (code BAD_URL, BLOCKED_ADDRESS, HTTP_STATUS, TOO_LARGE, TIMEOUT,
   * TOO_MANY_REDIRECTS, ENCODED or NETWORK) as soon as a limit is hit. With keep false only size and sha256 are kept.
   */
  async function download(input, { maxBytes, timeoutMs = 60000, maxRedirects = 3, keep = true, retries = 1, deadline, headers = {} }) {
    if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new Error('download needs maxBytes');
    const limit = Math.min(Date.now() + timeoutMs, deadline ?? Infinity);
    for (let attempt = 0; ; attempt++) {
      try {
        return await downloadOnce(input, { maxBytes, keep, maxRedirects, deadline: limit, headers });
      } catch (error) {
        const retryable = error instanceof FetchError && (RETRYABLE.has(error.code) || (error.code === 'HTTP_STATUS' && error.status >= 500));
        if (!retryable || attempt >= retries || Date.now() + 1500 >= limit) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  return { download };
}

async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

module.exports = { FetchError, createFetcher, isBlockedAddress, parseHttpsUrl, mapLimit, USER_AGENT };
