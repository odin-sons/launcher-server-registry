'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const idx = require('../tools/lib/registry-index');
const { generateThrowawayKey, publicPem, loadPrivateKey } = require('../tools/lib/keys');

const root = path.join(__dirname, '..');
const sample = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'index.payload.json'), 'utf8'));
const sampleEntry = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'odinsons.entry.json'), 'utf8'));
const NOW = new Date('2026-03-01T12:30:45.678Z');
const settings = { now: NOW, validityDays: 14, minLauncher: '3.0.0' };

const privateKey = generateThrowawayKey();
const keys = new Map([['r1', crypto.createPublicKey(privateKey)]]);
const envelopeOf = (payload, key = privateKey, keyId = 'r1') => Buffer.from(idx.signEnvelope(payload, key, keyId));
const failureOf = (fn) => assert.throws(fn, (error) => error instanceof idx.RegistryError && error.failure);
const failure = (fn) => { try { fn(); } catch (error) { return error.failure; } return null; };

function entry(id, extra = {}) {
  return { id, name: `Server ${id}`, status: 'approved', mirrors: ['https://files.example.test/Launcher/'], digests: { 'servers.json': 'ab'.repeat(32) }, ...extra };
}

test('the launcher repository sample payload is read by the verifier', () => {
  const index = idx.readIndex(envelopeOf(sample), keys);
  assert.equal(index.serial, 1);
  assert.equal(index.minLauncher, '3.0.0');
  assert.equal(index.servers[0].id, 'odinsons');
  assert.equal(index.servers[0].status, 'approved');
  assert.equal(index.servers[0].digests['servers.json'], '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
  assert.equal(index.expiresAt.toISOString(), '2026-01-08T00:00:00.000Z');
});

test('the payload built from the sample entry has the sample payload shape', () => {
  const payload = idx.buildPayload([sampleEntry], { now: new Date('2026-01-01T00:00:00Z'), validityDays: 7, minLauncher: '3.0.0' });
  assert.deepEqual(payload.servers, sample.servers);
  assert.deepEqual({ ...payload, serial: 1, servers: undefined }, { ...sample, servers: undefined });
});

test('a freshly signed index verifies and carries every status', () => {
  const entries = [entry('zz-last'), entry('aa-first', { status: 'needs-approval' }), entry('mm-middle', { status: 'suspended', theme: 'theme.json', about: 'about.json', terms: { en: 't.md' }, digests: { 'servers.json': 'ab'.repeat(32), 'theme.json': 'cd'.repeat(32), 'about.json': 'cd'.repeat(32), 't.md': 'cd'.repeat(32) } })];
  const index = idx.readIndex(envelopeOf(idx.buildPayload(entries, settings)), keys);
  assert.deepEqual(index.servers.map((s) => [s.id, s.status]), [['aa-first', 'needs-approval'], ['mm-middle', 'suspended'], ['zz-last', 'approved']]);
  assert.equal(index.servers[1].raw.theme, 'theme.json');
  assert.deepEqual(index.servers[1].raw.terms, { en: 't.md' });
  assert.doesNotThrow(() => idx.checkFreshness(index, { now: NOW, serialFloor: index.serial }));
});

test('the serial is the issue time in seconds, so a later signing is always higher', () => {
  const first = idx.buildPayload([], settings);
  const second = idx.buildPayload([], { ...settings, now: new Date(NOW.getTime() + 1000) });
  assert.equal(first.serial, Math.floor(NOW.getTime() / 1000));
  assert.equal(first.issuedAt, '2026-03-01T12:30:45Z');
  assert.equal(first.expiresAt, '2026-03-15T12:30:45Z');
  assert.ok(second.serial > first.serial);
});

test('the same entries give the same bytes whatever the key order of the sources', () => {
  const a = entry('ab-cd');
  const b = { digests: a.digests, mirrors: a.mirrors, status: a.status, name: a.name, id: a.id };
  assert.equal(JSON.stringify(idx.buildPayload([a], settings)), JSON.stringify(idx.buildPayload([b], settings)));
});

test('the signature is ECDSA P-256 over the payload bytes, DER, as openssl dgst checks it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-sig-'));
  try {
    const envelope = JSON.parse(envelopeOf(idx.buildPayload([entry('ab-cd')], settings)).toString());
    assert.deepEqual(Object.keys(envelope), ['keyId', 'signature', 'payload']);
    const payload = Buffer.from(envelope.payload, 'base64');
    const signature = Buffer.from(envelope.signature, 'base64');
    assert.equal(signature[0], 0x30, 'a DER SEQUENCE, not a raw r||s');
    fs.writeFileSync(path.join(dir, 'p.json'), payload);
    fs.writeFileSync(path.join(dir, 's.sig'), signature);
    fs.writeFileSync(path.join(dir, 'k.pem'), publicPem(privateKey));
    const openssl = spawnSync('openssl', ['dgst', '-sha256', '-verify', path.join(dir, 'k.pem'), '-signature', path.join(dir, 's.sig'), path.join(dir, 'p.json')]);
    if (openssl.error) return;
    assert.match(openssl.stdout.toString(), /Verified OK/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('failures are the launcher failures, in the launcher order', () => {
  const good = envelopeOf(idx.buildPayload([entry('ab-cd')], settings));
  const other = generateThrowawayKey();
  assert.equal(failure(() => idx.readIndex(Buffer.from('nope'), keys)), 'Malformed');
  assert.equal(failure(() => idx.readIndex(Buffer.alloc(0), keys)), 'Malformed');
  assert.equal(failure(() => idx.readIndex(Buffer.from('[]'), keys)), 'Malformed');
  assert.equal(failure(() => idx.readIndex(Buffer.from('{"keyId":"r1","signature":"@@","payload":"AA=="}'), keys)), 'Malformed');
  assert.equal(failure(() => idx.readIndex(Buffer.from('{"keyId":"r1","signature":"AA=="}'), keys)), 'Malformed');
  assert.equal(failure(() => idx.readIndex(envelopeOf(idx.buildPayload([], settings), privateKey, 'r9'), keys)), 'UnknownKey');
  assert.equal(failure(() => idx.readIndex(envelopeOf(idx.buildPayload([], settings), other), keys)), 'BadSignature');
  const forged = JSON.parse(good.toString());
  forged.payload = Buffer.from(JSON.stringify({ ...idx.buildPayload([entry('ab-cd')], settings), serial: 99 })).toString('base64');
  assert.equal(failure(() => idx.readIndex(Buffer.from(JSON.stringify(forged)), keys)), 'BadSignature');
  assert.equal(failure(() => idx.readIndex(Buffer.alloc((1 << 20) + 1, 0x20), keys)), 'Malformed');
});

test('what the launcher refuses after the signature is refused here too', () => {
  const base = idx.buildPayload([entry('ab-cd')], settings);
  const read = (patch) => failure(() => idx.readIndex(envelopeOf({ ...base, ...patch }), keys));
  assert.equal(read({ schema: 2 }), 'UnsupportedSchema');
  assert.equal(read({ serial: 0 }), 'Invalid');
  assert.equal(read({ serial: 1.5 }), 'Invalid');
  assert.equal(read({ expiresAt: base.issuedAt }), 'Invalid');
  assert.equal(read({ expiresAt: '2027-01-01T00:00:00Z' }), 'Invalid');
  assert.equal(read({ issuedAt: '2026-03-01T12:30:45.000Z' }), 'Invalid');
  assert.equal(read({ issuedAt: '2026-02-30T00:00:00Z' }), 'Invalid');
  assert.equal(read({ minLauncher: 'three' }), 'Invalid');
  assert.equal(read({ servers: [entry('ab-cd'), entry('ab-cd')] }), 'Invalid');
  assert.equal(read({ servers: 'x' }), 'Invalid');
  assert.equal(read({ servers: [entry('ab-cd', { status: 'pending' })] }), 'Invalid');
  assert.equal(read({ servers: [entry('ab-cd', { mirrors: ['http://x.test/'] })] }), 'Invalid');
  assert.equal(read({ servers: [entry('ab-cd', { digests: { '../x': 'ab'.repeat(32) } })] }), 'Invalid');
  assert.equal(read({ servers: [entry('ab-cd', { digests: {} })] }), 'Invalid');
  assert.equal(read({ servers: [entry('ab-cd', { website: 'http://x.test/' })] }), 'Invalid');
  assert.equal(read({ servers: [entry('A')] }), 'Invalid');
  assert.equal(read({}), null);
});

test('freshness: expiry, rollback and a launcher that is too old', () => {
  const index = idx.readIndex(envelopeOf(idx.buildPayload([], { ...settings, minLauncher: '3.1.0' })), keys);
  const later = new Date(NOW.getTime() + 15 * 24 * 3600 * 1000);
  assert.equal(failure(() => idx.checkFreshness(index, { now: later })), 'Expired');
  assert.equal(failure(() => idx.checkFreshness(index, { now: NOW, serialFloor: index.serial + 1 })), 'Rollback');
  assert.equal(failure(() => idx.checkFreshness(index, { now: NOW, launcherVersion: '3.0.9' })), 'LauncherTooOld');
  assert.equal(failure(() => idx.checkFreshness(index, { now: NOW, launcherVersion: '3.1.0' })), null);
  assert.equal(failure(() => idx.checkFreshness(index, { now: NOW, launcherVersion: '10.0.0' })), null);
});

test('limits: 500 servers fit, 501 do not, and the envelope stays under 1 MiB', () => {
  const many = (count) => Array.from({ length: count }, (_, i) => entry(`s${String(i).padStart(4, '0')}`));
  assert.equal(idx.readIndex(envelopeOf(idx.buildPayload(many(500), settings)), keys).servers.length, 500);
  assert.throws(() => idx.buildPayload(many(501), settings), /limit is 500/);
  const heavy = Array.from({ length: 500 }, (_, i) => entry(`h${String(i).padStart(4, '0')}`, { digests: Object.fromEntries(Array.from({ length: 64 }, (__, n) => [`dir/file-number-${n}.json`, 'ab'.repeat(32)])) }));
  assert.throws(() => idx.signEnvelope(idx.buildPayload(heavy, settings), privateKey, 'r1'), /launcher reads at most/);
  assert.throws(() => idx.buildPayload([entry('ab-cd'), entry('ab-cd')], settings), /same id/);
  assert.throws(() => idx.buildPayload([], { ...settings, validityDays: 32 }), /between 0 and 31/);
  assert.doesNotThrow(() => idx.buildPayload([], { ...settings, validityDays: 31 }));
});

test('only P-256 keys are accepted', () => {
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const p384 = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  assert.throws(() => idx.loadPublicKey(rsa.publicKey.export({ type: 'spki', format: 'pem' })), /P-256/);
  assert.throws(() => idx.loadPublicKey(p384.publicKey.export({ type: 'spki', format: 'pem' })), /P-256/);
  assert.throws(() => loadPrivateKey('not a key'), /not a readable PEM private key/);
  assert.throws(() => loadPrivateKey(p384.privateKey.export({ type: 'pkcs8', format: 'pem' })), /P-256/);
});

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-sign-'));
  fs.mkdirSync(path.join(dir, 'servers'));
  fs.writeFileSync(path.join(dir, 'servers', 'ab-cd.json'), JSON.stringify(entry('ab-cd')));
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ minLauncher: '3.0.0', validityDays: 14 }));
  return dir;
}
const sign = (dir, args, env = {}) => spawnSync(process.execPath, [path.join(root, 'tools', 'sign-index.js'), '--servers', path.join(dir, 'servers'), '--config', path.join(dir, 'index.json'), '--out', path.join(dir, 'site'), ...args], { env: { PATH: process.env.PATH, ...env } });

test('the dry run signs with a throwaway key, verifies the result and leaves no secret behind', () => {
  const dir = workspace();
  try {
    const run = sign(dir, ['--throwaway']);
    assert.equal(run.status, 0, run.stderr.toString());
    assert.match(run.stdout.toString(), /Signed index: key r1, serial \d+, 1 servers/);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'site')).sort(), ['.nojekyll', '_headers', 'index.json', 'throwaway.pub.pem']);
    const verify = spawnSync(process.execPath, [path.join(root, 'tools', 'verify-index.js'), path.join(dir, 'site', 'index.json'), '--public-key', path.join(dir, 'site', 'throwaway.pub.pem')]);
    assert.equal(verify.status, 0, verify.stderr.toString());
    assert.match(verify.stdout.toString(), /^OK: serial \d+, 1 servers/);
    for (const file of fs.readdirSync(path.join(dir, 'site'))) assert.doesNotMatch(fs.readFileSync(path.join(dir, 'site', file), 'utf8'), /PRIVATE KEY/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('signing with the real kind of key: pinned public key must match, and nothing leaks', () => {
  const dir = workspace();
  try {
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
    fs.writeFileSync(path.join(dir, 'r1.pub.pem'), pair.publicKey.export({ type: 'spki', format: 'pem' }));
    const ok = sign(dir, ['--public-key', path.join(dir, 'r1.pub.pem')], { REGISTRY_SIGNING_KEY: pem });
    assert.equal(ok.status, 0, ok.stderr.toString());
    const output = ok.stdout.toString() + ok.stderr.toString();
    assert.doesNotMatch(output, /PRIVATE KEY/);
    assert.ok(!output.includes(pem.split('\n')[1]));
    assert.ok(!fs.existsSync(path.join(dir, 'site', 'throwaway.pub.pem')));

    const wrong = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    fs.writeFileSync(path.join(dir, 'other.pub.pem'), wrong.publicKey.export({ type: 'spki', format: 'pem' }));
    const mismatch = sign(dir, ['--public-key', path.join(dir, 'other.pub.pem')], { REGISTRY_SIGNING_KEY: pem });
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr.toString(), /does not match/);
    assert.doesNotMatch(mismatch.stderr.toString(), /PRIVATE KEY/);

    assert.match(sign(dir, ['--public-key', path.join(dir, 'r1.pub.pem')]).stderr.toString(), /environment variable is empty/);
    const garbage = sign(dir, ['--public-key', path.join(dir, 'r1.pub.pem')], { REGISTRY_SIGNING_KEY: 'garbage' });
    assert.equal(garbage.status, 1);
    assert.doesNotMatch(garbage.stderr.toString(), /garbage/);
    assert.match(sign(dir, [], { REGISTRY_SIGNING_KEY: pem }).stderr.toString(), /--public-key is required/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an invalid entry stops the signing', () => {
  const dir = workspace();
  try {
    fs.writeFileSync(path.join(dir, 'servers', 'broken.json'), '{"id":"broken"}');
    const run = sign(dir, ['--throwaway']);
    assert.equal(run.status, 1);
    assert.match(run.stderr.toString(), /Some entries are not valid/);
    assert.ok(!fs.existsSync(path.join(dir, 'site')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('key-info prints the SubjectPublicKeyInfo the launcher pins', () => {
  const dir = workspace();
  try {
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    fs.writeFileSync(path.join(dir, 'k.pem'), pair.publicKey.export({ type: 'spki', format: 'pem' }));
    const run = spawnSync(process.execPath, [path.join(root, 'tools', 'key-info.js'), path.join(dir, 'k.pem')]);
    assert.equal(run.status, 0);
    assert.ok(run.stdout.toString().includes(pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')));
    assert.match(run.stdout.toString(), /KeyValuePair<string, byte\[\]>\("r1"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the committed configuration is consistent with the format', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config', 'index.json'), 'utf8'));
  assert.ok(config.validityDays > 0 && config.validityDays <= 31);
  assert.match(config.minLauncher, /^\d+\.\d+(\.\d+){0,2}$/);
  const mirrors = JSON.parse(fs.readFileSync(path.join(root, 'config', 'mirrors.json'), 'utf8')).mirrors;
  assert.ok(mirrors.length >= 2, 'more than one host');
  assert.equal(new Set(mirrors.map((m) => m.name)).size, mirrors.length);
  for (const mirror of mirrors) assert.match(mirror.url, /^https:\/\/[^/@?#]+\/(?:[^?#]*\/)?$/);
});

test('theme, about and terms are read the way the launcher reads them', () => {
  const digests = { 'servers.json': 'ab'.repeat(32), 'theme/theme.json': 'cd'.repeat(32), 'about.json': 'cd'.repeat(32), 'terms/en.md': 'cd'.repeat(32), 'terms/de.md': 'cd'.repeat(32) };
  const full = entry('ab-cd', { digests, theme: 'theme/theme.json', about: 'about.json', terms: { en: 'terms/en.md', 'pt-BR': 'terms/de.md' } });
  const read = (patch) => failure(() => idx.readIndex(envelopeOf(idx.buildPayload([{ ...full, ...patch }], settings)), keys));
  const server = idx.readIndex(envelopeOf(idx.buildPayload([full], settings)), keys).servers[0];
  assert.equal(server.theme, 'theme/theme.json');
  assert.equal(server.about, 'about.json');
  assert.deepEqual(server.terms, { en: 'terms/en.md', 'pt-BR': 'terms/de.md' });
  assert.equal(read({}), null);
  assert.equal(read({ theme: 'theme/missing.json' }), 'Invalid', 'a theme that is not pinned');
  assert.equal(read({ about: '../about.json' }), 'Invalid');
  assert.equal(read({ about: 7 }), 'Invalid');
  assert.equal(read({ terms: { en: 'terms/en.md', 'pt-BR-x': 'terms/de.md' } }), 'Invalid', 'more than one subtag');
  assert.equal(read({ terms: { en: 'terms/en.md', EN: 'terms/de.md' } }), 'Invalid');
  assert.equal(read({ terms: { de: 'terms/de.md' } }), 'Invalid', 'English is required');
  assert.equal(read({ terms: { en: 'terms/unpinned.md' } }), 'Invalid');
  assert.equal(read({ terms: 'terms/en.md' }), 'Invalid');
  assert.equal(read({ terms: {} }), null, 'an empty terms object is fine');
  const languages = (count) => Object.fromEntries(Array.from({ length: count }, (_, i) => [i === 0 ? 'en' : `a${String.fromCharCode(96 + i)}`, 'terms/en.md']));
  assert.equal(read({ terms: languages(16) }), null);
  assert.equal(read({ terms: languages(17) }), 'Invalid');
});

test('an index with an unpaired surrogate is refused by the reader, like the launcher refuses it', () => {
  const lone = String.fromCharCode(0xd83d);
  assert.equal(failure(() => idx.readIndex(envelopeOf(idx.buildPayload([entry('ab-cd', { name: `Bad${lone}` })], settings)), keys)), 'Invalid');
  assert.equal(failure(() => idx.readIndex(envelopeOf(idx.buildPayload([entry('ab-cd', { name: 'Fine \u{1F600}' })], settings)), keys)), null);
});

test('signing stops before a payload the launcher would refuse can be published', () => {
  const dir = workspace();
  try {
    fs.writeFileSync(path.join(dir, 'servers', 'ab-cd.json'), JSON.stringify(entry('ab-cd', { terms: { en: 'servers.json', 'pt-BR-x': 'servers.json' } })));
    const run = sign(dir, ['--throwaway']);
    assert.equal(run.status, 1);
    assert.ok(!fs.existsSync(path.join(dir, 'site')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const publish = fs.readFileSync(path.join(root, '.github', 'workflows', 'publish.yml'), 'utf8');

test('publishing refuses to sign anything but the current head of the default branch', () => {
  assert.match(publish, /git\/ref\/heads\/\$BRANCH/);
  assert.match(publish, /"\$HEAD_SHA" != "\$RUN_SHA"/);
  assert.match(publish, /re-run of an old commit/);
  assert.match(publish, /if: needs\.gate\.outputs\.enabled == 'true' && github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/);
});

test('cloudflare credentials live in an environment, a missing one is loud, and verify covers every configured host', () => {
  const cloudflare = publish.slice(publish.indexOf('  deploy-cloudflare:'), publish.indexOf('  verify:'));
  assert.match(cloudflare, /environment: cloudflare/);
  assert.match(cloudflare, /::warning::Cloudflare Pages is not configured/);
  assert.match(cloudflare, /GITHUB_STEP_SUMMARY/);
  const verify = publish.slice(publish.indexOf('  verify:'));
  assert.match(verify, /--list-required "\$SKIPPED"/);
  assert.doesNotMatch(verify, /'github-pages'/);
  assert.match(verify, /REGISTRY_SKIPPED_MIRRORS/);
});

test('verify-mirrors lists every configured host unless one is explicitly skipped', () => {
  const list = (...args) => spawnSync(process.execPath, [path.join(root, 'tools', 'verify-mirrors.js'), '--list-required', ...args]).stdout.toString();
  assert.equal(list(''), 'github-pages,cloudflare-pages');
  assert.equal(list('cloudflare-pages'), 'github-pages');
  assert.equal(list(' cloudflare-pages , github-pages'), '');
});
