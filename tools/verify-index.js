#!/usr/bin/env node
'use strict';

// Verifies an index.json the way the launcher's reader does: node tools/verify-index.js <index.json> --public-key <pem>

const fs = require('node:fs');
const { parseArgs } = require('node:util');
const { readIndex, checkFreshness, loadPublicKey, RegistryError } = require('./lib/registry-index');

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { 'public-key': { type: 'string' }, 'key-id': { type: 'string', default: 'r1' }, 'serial-floor': { type: 'string', default: '0' } }
  });
  if (positionals.length !== 1 || !values['public-key']) {
    process.stderr.write('Usage: node tools/verify-index.js <index.json> --public-key <pem> [--key-id r1] [--serial-floor N]\n');
    return 2;
  }
  try {
    const keys = new Map([[values['key-id'], loadPublicKey(fs.readFileSync(values['public-key'], 'utf8'))]]);
    const index = readIndex(fs.readFileSync(positionals[0]), keys);
    checkFreshness(index, { serialFloor: Number(values['serial-floor']) });
    process.stdout.write(`OK: serial ${index.serial}, ${index.servers.length} servers, expires ${index.expiresAt.toISOString()}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof RegistryError ? error.failure : 'Error'}: ${error.message}\n`);
    return 1;
  }
}

process.exitCode = main();
