'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Budget, QuotaError, createClient, scan, classify } = require('../tools/lib/virustotal');
const { renderScan, renderSkipped, MARKER } = require('../tools/lib/vt-report');
const { collectTargets } = require('../tools/lib/scan-targets');
const { makeSite, fakeFetcher } = require('./helpers/site');

function clock() {
  const state = { now: 1_000_000, slept: 0 };
  return { state, now: () => state.now, sleep: async (ms) => { state.now += ms; state.slept += ms; } };
}
const h = (c) => c.repeat(64);
const target = (c, size = 10) => ({ sha256: h(c), size, paths: [`Profile/${c}.dll`] });

function fakeClient({ known = {}, analyses = {}, fail = {} } = {}) {
  const calls = [];
  return {
    calls,
    async lookup(sha) {
      calls.push(['lookup', sha[0]]);
      if (fail[sha[0]]) throw fail[sha[0]];
      return known[sha[0]] ?? null;
    },
    async upload(name) { calls.push(['upload', name]); return `analysis-${name}`; },
    async analysis(id) { calls.push(['analysis', id]); const next = analyses[id]; return typeof next === 'function' ? next() : next ?? null; }
  };
}
const options = (extra = {}) => {
  const c = clock();
  return {
    c,
    opts: {
      budget: new Budget({ perMinute: 4, perDay: 500, now: c.now, sleep: c.sleep }),
      cache: { results: {}, ledger: [] }, benign: new Map(), threshold: 5, deadline: c.now() + 3_600_000, maxUploadBytes: 100,
      download: async () => Buffer.from('bytes'), ...extra
    }
  };
};

test('the budget spaces requests to the per-minute limit', async () => {
  const c = clock();
  const budget = new Budget({ perMinute: 4, perDay: 500, now: c.now, sleep: c.sleep });
  for (let i = 0; i < 8; i++) assert.equal(await budget.take(c.now() + 10 * 60000), true);
  assert.ok(c.state.slept >= 60000, `slept ${c.state.slept}`);
  const stamps = budget.ledger.slice().sort((a, b) => a - b);
  for (let i = 4; i < stamps.length; i++) assert.ok(stamps[i] - stamps[i - 4] >= 60000);
});

test('the budget refuses when the deadline would pass or the day is used up', async () => {
  const c = clock();
  const budget = new Budget({ perMinute: 1, perDay: 5, reserve: 2, now: c.now, sleep: c.sleep });
  assert.equal(await budget.take(c.now() + 1000), true);
  assert.equal(await budget.take(c.now() + 1000), false);
  const day = new Budget({ perMinute: 100, perDay: 5, reserve: 2, now: c.now, sleep: c.sleep });
  for (let i = 0; i < 3; i++) assert.equal(await day.take(c.now() + 1e9), true);
  assert.equal(await day.take(c.now() + 1e9), false);
  assert.equal(day.remainingToday, 0);
});

test('requests older than a day stop counting', () => {
  const c = clock();
  const budget = new Budget({ perMinute: 4, perDay: 3, ledger: [c.now() - 90_000_000, c.now() - 1000], now: c.now, sleep: c.sleep });
  assert.equal(budget.remainingToday, 2);
});

test('known files are looked up by hash and never uploaded', async () => {
  const { opts } = options();
  const client = fakeClient({ known: { a: { malicious: 0, suspicious: 0, total: 70 }, b: { malicious: 2, suspicious: 1, total: 70 }, c: { malicious: 9, suspicious: 0, total: 70 } } });
  const results = await scan([target('a'), target('b'), target('c')], { ...opts, client });
  assert.deepEqual(results.map((r) => r.status), ['clean', 'detections', 'flagged']);
  assert.deepEqual(client.calls.map((call) => call[0]), ['lookup', 'lookup', 'lookup']);
});

test('benign hashes and cached results cost no request', async () => {
  const { opts } = options();
  opts.benign.set(h('a'), 'BepInEx');
  opts.cache.results[h('b')] = { at: Date.now(), result: { malicious: 0, suspicious: 0, total: 70 } };
  opts.cache.results[h('c')] = { at: Date.now() - 8 * 24 * 3600 * 1000, result: { malicious: 0, suspicious: 0, total: 70 } };
  const client = fakeClient({ known: { c: { malicious: 1, suspicious: 0, total: 70 } } });
  const results = await scan([target('a'), target('b'), target('c')], { ...opts, client });
  assert.deepEqual(results.map((r) => r.status), ['benign', 'clean', 'detections']);
  assert.deepEqual(client.calls, [['lookup', 'c']]);
});

test('unknown files are uploaded, then collected, within the size cap', async () => {
  const { opts } = options();
  const client = fakeClient({ analyses: { 'analysis-d.dll': { malicious: 6, suspicious: 0, total: 70 } } });
  const results = await scan([target('d'), target('e', 1000)], { ...opts, client });
  assert.deepEqual(results.map((r) => [r.sha256[0], r.status]), [['d', 'flagged'], ['e', 'too-large']]);
  assert.ok(client.calls.some((call) => call[0] === 'upload'));
  assert.equal(opts.cache.results[h('d')].result.malicious, 6);
});

test('an analysis that does not finish stays pending, and an upload that cannot be fetched is an error', async () => {
  const { opts } = options({ deadline: Date.now() + 100 });
  opts.deadline = opts.budget.now() + 20000;
  const client = fakeClient();
  const pending = await scan([target('d')], { ...opts, client });
  assert.equal(pending[0].status, 'analysis-pending');
  const { opts: again } = options({ download: async () => null });
  assert.equal((await scan([target('d')], { ...again, client: fakeClient() }))[0].status, 'error');
});

test('quota exhaustion queues instead of failing', async () => {
  const { opts } = options();
  opts.budget = new Budget({ perMinute: 4, perDay: 2, now: opts.budget.now, sleep: opts.budget.sleep });
  const client = fakeClient({ known: { a: { malicious: 0, suspicious: 0, total: 1 }, b: { malicious: 0, suspicious: 0, total: 1 }, c: { malicious: 0, suspicious: 0, total: 1 } } });
  assert.deepEqual((await scan([target('a'), target('b'), target('c')], { ...opts, client })).map((r) => r.status), ['clean', 'clean', 'queued']);
  const limited = options();
  const rate = fakeClient({ fail: { a: new QuotaError('429') } });
  assert.equal((await scan([target('a')], { ...limited.opts, client: rate }))[0].status, 'queued');
});

test('the threshold decides the label, never a failure', () => {
  assert.equal(classify({ malicious: 4, suspicious: 0 }, 5), 'detections');
  assert.equal(classify({ malicious: 3, suspicious: 2 }, 5), 'flagged');
  assert.equal(classify({ malicious: 0, suspicious: 0 }, 5), 'clean');
});

test('the client speaks the VirusTotal API and keeps the key in a header', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, key: req.headers['x-apikey'], type: req.headers['content-type'] });
      res.setHeader('content-type', 'application/json');
      if (req.url === `/files/${h('1')}`) return res.end(JSON.stringify({ data: { attributes: { last_analysis_stats: { malicious: 2, suspicious: 1, undetected: 60, harmless: 7 }, last_analysis_date: 5 } } }));
      if (req.url === `/files/${h('2')}`) { res.statusCode = 404; return res.end('{}'); }
      if (req.url === `/files/${h('3')}`) { res.statusCode = 429; return res.end('{}'); }
      if (req.method === 'POST') return res.end(JSON.stringify({ data: { id: 'abc==' } }));
      return res.end(JSON.stringify({ data: { attributes: { status: 'completed', stats: { malicious: 1, undetected: 9 } } } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const client = createClient({ apiKey: 'k-123', baseUrl: `http://127.0.0.1:${server.address().port}` });
    assert.deepEqual(await client.lookup(h('1')), { malicious: 2, suspicious: 1, total: 70, date: 5 });
    assert.equal(await client.lookup(h('2')), null);
    await assert.rejects(client.lookup(h('3')), QuotaError);
    assert.equal(await client.upload('a.dll', Buffer.from('x')), 'abc==');
    assert.equal((await client.analysis('abc==')).total, 10);
    assert.ok(seen.every((call) => call.key === 'k-123'));
    assert.match(seen.find((call) => call.method === 'POST').type, /^multipart\/form-data/);
  } finally {
    server.close();
  }
});

test('the report is a signal, lists what needs a look and survives hostile paths', () => {
  const files = [
    { ...target('a'), paths: ['Profile/<img src=x>@everyone.dll'], status: 'flagged', malicious: 7, suspicious: 0, total: 70 },
    { ...target('b'), status: 'clean', malicious: 0, suspicious: 0, total: 70 },
    { ...target('c'), status: 'queued' },
    { ...target('d'), status: 'benign' }
  ];
  const text = renderScan([{ id: 'test-community', files, problems: ['update.info could not be downloaded with its pinned digest'] }], { threshold: 5, remainingToday: 321, commit: 'abcdef012345' });
  assert.ok(text.startsWith(MARKER));
  assert.match(text, /1 file for a maintainer to look at/);
  assert.match(text, /not a verdict/);
  assert.match(text, /7 of 70/);
  assert.match(text, /321 requests left/);
  assert.doesNotMatch(text.replace(/`[^`\n]*`/g, ''), /<img|@(?!​)/);
  assert.match(renderSkipped('nothing configured'), /not run/);
});

test('scan targets come from the pinned manifests only', async () => {
  const site = makeSite();
  const { targets, problems } = await collectTargets(site.entry, fakeFetcher(site), Date.now() + 60000);
  assert.deepEqual(problems, []);
  assert.deepEqual(targets.filter((t) => !t.lookupOnly).flatMap((t) => t.paths).sort(), ['Profile/BepInEx/plugins/Demo/Demo.dll', 'Profile/BepInEx/plugins/Extra/Extra.dll']);
  assert.deepEqual(targets.filter((t) => t.lookupOnly).flatMap((t) => t.paths), ['Profile/valheim.exe']);
  const tampered = { ...site.entry, digests: { ...site.entry.digests, 'Profile/update.info': h('0') } };
  const result = await collectTargets(tampered, fakeFetcher(site), Date.now() + 60000);
  assert.match(result.problems[0], /update\.info could not be downloaded with its pinned digest/);
});

test('without a key the command skips cleanly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-vt-'));
  try {
    const env = { PATH: process.env.PATH };
    const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'virustotal.js'), '--markdown', path.join(dir, 'vt.md')], { env });
    assert.equal(run.status, 0, run.stderr.toString());
    assert.match(fs.readFileSync(path.join(dir, 'vt.md'), 'utf8'), /not run/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the benign list and the config are well formed', () => {
  const list = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'virustotal-benign.json'), 'utf8')).benign;
  assert.ok(list.length > 10);
  assert.equal(new Set(list.map((item) => item.sha256)).size, list.length);
  for (const item of list) {
    assert.match(item.sha256, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(item.note, /[A-Za-z]:\\|\/Users\/|\/home\//);
  }
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'virustotal.json'), 'utf8'));
  assert.deepEqual([config.perMinute, config.perDay], [4, 500]);
  assert.ok(config.threshold >= 1 && config.reservedForRescan < config.perDay);
});

test('benign.js adds hashes with the note and no duplicates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-benign-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.dll'), 'one');
    const list = path.join(dir, 'list.json');
    const run = () => spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'benign.js'), '--note', 'Loader 1', '--list', list, dir, 'a.dll']);
    assert.equal(run().status, 0);
    assert.equal(run().status, 0);
    const data = JSON.parse(fs.readFileSync(list, 'utf8'));
    assert.equal(data.benign.length, 1);
    assert.equal(data.benign[0].note, 'Loader 1: a.dll');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a report with no engine results is not clean and is never cached', async () => {
  const { opts } = options();
  const client = fakeClient({ known: { a: { malicious: 0, suspicious: 0, total: 0, date: null } }, analyses: { 'analysis-b.dll': { malicious: 0, suspicious: 0, total: 0 } } });
  const results = await scan([target('a'), target('b')], { ...opts, client });
  assert.deepEqual(results.map((r) => r.status), ['analysis-pending', 'analysis-pending']);
  assert.deepEqual(opts.cache.results, {});
  const empty = createClient({ apiKey: 'k', fetchImpl: async () => new Response(JSON.stringify({ data: { attributes: { status: 'completed', stats: {} } } })) });
  assert.equal(await empty.analysis('x'), null);
});

test('game files are looked up by hash and never uploaded', async () => {
  const { opts } = options();
  const client = fakeClient({ known: { b: { malicious: 0, suspicious: 0, total: 70 } } });
  const results = await scan([{ ...target('a'), lookupOnly: true }, { ...target('b'), lookupOnly: true }], { ...opts, client });
  assert.deepEqual(results.map((r) => r.status), ['unknown', 'clean']);
  assert.deepEqual(client.calls.map((call) => call[0]), ['lookup', 'lookup']);
  assert.match(renderScan([{ id: 'x-y', files: results }], { threshold: 5, remainingToday: 1, commit: 'c' }), /game file not known to VirusTotal/);
});

test('the scan can be held back with a stated reason and no key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-vt-'));
  try {
    const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'virustotal.js'), '--skip-reason', 'A maintainer starts the scan.', '--markdown', path.join(dir, 'vt.md')], { env: { PATH: process.env.PATH, VIRUSTOTAL_API_KEY: 'would-be-secret' } });
    assert.equal(run.status, 0, run.stderr.toString());
    assert.match(fs.readFileSync(path.join(dir, 'vt.md'), 'utf8'), /A maintainer starts the scan/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the scan workflow only spends quota for maintainers or a labelled pull request', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'virustotal.yml'), 'utf8');
  assert.match(text, /types: \[[^\]]*labeled\]/);
  assert.match(text, /OWNER\|MEMBER\|COLLABORATOR/);
  assert.match(text, /steps\.allow\.outputs\.allowed == 'true'/);
  assert.match(text, /environment: virustotal/);
  assert.match(text, /timeout-minutes: 55/);
  assert.ok(text.indexOf('VIRUSTOTAL_API_KEY') > text.indexOf("allowed == 'true'"), 'the key is only set on the gated step');
});
