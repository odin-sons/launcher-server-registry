'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validate } = require('../tools/lib/json-schema');
const { schema, validateEntry, toIndexRecord, isRelativePath, parseEntryText, loadEntries } = require('../tools/lib/entry');

const sample = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'odinsons.entry.json'), 'utf8'));
const digest = 'ab'.repeat(32);
const base = () => ({
  id: 'test-community',
  name: 'Test Community',
  status: 'approved',
  mirrors: ['https://files.example.test/Launcher/'],
  digests: { 'servers.json': digest }
});
const problems = (entry, fileName = 'test-community.json') => validateEntry(entry, fileName).errors.map((error) => error.message);

test('the sample entry of the registry format is valid', () => {
  const result = validateEntry(sample, 'odinsons.json');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('a minimal entry is valid', () => {
  assert.deepEqual(problems(base()), []);
});

test('every required field is required', () => {
  for (const field of ['id', 'name', 'status', 'mirrors', 'digests']) {
    const entry = base();
    delete entry[field];
    assert.ok(problems(entry).some((message) => message.includes(`'${field}'`)), field);
  }
});

test('ids follow the documented pattern and the file name', () => {
  for (const id of ['a', 'A-b', '-ab', 'a'.repeat(33), 'a_b', 'ab.c']) assert.notEqual(problems({ ...base(), id }, `${id}.json`).length, 0, id);
  for (const id of ['ab', '0a', 'a-b', 'a'.repeat(32)]) assert.deepEqual(problems({ ...base(), id }, `${id}.json`), [], id);
  assert.match(problems(base(), 'other.json').join(), /file name must be test-community\.json/);
});

test('names are 1 to 48 UTF-16 units without control characters', () => {
  assert.notEqual(problems({ ...base(), name: '' }).length, 0);
  assert.notEqual(problems({ ...base(), name: 'x'.repeat(49) }).length, 0);
  assert.deepEqual(problems({ ...base(), name: 'x'.repeat(48) }), []);
  assert.notEqual(problems({ ...base(), name: 'a\u0007b' }).length, 0);
  assert.notEqual(problems({ ...base(), name: 'a\u0085b' }).length, 0);
  assert.notEqual(problems({ ...base(), name: '\u{1F600}'.repeat(25) }).length, 0, '50 UTF-16 units');
});

test('status is one of the three documented values', () => {
  for (const status of ['approved', 'needs-approval', 'suspended']) assert.deepEqual(problems({ ...base(), status }), []);
  assert.notEqual(problems({ ...base(), status: 'pending' }).length, 0);
});

test('mirrors are https base URLs ending in a slash', () => {
  const valid = ['https://h.test/', 'https://h.test/a/', 'https://h.test:8443/a/b/', 'https://h.test/@x/'];
  const invalid = ['http://h.test/', 'https://h.test', 'https://u:p@h.test/', 'https://h.test/?q=1/', 'https://h.test/#f/', 'ftp://h.test/', 'https://h.test/a', '', 'https://h .test/', 'https://@h.test/'];
  for (const mirror of valid) assert.deepEqual(problems({ ...base(), mirrors: [mirror] }), [], mirror);
  for (const mirror of invalid) assert.notEqual(problems({ ...base(), mirrors: [mirror] }).length, 0, mirror);
  assert.notEqual(problems({ ...base(), mirrors: [] }).length, 0);
  assert.notEqual(problems({ ...base(), mirrors: Array.from({ length: 9 }, (_, i) => `https://h${i}.test/`) }).length, 0);
  assert.deepEqual(problems({ ...base(), mirrors: Array.from({ length: 8 }, (_, i) => `https://h${i}.test/`) }), []);
});

test('website and community are optional https links', () => {
  assert.deepEqual(problems({ ...base(), website: null, community: 'https://chat.example.test/x' }), []);
  assert.notEqual(problems({ ...base(), website: 'http://site.test/' }).length, 0);
  assert.notEqual(problems({ ...base(), community: 'https://u:p@chat.test/' }).length, 0);
  assert.notEqual(problems({ ...base(), website: 42 }).length, 0);
});

test('digests hold 1 to 64 lowercase SHA-256 values under relative paths', () => {
  const many = (count) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`f${i}.txt`, digest]));
  assert.deepEqual(problems({ ...base(), digests: many(64) }), []);
  assert.notEqual(problems({ ...base(), digests: many(65) }).length, 0);
  assert.notEqual(problems({ ...base(), digests: {} }).length, 0);
  assert.notEqual(problems({ ...base(), digests: { 'a.txt': digest.toUpperCase() } }).length, 0);
  assert.notEqual(problems({ ...base(), digests: { 'a.txt': digest.slice(1) } }).length, 0);
  for (const key of ['/a', 'a/', 'a//b', './a', 'a/../b', '..', 'a\\b']) assert.notEqual(problems({ ...base(), digests: { [key]: digest } }).length, 0, key);
});

test('paths that change the meaning of a URL are rejected', () => {
  for (const key of ['a?b', 'a#b', 'a%2e', 'a\u0001b']) assert.notEqual(problems({ ...base(), digests: { [key]: digest } }).length, 0, JSON.stringify(key));
});

test('the schema and the code agree on relative paths', () => {
  const corpus = ['a', 'a.json', 'dir/a.json', '.hidden', '..a', 'a..', 'a b/c', '', '/a', 'a/', 'a//b', './a', 'a/./b', '../a', 'a/../b', '.', '..', 'a\\b', 'a/..', 'a/.'];
  for (const value of corpus) {
    const bySchema = validate(schema.$defs.relativePath, value, schema).length === 0;
    assert.equal(bySchema, isRelativePath(value), JSON.stringify(value));
  }
});

test('theme, about and terms must be pinned in digests', () => {
  const entry = { ...base(), theme: 'theme/theme.json', about: 'about.json', terms: { en: 'terms/en.md', de: 'terms/de.md' } };
  const messages = problems(entry).join('\n');
  assert.match(messages, /theme file "theme\/theme\.json" is not listed/);
  assert.match(messages, /About file "about\.json" is not listed/);
  assert.match(messages, /de terms file/);
  const pinned = { ...entry, digests: { 'servers.json': digest, 'theme/theme.json': digest, 'about.json': digest, 'terms/en.md': digest, 'terms/de.md': digest } };
  assert.deepEqual(problems(pinned), []);
});

test('terms need English and sane language codes', () => {
  const digests = { 'servers.json': digest, 'terms/de.md': digest };
  assert.notEqual(problems({ ...base(), digests, terms: { de: 'terms/de.md' } }).length, 0);
  assert.notEqual(problems({ ...base(), digests, terms: { en: 'terms/de.md', 'EN us': 'terms/de.md' } }).length, 0);
});

test('unknown fields are allowed and dropped from the index record', () => {
  const entry = { ...base(), future: { a: 1 }, website: null };
  assert.deepEqual(problems(entry), []);
  assert.deepEqual(Object.keys(toIndexRecord(entry)), ['id', 'name', 'status', 'mirrors', 'digests']);
});

test('the index record has a fixed field order and sorted digests', () => {
  const entry = { ...base(), digests: { 'b.txt': digest, 'a.txt': digest }, terms: { en: 'b.txt' }, theme: 'a.txt', website: 'https://w.test/' };
  const record = toIndexRecord({ terms: entry.terms, theme: 'a.txt', digests: entry.digests, status: 'approved', website: entry.website, mirrors: entry.mirrors, name: 'N', id: 'ab' });
  assert.deepEqual(Object.keys(record), ['id', 'name', 'status', 'mirrors', 'website', 'digests', 'theme', 'terms']);
  assert.deepEqual(Object.keys(record.digests), ['a.txt', 'b.txt']);
});

test('a digest named __proto__ stays an ordinary key', () => {
  const entry = { ...base(), digests: JSON.parse(`{"__proto__":"${digest}","a.txt":"${digest}"}`) };
  const record = toIndexRecord(entry);
  assert.ok(Object.hasOwn(record.digests, '__proto__'));
  assert.equal(Object.getPrototypeOf(record.digests), Object.prototype);
});

test('entry text must be small, plain JSON without a byte order mark', () => {
  assert.equal(parseEntryText('{"a":1}').entry.a, 1);
  assert.match(parseEntryText('﻿{}').errors[0].message, /byte order mark/);
  assert.match(parseEntryText('{oops').errors[0].message, /not valid JSON/);
  assert.match(parseEntryText(' '.repeat(70 * 1024)).errors[0].message, /larger than 64 KiB/);
});

test('loadEntries reads the directory and reports stray files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-entries-'));
  try {
    fs.writeFileSync(path.join(dir, 'test-community.json'), JSON.stringify(base()));
    fs.writeFileSync(path.join(dir, 'broken.json'), '{');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(dir, '.gitkeep'), '');
    const loaded = loadEntries(dir);
    assert.deepEqual(loaded.map((item) => item.name), ['broken.json', 'notes.txt', 'test-community.json']);
    assert.equal(loaded[2].errors.length, 0);
    assert.match(loaded[0].errors[0].message, /not valid JSON/);
    assert.match(loaded[1].errors[0].message, /not a servers\/<id>\.json file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the json schema validator refuses keywords it does not implement', () => {
  assert.throws(() => validate({ type: 'string', format: 'uri' }, 'x'), /Unsupported schema keyword 'format'/);
  assert.throws(() => validate({ oneOf: [] }, 'x'), /Unsupported schema keyword 'oneOf'/);
});
