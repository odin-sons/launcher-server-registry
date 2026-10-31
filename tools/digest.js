#!/usr/bin/env node
'use strict';

// Prints the "digests" object for the files of a community: node tools/digest.js <site-root> <path>...

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isSafeUrlPath } = require('./lib/entry');

function digestOf(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function main(argv) {
  const [root, ...paths] = argv;
  if (!root || paths.length === 0) {
    process.stderr.write('Usage: node tools/digest.js <site-root> <path relative to the root>...\n');
    return 2;
  }
  const digests = {};
  for (const relative of paths) {
    if (!isSafeUrlPath(relative)) {
      process.stderr.write(`${relative} is not a valid pinned path (relative, forward slashes, no .., no ? # %).\n`);
      return 1;
    }
    const file = path.join(root, ...relative.split('/'));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      process.stderr.write(`${relative} does not exist under ${root}.\n`);
      return 1;
    }
    digests[relative] = digestOf(file);
  }
  const sorted = Object.fromEntries(Object.entries(digests).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  process.stdout.write(`${JSON.stringify(sorted, null, 2)}\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
