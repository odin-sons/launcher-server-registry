#!/usr/bin/env node
'use strict';

// Fetches <mirror>/index.json from every published host and checks signature, freshness and serial:
//   node tools/verify-mirrors.js --public-key keys/r1.pub.pem --serial 123 [--require github-pages,...]

const fs = require('node:fs');
const { parseArgs } = require('node:util');
const { createFetcher } = require('./lib/net');
const { readIndex, checkFreshness, loadPublicKey } = require('./lib/registry-index');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function check(fetcher, url, keys, serial) {
  try {
    const downloaded = await fetcher.download(`${url}index.json`, { maxBytes: 1 << 20, timeoutMs: 30000, retries: 0 });
    const index = readIndex(downloaded.bytes, keys);
    checkFreshness(index);
    return index.serial >= serial ? { ok: true, serial: index.serial } : { ok: false, reason: `serves serial ${index.serial}, expected ${serial}` };
  } catch (error) {
    return { ok: false, reason: error.failure || error.code || error.message };
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      mirrors: { type: 'string', default: 'config/mirrors.json' },
      'public-key': { type: 'string' },
      'key-id': { type: 'string', default: process.env.REGISTRY_KEY_ID || 'r1' },
      serial: { type: 'string' },
      require: { type: 'string', default: '' },
      attempts: { type: 'string', default: '12' },
      'delay-seconds': { type: 'string', default: '20' }
    }
  });
  const serial = Number(values.serial);
  if (!values['public-key'] || !Number.isSafeInteger(serial)) throw new Error('--public-key and --serial are required');
  const keys = new Map([[values['key-id'], loadPublicKey(fs.readFileSync(values['public-key'], 'utf8'))]]);
  const mirrors = JSON.parse(fs.readFileSync(values.mirrors, 'utf8')).mirrors;
  const required = new Set(values.require.split(',').filter(Boolean));
  const fetcher = createFetcher();
  const state = new Map();

  for (let attempt = 1; attempt <= Number(values.attempts); attempt++) {
    for (const mirror of mirrors) {
      if (state.get(mirror.name)?.ok) continue;
      state.set(mirror.name, await check(fetcher, mirror.url, keys, serial));
    }
    if ([...required].every((name) => state.get(name)?.ok)) break;
    process.stderr.write(`Attempt ${attempt}: waiting for ${[...required].filter((name) => !state.get(name)?.ok).join(', ')}\n`);
    await sleep(Number(values['delay-seconds']) * 1000);
  }

  let failed = false;
  for (const mirror of mirrors) {
    const result = state.get(mirror.name);
    const mustWork = required.has(mirror.name);
    process.stdout.write(`${mirror.name}: ${result.ok ? `serves serial ${result.serial}` : `NOT OK (${result.reason})`}${mustWork ? '' : ' [not required]'}\n`);
    if (!result.ok && mustWork) failed = true;
  }
  return failed ? 1 : 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 2; }
);
