#!/usr/bin/env node
'use strict';

// Prints what the launcher needs from a registry public key: node tools/key-info.js <public.pem> [key-id]

const fs = require('node:fs');
const { loadPublicKey } = require('./lib/registry-index');
const { spkiBase64, fingerprint } = require('./lib/keys');

function main() {
  const [file, keyId = 'r1'] = process.argv.slice(2);
  if (!file) {
    process.stderr.write('Usage: node tools/key-info.js <public.pem> [key-id]\n');
    return 2;
  }
  let key;
  try {
    key = loadPublicKey(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  const spki = spkiBase64(key);
  process.stdout.write([
    `Key id:        ${keyId}`,
    `SHA-256 of the SubjectPublicKeyInfo: ${fingerprint(key)}`,
    `SubjectPublicKeyInfo (base64): ${spki}`,
    '',
    'Launcher.Core/RegistryKeySet.cs, RegistryKeySet.Official:',
    `    new RegistryKeySet(new[] { new KeyValuePair<string, byte[]>("${keyId}", Convert.FromBase64String("${spki}")) });`,
    ''
  ].join('\n'));
  return 0;
}

process.exitCode = main();
