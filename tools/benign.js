#!/usr/bin/env node
'use strict';

// Adds the SHA-256 of known-good loader files to data/virustotal-benign.json:
//   node tools/benign.js --note "BepInEx 5.4.23.6 win x64" <root> <relative path>...
// Notes name the release and the path inside it, never a location on this machine.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');

const LIST = path.join(__dirname, '..', 'data', 'virustotal-benign.json');

function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { note: { type: 'string' }, list: { type: 'string', default: LIST } } });
  const [root, ...files] = positionals;
  if (!values.note || !root || files.length === 0) {
    process.stderr.write('Usage: node tools/benign.js --note <what these files are> <root> <relative path>...\n');
    return 2;
  }
  const data = fs.existsSync(values.list) ? JSON.parse(fs.readFileSync(values.list, 'utf8')) : { benign: [] };
  const known = new Set(data.benign.map((item) => item.sha256));
  for (const file of files) {
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
    if (known.has(sha256)) continue;
    known.add(sha256);
    data.benign.push({ sha256, note: `${values.note}: ${file}` });
  }
  data.benign.sort((a, b) => (a.note < b.note ? -1 : a.note > b.note ? 1 : 0));
  fs.writeFileSync(values.list, `${JSON.stringify(data, null, 2)}\n`);
  return 0;
}

process.exitCode = main();
