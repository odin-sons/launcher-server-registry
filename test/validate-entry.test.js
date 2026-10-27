'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateEntry } = require('../tools/lib/entry');
const { validateSubmission, isScannable } = require('../tools/lib/validate-entry');
const { FetchError } = require('../tools/lib/net');
const { makeSite, fakeFetcher, sha256, manifest, MIRROR_A, MIRROR_B } = require('./helpers/site');
const { makePng } = require('./helpers/png');

async function run(site, { fetcher = fakeFetcher(site), previous = null, otherNames = new Map(), deadline = Date.now() + 60000 } = {}) {
  const staticChecks = validateEntry(site.entry, `${site.entry.id}.json`);
  const result = await validateSubmission({ file: `servers/${site.entry.id}.json`, entry: site.entry, staticChecks, previous, otherNames, fetcher, deadline });
  return { result, fetcher };
}
const messages = (result) => result.errors.map((error) => error.message).join('\n');

test('a healthy community passes every check', async () => {
  const site = makeSite();
  const { result, fetcher } = await run(site);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.networkChecked, true);
  assert.ok(result.mirrors.every((mirror) => mirror.state === 'ok'));
  assert.ok(result.files.every((file) => file.verified));
  assert.equal(result.listed.checked, 4);
  assert.equal(result.listed.ok, 4);
  assert.equal(result.display.length, 6);
  assert.ok(fetcher.requests.length > 0);
});

test('files listed in manifests are checked on the first mirror that answers', async () => {
  const site = makeSite();
  const { result } = await run(site, { fetcher: fakeFetcher(site, { down: [MIRROR_A] }) });
  assert.match(messages(result), /Mirror 1 is not reachable/);
  assert.equal(result.mirrors[0].state, 'unreachable');
  assert.equal(result.mirrors[1].state, 'ok');
  assert.equal(result.listed.ok, 4);
  assert.equal(result.listed.usedMirror[0], undefined);
  assert.equal(result.listed.usedMirror[1], 4);
});

test('a pinned file that differs on one mirror is an error naming the mirror', async () => {
  const site = makeSite();
  const fetcher = fakeFetcher(site, { overrides: { [MIRROR_B]: { 'servers.json': Buffer.from('{"Servers":[]}') } } });
  const { result } = await run(site, { fetcher });
  assert.equal(result.verdict, 'fail');
  assert.match(messages(result), /servers\.json on mirror 2 does not match the pinned digest/);
  assert.equal(result.mirrors[1].state, 'partial');
});

test('a file over its limit is rejected while downloading, with the limit named', async () => {
  const art = Buffer.alloc(1024 * 1024 + 1, 1);
  const site = makeSite({ files: { 'theme/art.png': art } });
  const { result } = await run(site);
  assert.match(messages(result), /theme\/art\.png on mirror 1: exceeds the 1048576 byte limit for this file \(art\)/);
  assert.equal(result.files.find((file) => file.path === 'theme/art.png').mirrors[0].state, 'too-large');
});

test('size limits depend on what the file is for', async () => {
  const bigTheme = Buffer.from(JSON.stringify({ themeSchema: 1, pad: 'x'.repeat(17 * 1024) }));
  const { result } = await run(makeSite({ files: { 'theme/theme.json': bigTheme } }));
  assert.match(messages(result), /theme\/theme\.json on mirror 1: exceeds the 16384 byte limit/);
  const terms = await run(makeSite({ files: { 'terms/en.md': Buffer.alloc(20 * 1024 + 1, 0x61) } }));
  assert.match(messages(terms.result), /terms\/en\.md on mirror 1: exceeds the 20480 byte limit/);
  const logo = await run(makeSite({ files: { 'theme/logo.png': Buffer.concat([makePng(8, 8), Buffer.alloc(256 * 1024)]) } }));
  assert.match(messages(logo.result), /theme\/logo\.png on mirror 1: exceeds the 262144 byte limit/);
});

test('a listed file whose content or size differs from the manifest is an error', async () => {
  const site = makeSite({ modFiles: { 'BepInEx/plugins/Demo/Demo.dll': Buffer.from('swapped plugin bytes') } });
  const { result } = await run(site);
  assert.match(messages(result), /BepInEx\/plugins\/Demo\/Demo\.dll: larger than the 17 bytes the manifest says|hash differs/);
  assert.equal(result.listed.failed, 1);
  const same = makeSite({ modFiles: { 'BepInEx/plugins/Demo/Demo.dll': Buffer.from('tampered bytes!!!') } });
  assert.match(messages((await run(same)).result), /Demo\.dll: the hash differs from the manifest/);
});

test('game manifests are parsed but their files are never requested', async () => {
  const site = makeSite();
  const { result, fetcher } = await run(site);
  assert.ok(result.manifests.some((item) => item.kind === 'game'));
  assert.ok(!fetcher.requests.some((url) => url.includes('valheim.exe')));
});

test('a manifest with problems is reported and its files are not fetched', async () => {
  const bad = Buffer.from(`MANIFEST 3 sha256\nnot-a-hash 5 a/../b.dll\n`);
  const site = makeSite({ files: { 'Profile/update.info': bad } });
  const { result, fetcher } = await run(site);
  assert.match(messages(result), /Profile\/update\.info line 2/);
  assert.ok(!fetcher.requests.some((url) => url.includes('b.dll')));
});

test('theme, About and terms problems are reported', async () => {
  const site = makeSite({
    files: {
      'theme/logo.png': makePng(600, 600),
      'theme/art.png': makePng(10, 10, { animated: true }),
      'about.json': Buffer.from(JSON.stringify({ aboutSchema: 1, tagline: { en: 'x'.repeat(81) } })),
      'terms/en.md': Buffer.from(' ')
    }
  });
  const { result } = await run(site);
  const text = messages(result);
  assert.match(text, /The logo is 600 x 600 pixels; the limit is 512 x 512/);
  assert.match(text, /Animated pictures are not accepted/);
  assert.match(text, /tagline\.en is 81 characters/);
  assert.match(text, /terms are empty/);
});

test('an image the theme names but digests does not pin is an error', async () => {
  const site = makeSite({ digests: (all) => Object.fromEntries(Object.entries(all).filter(([name]) => name !== 'theme/logo.png')) });
  const { result } = await run(site);
  assert.match(messages(result), /logo\.file "theme\/logo\.png" is not listed in digests/);
});

test('an entry that is not valid skips the network', async () => {
  const site = makeSite({ entry: { mirrors: ['http://insecure.test/'] } });
  const { result, fetcher } = await run(site);
  assert.equal(result.networkChecked, false);
  assert.equal(fetcher.requests.length, 0);
  assert.equal(result.verdict, 'fail');
  assert.ok(result.warnings.some((warning) => warning.code === 'network-skipped'));
});

test('names must be unique and a changed entry shows what changed', async () => {
  const site = makeSite();
  const taken = await run(site, { otherNames: new Map([['test community', 'someone-else']]) });
  assert.match(messages(taken.result), /name is already used by the entry someone-else/);

  const previous = { ...site.entry, status: 'needs-approval', mirrors: [MIRROR_A], digests: { ...site.entry.digests, 'servers.json': 'f'.repeat(64), 'gone.txt': 'e'.repeat(64) } };
  const { result } = await run(site, { previous });
  assert.equal(result.isNew, false);
  assert.deepEqual(result.changes.filter((line) => /^(status|mirror|digest changed|digest removed)/.test(line)), [
    'status: needs-approval -> approved',
    `mirror added: ${MIRROR_B}`,
    'digest changed: servers.json',
    'digest removed: gone.txt'
  ]);
});

test('names that look like the launcher or registry are flagged for a human', async () => {
  const { result } = await run(makeSite({ entry: { name: 'Official Valheim Launcher' } }));
  assert.ok(result.warnings.some((warning) => warning.code === 'name-check'));
  assert.equal(result.verdict, 'warn');
});

test('running out of time leaves files unverified and the verdict incomplete', async () => {
  const site = makeSite();
  const slow = fakeFetcher(site);
  const original = slow.download;
  let calls = 0;
  slow.download = async (...args) => {
    calls += 1;
    return original(...args);
  };
  const deadline = Date.now() + 60000;
  const staticChecks = validateEntry(site.entry, 'test-community.json');
  const result = await validateSubmission({ file: 'servers/test-community.json', entry: site.entry, staticChecks, fetcher: slow, deadline: Date.now() - 1 });
  assert.ok(calls >= 0 && deadline > 0);
  assert.equal(result.listed.skipped, result.listed.checked);
  assert.equal(result.verdict === 'incomplete' || result.verdict === 'fail', true);
  assert.ok(result.warnings.some((warning) => warning.code === 'budget'));
});

test('the modpack size limits are enforced from the manifest before anything is downloaded', async () => {
  const hash = sha256('x');
  const huge = Buffer.from(`MANIFEST 3 sha256\n${hash} ${257 * 1024 * 1024} BepInEx/plugins/Huge/Huge.dll\n`);
  const site = makeSite({ files: { 'Profile/update.info': huge } });
  const { result, fetcher } = await run(site);
  assert.match(messages(result), /the limit for one file is 268435456/);
  assert.ok(!fetcher.requests.some((url) => url.includes('Huge.dll')));

  const many = Buffer.from(`MANIFEST 3 sha256\n${Array.from({ length: 9 }, (_, i) => `${hash} ${255 * 1024 * 1024} f${i}.bin`).join('\n')}\n`);
  const total = await run(makeSite({ files: { 'Profile/update.info': many } }));
  assert.match(messages(total.result), /list 2\d+ bytes in total; the limit is 2147483648/);
});

test('the same file listed twice with different hashes is an error', async () => {
  const one = manifest({ 'BepInEx/plugins/Demo/Demo.dll': Buffer.from('demo plugin bytes') });
  const two = manifest({ 'BepInEx/plugins/Demo/Demo.dll': Buffer.from('another build') });
  const site = makeSite({ files: { 'Profile/update.info': Buffer.from(one), 'Profile/update_admin.info': Buffer.from(two) } });
  site.entry.digests['Profile/update_admin.info'] = sha256(site.files['Profile/update_admin.info']);
  const { result } = await run(site);
  assert.match(messages(result), /listed with a different hash or size/);
});

test('code-bearing files become scan targets, once per hash', async () => {
  const { result } = await run(makeSite());
  const names = result.scanTargets.flatMap((target) => target.paths);
  assert.ok(names.includes('Profile/BepInEx/plugins/Demo/Demo.dll'));
  assert.ok(names.includes('Profile/BepInEx/plugins/Extra/Extra.dll'));
  assert.ok(!names.some((name) => name.endsWith('.cfg') || name.endsWith('manifest.json')));
  assert.ok(!names.some((name) => name.includes('valheim.exe')));
  assert.equal(new Set(result.scanTargets.map((target) => target.sha256)).size, result.scanTargets.length);
  assert.ok(isScannable('a/b/Libdoorstop.DYLIB') && isScannable('x.zip') && !isScannable('x.txt'));
});

test('hostile failures from the downloader never escape', async () => {
  const site = makeSite();
  const fetcher = fakeFetcher(site, { overrides: { [MIRROR_A]: { 'servers.json': new FetchError('BLOCKED_ADDRESS', 'private') } } });
  const { result } = await run(site, { fetcher });
  assert.match(messages(result), /servers\.json on mirror 1: The host resolves|servers\.json on mirror 1: private/);
});
