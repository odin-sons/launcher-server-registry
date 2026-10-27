'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const schema = JSON.parse(read('schema', 'server.schema.json'));

test('the entry schema pins the limits of registry-format.md', () => {
  const p = schema.properties;
  assert.deepEqual(schema.required, ['id', 'name', 'status', 'mirrors', 'digests']);
  assert.equal(p.id.pattern, '^[a-z0-9][a-z0-9-]{1,31}$');
  assert.deepEqual([p.name.minLength, p.name.maxLength], [1, 48]);
  assert.deepEqual(p.status.enum, ['approved', 'needs-approval', 'suspended']);
  assert.deepEqual([p.mirrors.minItems, p.mirrors.maxItems], [1, 8]);
  assert.deepEqual([p.digests.minProperties, p.digests.maxProperties], [1, 64]);
  assert.equal(p.digests.additionalProperties.pattern, '^[0-9a-f]{64}$');
  assert.deepEqual(p.terms.required, ['en']);
});

test('the entry schema allows unknown fields', () => {
  assert.notEqual(schema.additionalProperties, false);
});

test('every code owner rule names an owner', () => {
  const rules = read('.github', 'CODEOWNERS')
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'));
  assert.equal(rules[0], '* @fogrew');
  for (const rule of rules) assert.match(rule, /^\S+ @\S+$/);
});

test('the pull request template carries the submission checklist', () => {
  const template = read('.github', 'PULL_REQUEST_TEMPLATE.md');
  assert.match(template, /## Checklist/);
  assert.match(template, /- \[ \] The file is `servers\/<id>\.json`/);
});

test('the repository is MIT licensed', () => {
  assert.match(read('LICENSE'), /^MIT License/);
});
