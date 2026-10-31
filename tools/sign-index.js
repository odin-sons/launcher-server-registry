#!/usr/bin/env node
'use strict';

// Builds index.json from servers/, signs it and writes the site that is published. The private key comes from an
// environment variable (or is a throwaway made in memory) and is never written, printed or passed on.

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { loadEntries } = require('./lib/entry');
const { buildPayload, signEnvelope, readIndex, checkFreshness, loadPublicKey } = require('./lib/registry-index');
const { loadPrivateKey, publicPem, generateThrowawayKey } = require('./lib/keys');

function main() {
  const { values } = parseArgs({
    options: {
      servers: { type: 'string', default: 'servers' },
      config: { type: 'string', default: 'config/index.json' },
      'key-env': { type: 'string', default: 'REGISTRY_SIGNING_KEY' },
      'key-id': { type: 'string', default: process.env.REGISTRY_KEY_ID || 'r1' },
      'public-key': { type: 'string' },
      throwaway: { type: 'boolean', default: false },
      out: { type: 'string', default: 'dist/site' },
      now: { type: 'string' }
    }
  });

  const entries = loadEntries(path.resolve(values.servers));
  const broken = entries.filter((item) => item.errors.length > 0);
  if (broken.length) {
    for (const item of broken) process.stderr.write(`${item.name}: ${item.errors.map((error) => error.message).join('; ')}\n`);
    throw new Error('Some entries are not valid; refusing to sign an index.');
  }
  const config = JSON.parse(fs.readFileSync(values.config, 'utf8'));
  const now = values.now ? new Date(values.now) : new Date();
  const payload = buildPayload(entries.map((item) => item.entry), { now, validityDays: config.validityDays, minLauncher: config.minLauncher });

  let privateKey;
  if (values.throwaway) {
    privateKey = generateThrowawayKey();
  } else {
    const pem = process.env[values['key-env']];
    if (!pem) throw new Error(`The ${values['key-env']} environment variable is empty; nothing was signed.`);
    privateKey = loadPrivateKey(pem);
    if (!values['public-key']) throw new Error('--public-key is required: the key must match the one the launcher pins.');
    const pinned = loadPublicKey(fs.readFileSync(values['public-key'], 'utf8'));
    if (!pinned.equals(require('node:crypto').createPublicKey(privateKey))) throw new Error(`The signing key does not match ${values['public-key']}; nothing was signed.`);
  }

  const envelope = signEnvelope(payload, privateKey, values['key-id']);
  const publicKey = loadPublicKey(publicPem(privateKey));
  const index = readIndex(Buffer.from(envelope), new Map([[values['key-id'], publicKey]]));
  checkFreshness(index, { now });

  const out = path.resolve(values.out);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'index.json'), envelope);
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  fs.writeFileSync(path.join(out, '_headers'), '/index.json\n  Content-Type: application/json\n  Cache-Control: public, max-age=300\n');
  if (values.throwaway) fs.writeFileSync(path.join(out, 'throwaway.pub.pem'), publicPem(privateKey));

  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `serial=${index.serial}\n`);
  process.stdout.write(`Signed index: key ${values['key-id']}, serial ${index.serial}, ${index.servers.length} servers, valid ${payload.issuedAt} to ${payload.expiresAt}, ${Buffer.byteLength(envelope)} bytes\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
