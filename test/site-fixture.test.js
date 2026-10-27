'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeSite, sha256 } = require('./helpers/site');

const root = path.join(__dirname, 'fixtures', 'site');

test('the committed fixture site is what the test helper builds', () => {
  const { files } = makeSite();
  for (const [name, data] of Object.entries(files)) {
    assert.ok(fs.readFileSync(path.join(root, name)).equals(data), name);
  }
});

test('digest.js prints the digests object for the named files', () => {
  const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'digest.js'), root, 'servers.json', 'Profile/update.info']);
  assert.equal(run.status, 0, run.stderr.toString());
  assert.deepEqual(JSON.parse(run.stdout.toString()), {
    'Profile/update.info': sha256(fs.readFileSync(path.join(root, 'Profile', 'update.info'))),
    'servers.json': sha256(fs.readFileSync(path.join(root, 'servers.json')))
  });
});

test('digest.js refuses paths that cannot be pinned', () => {
  for (const bad of ['../x', '/etc/passwd', 'a\\b', 'missing.json', 'a?b']) {
    const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'digest.js'), root, bad]);
    assert.equal(run.status, 1, bad);
  }
});
