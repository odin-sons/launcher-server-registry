'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', '.github', 'workflows');
const workflows = fs
  .readdirSync(dir)
  .filter((name) => name.endsWith('.yml'))
  .map((name) => ({ name, text: fs.readFileSync(path.join(dir, name), 'utf8') }));

function triggers(text) {
  const match = /^on:\s*\n((?:[ ]+.*\n|\n)*)/m.exec(text);
  return match ? match[1] : '';
}

function jobBlocks(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === 'jobs:');
  const blocks = [];
  for (let i = start + 1; i < lines.length; i++) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[i]);
    if (header) blocks.push({ id: header[1], lines: [] });
    else if (blocks.length) blocks[blocks.length - 1].lines.push(lines[i]);
  }
  return blocks;
}

test('there is at least one workflow', () => {
  assert.ok(workflows.length > 0);
});

for (const { name, text } of workflows) {
  test(`${name}: every action is pinned to a full commit SHA`, () => {
    for (const match of text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
      const ref = match[1];
      if (ref.startsWith('./')) continue;
      assert.match(ref, /@[0-9a-f]{40}$/, `${ref} is not pinned`);
    }
  });

  test(`${name}: permissions are declared at the top and on every job`, () => {
    assert.match(text, /^permissions:/m, 'no top-level permissions');
    for (const job of jobBlocks(text)) {
      assert.ok(
        job.lines.some((line) => /^ {4}permissions:/.test(line)),
        `job ${job.id} declares no permissions`
      );
    }
  });

  test(`${name}: secrets stay out of pull request code`, () => {
    const on = triggers(text);
    const pullRequest = /^ {2}pull_request:/m.test(on);
    const usedSecrets = [...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
    if (pullRequest) {
      assert.deepEqual(
        usedSecrets.filter((secret) => secret !== 'GITHUB_TOKEN'),
        [],
        'pull_request workflows cannot use secrets'
      );
    }
    if (/^ {2}(pull_request|pull_request_target|issue_comment):?/m.test(on)) {
      assert.ok(!usedSecrets.includes('REGISTRY_SIGNING_KEY'), 'the signing key reaches a pull request trigger');
    }
  });

  test(`${name}: the signing key is only reachable from a job bound to the registry environment`, () => {
    for (const job of jobBlocks(text)) {
      const body = job.lines.join('\n');
      if (!body.includes('secrets.REGISTRY_SIGNING_KEY')) continue;
      assert.match(body, /^ {4}environment: registry$/m, `job ${job.id}`);
      assert.ok(!body.includes('actions/cache@'), `job ${job.id} must not cache anything`);
      assert.ok(!/path: (?!dist\/site$)/m.test(body.replace(/path: \.?\/?$/gm, '')) || !body.includes('upload-artifact'), `job ${job.id} uploads more than dist/site`);
    }
  });

  test(`${name}: pull_request_target never checks out pull request code`, () => {
    if (!/^ {2}pull_request_target:/m.test(triggers(text))) return;
    assert.doesNotMatch(text, /github\.head_ref/);
    for (const match of text.matchAll(/^\s*ref:\s*(.+)$/gm)) {
      assert.doesNotMatch(match[1], /head/i, `checkout ref ${match[1]}`);
    }
  });
}
