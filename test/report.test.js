'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderComment, MARKER, MAX_COMMENT_CHARS } = require('../tools/lib/report');
const { esc, code, bytes } = require('../tools/lib/markdown');
const { validateEntry } = require('../tools/lib/entry');
const { validateSubmission } = require('../tools/lib/validate-entry');
const { makeSite, fakeFetcher, MIRROR_A, MIRROR_B } = require('./helpers/site');

async function validated(site, fetcherOptions) {
  return validateSubmission({
    file: `servers/${site.entry.id}.json`,
    entry: site.entry,
    staticChecks: validateEntry(site.entry, `${site.entry.id}.json`),
    fetcher: fakeFetcher(site, fetcherOptions),
    deadline: Date.now() + 60000
  });
}

test('a passing run says so and starts with the marker', async () => {
  const text = renderComment({ commit: 'abcdef0123456789', entries: [await validated(makeSite())] });
  assert.ok(text.startsWith(MARKER));
  assert.match(text, /## Registry validation: PASS/);
  assert.match(text, /### `test-community` Test Community: PASS/);
  assert.match(text, /status `approved` \(merging this pull request approves the entry\)/);
  assert.match(text, /4 of 4 downloaded and matched/);
});

test('errors are listed with where they are', async () => {
  const wrong = { 'servers.json': Buffer.from('{"Servers":[]}') };
  const text = renderComment({ commit: 'abc', entries: [await validated(makeSite(), { overrides: { [MIRROR_A]: wrong, [MIRROR_B]: wrong } })] });
  assert.match(text, /## Registry validation: FAIL/);
  assert.match(text, /\*\*Errors \(2\)\*\*/);
  assert.match(text, /`\/digests\/servers\.json`/);
});

test('removed entries and pull request problems are shown', () => {
  const text = renderComment({ commit: 'abc', entries: [], removed: ['gone.json'], problems: [{ level: 'error', message: 'Too many files.' }] });
  assert.match(text, /FAIL: 1 problem/);
  assert.match(text, /\*\*Removed entries\*\*: `gone\.json`/);
  assert.match(text, /\*\*Error\*\*: Too many files\./);
  assert.match(renderComment({ commit: 'abc', entries: [] }), /Nothing to validate/);
});

test('text from a hostile community cannot add markup, mentions or links', async () => {
  const hostile = '<img src=x onerror=alert(1)> @everyone [click](javascript:alert(1)) https://evil.test/x www.evil.test `tick` ‮\nnew line';
  const site = makeSite({ entry: { name: hostile.slice(0, 48) } });
  site.entry.digests['trap-<script>.txt'] = 'a'.repeat(64);
  const result = await validated(site);
  result.errors.push({ code: 'x', where: `/${hostile}`, message: hostile });
  const text = renderComment({ commit: hostile, entries: [result] });
  const outsideCode = text.replace(/`[^`\n]*`/g, '');
  assert.doesNotMatch(outsideCode, /(?<!\\)<(img|script)/);
  assert.doesNotMatch(outsideCode, /@(?!​)/);
  assert.doesNotMatch(outsideCode, /\]\(javascript/);
  assert.doesNotMatch(outsideCode, /https:\/\/evil|www\.evil/);
  assert.doesNotMatch(text, /‮/);
});

test('escaping keeps text readable', () => {
  assert.equal(esc('a_b *c* [d] <e>'), 'a\\_b \\*c\\* \\[d\\] \\<e\\>');
  assert.equal(code('has `ticks` and\nnewline'), "`has 'ticks' and newline`");
  assert.equal(esc('x'.repeat(400)).length, 300);
  assert.equal(bytes(1536), '1.5 KiB');
  assert.equal(bytes(3 * 1024 ** 3), '3.00 GiB');
});

test('an enormous run still fits into one comment', async () => {
  const result = await validated(makeSite());
  result.errors = Array.from({ length: 5000 }, (_, i) => ({ code: 'x', where: `/digests/f${i}`, message: `file ${i} is wrong` }));
  result.verdict = 'fail';
  const text = renderComment({ commit: 'abc', entries: Array.from({ length: 30 }, () => result) });
  assert.ok(text.length <= MAX_COMMENT_CHARS);
  assert.ok(text.startsWith(MARKER));
});
