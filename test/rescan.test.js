'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkPinned, decide } = require('../tools/lib/rescan');
const { scan, Budget } = require('../tools/lib/virustotal');
const { FetchError } = require('../tools/lib/net');
const { makeSite, fakeFetcher, MIRROR_A, MIRROR_B } = require('./helpers/site');

const soon = () => Date.now() + 60000;

test('an unchanged community is left alone', async () => {
  const site = makeSite();
  const pinned = await checkPinned(site.entry, fakeFetcher(site), soon());
  assert.deepEqual(pinned, { changed: [], unreachable: [] });
  assert.deepEqual(decide(pinned, []), { action: 'ok', reasons: [], notes: [] });
});

test('a pinned file that changed on any mirror demotes the entry', async () => {
  const site = makeSite();
  const swapped = { [MIRROR_B]: { 'Profile/update.info': Buffer.from('MANIFEST 3 sha256\n') } };
  const pinned = await checkPinned(site.entry, fakeFetcher(site, { overrides: swapped }), soon());
  assert.equal(pinned.changed.length, 1);
  const decision = decide(pinned, []);
  assert.equal(decision.action, 'demote');
  assert.match(decision.reasons[0], /Profile\/update\.info on mirror 2 no longer matches its pinned digest/);
});

test('a removed file counts as a change, an unreachable mirror does not', async () => {
  const site = makeSite();
  const gone = { [MIRROR_A]: { 'about.json': new FetchError('HTTP_STATUS', 'HTTP 404', { status: 404 }) } };
  const removed = decide(await checkPinned(site.entry, fakeFetcher(site, { overrides: gone }), soon()), []);
  assert.equal(removed.action, 'demote');
  assert.match(removed.reasons[0], /about\.json is no longer served by mirror 1/);

  const outage = decide(await checkPinned(site.entry, fakeFetcher(site, { down: [MIRROR_A] }), soon()), []);
  assert.equal(outage.action, 'ok');
  assert.deepEqual(outage.notes, ['mirror 1 could not be reached']);
});

test('a newly flagged file demotes, a quota shortfall only leaves a note', () => {
  const none = { changed: [], unreachable: [] };
  const flagged = [{ status: 'flagged', paths: ['Profile/Bad.dll'], malicious: 9, suspicious: 1, total: 70 }];
  assert.match(decide(none, flagged).reasons[0], /Profile\/Bad\.dll is now flagged by 10 of 70 engines/);
  const queued = decide(none, [{ status: 'queued', paths: ['x.dll'] }]);
  assert.equal(queued.action, 'ok');
  assert.match(queued.notes[0], /1 files could not be scanned/);
});

test('a stale report is re-analysed and the old one is kept if the new one is not ready', async () => {
  const day = 24 * 3600 * 1000;
  const old = { malicious: 0, suspicious: 0, total: 70, date: Math.floor((Date.now() - 30 * day) / 1000) };
  const calls = [];
  const client = {
    lookup: async () => old,
    reanalyse: async (sha) => { calls.push('reanalyse'); return `id-${sha[0]}`; },
    analysis: async () => ({ malicious: 8, suspicious: 0, total: 70, date: 1 })
  };
  let time = 1_000_000;
  const budget = new Budget({ perMinute: 4, perDay: 500, now: () => time, sleep: async (ms) => { time += ms; } });
  const target = { sha256: 'a'.repeat(64), size: 5, paths: ['x.dll'] };
  const options = { client, budget, cache: { results: {} }, benign: new Map(), threshold: 5, deadline: time + 1e7, maxUploadBytes: 10, download: async () => null, reanalyseAfterMs: 7 * day };
  const [fresh] = await scan([target], options);
  assert.equal(fresh.status, 'flagged');
  assert.deepEqual(calls, ['reanalyse']);

  const stuck = { ...options, budget: new Budget({ perMinute: 4, perDay: 500, now: () => time, sleep: async (ms) => { time += ms; } }), cache: { results: {} }, client: { ...client, analysis: async () => null }, deadline: time + 20000 };
  const [kept] = await scan([target], stuck);
  assert.equal(kept.status, 'clean');
  assert.equal(kept.note, 'newer analysis pending');
});

test('the rescan command works without a VirusTotal key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-rescan-'));
  try {
    fs.mkdirSync(path.join(dir, 'servers'));
    const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'rescan.js'), '--servers', path.join(dir, 'servers'), '--out', path.join(dir, 'out.json'), '--cache', path.join(dir, 'cache.json')], { env: { PATH: process.env.PATH }, cwd: path.join(__dirname, '..') });
    assert.equal(run.status, 0, run.stderr.toString());
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8')), { entries: [], virustotal: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
