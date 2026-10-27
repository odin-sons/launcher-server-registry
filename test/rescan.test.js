'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
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

async function fakeRepo(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      const answer = handler(req.method, req.url.split('?')[0]) || { status: 404, json: {} };
      res.statusCode = answer.status || 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(answer.json));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { calls, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

function runOpener(cwd, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'tools', 'ci', 'open-rescan-prs.js'), 'rescan.json'], { cwd, env: { PATH: process.env.PATH, ...env } });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

test('the opener makes one branch, one edit and one pull request per demoted entry', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-opener-'));
  const original = '{\n  "id": "ab-cd",\n  "status": "approved",\n  "name": "Ab"\n}\n';
  fs.mkdirSync(path.join(dir, 'servers'));
  fs.writeFileSync(path.join(dir, 'servers', 'ab-cd.json'), original);
  fs.writeFileSync(path.join(dir, 'servers', 'other.json'), '{"status":"approved"}');
  const decisions = { entries: [
    { id: 'ab-cd', action: 'demote', reasons: ['x.dll is now <b>flagged</b> @everyone'], notes: [] },
    { id: 'other', action: 'ok', reasons: [], notes: [] },
    { id: '../evil', action: 'demote', reasons: ['x'], notes: [] },
    { id: 'missing', action: 'demote', reasons: ['x'], notes: [] }
  ] };
  fs.writeFileSync(path.join(dir, 'rescan.json'), JSON.stringify(decisions));
  const repo = await fakeRepo((method, route) => {
    if (route === '/repos/o/r/git/ref/heads/rescan/ab-cd') return { status: 404, json: {} };
    if (route === '/repos/o/r/git/ref/heads/main') return { json: { object: { sha: 'basesha' } } };
    if (route === '/repos/o/r/git/refs') return { status: 201, json: {} };
    if (route === '/repos/o/r/contents/servers/ab-cd.json' && method === 'GET') return { json: { sha: 'filesha', content: Buffer.from(original).toString('base64') } };
    if (route === '/repos/o/r/contents/servers/ab-cd.json' && method === 'PUT') return { json: {} };
    if (route === '/repos/o/r/pulls') return { status: 201, json: {} };
    return null;
  });
  try {
    const result = await runOpener(dir, { GITHUB_API_URL: repo.url, GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't', DEFAULT_BRANCH: 'main', RUN_URL: 'https://example.test/run' });
    assert.equal(result.code, 0, result.out);
    const writes = repo.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.url}`);
    assert.deepEqual(writes, ['POST /repos/o/r/git/refs', 'PUT /repos/o/r/contents/servers/ab-cd.json', 'POST /repos/o/r/pulls']);
    const put = repo.calls.find((c) => c.method === 'PUT').body;
    assert.equal(Buffer.from(put.content, 'base64').toString(), original.replace('"approved"', '"needs-approval"'));
    assert.equal(put.branch, 'rescan/ab-cd');
    const pr = repo.calls.find((c) => c.url === '/repos/o/r/pulls').body;
    assert.equal(pr.base, 'main');
    assert.doesNotMatch(pr.body, /<b>|@everyone/);
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an existing rescan branch is not touched, and a refused pull request becomes an issue', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-opener-'));
  fs.mkdirSync(path.join(dir, 'servers'));
  fs.writeFileSync(path.join(dir, 'servers', 'ab-cd.json'), '{"status":"approved"}');
  fs.writeFileSync(path.join(dir, 'rescan.json'), JSON.stringify({ entries: [{ id: 'ab-cd', action: 'demote', reasons: ['r'], notes: [] }] }));
  let exists = true;
  const repo = await fakeRepo((method, route) => {
    if (route === '/repos/o/r/git/ref/heads/rescan/ab-cd') return exists ? { json: {} } : { status: 404, json: {} };
    if (route === '/repos/o/r/git/ref/heads/main') return { json: { object: { sha: 's' } } };
    if (route === '/repos/o/r/git/refs') return { status: 201, json: {} };
    if (route.startsWith('/repos/o/r/contents/')) return { json: { sha: 'f', content: Buffer.from('{"status":"approved"}').toString('base64') } };
    if (route === '/repos/o/r/pulls') return { status: 403, json: {} };
    if (route === '/repos/o/r/issues') return { status: 201, json: {} };
    return null;
  });
  const env = { GITHUB_API_URL: repo.url, GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't' };
  try {
    assert.equal((await runOpener(dir, env)).code, 0);
    assert.deepEqual(repo.calls.filter((c) => c.method !== 'GET'), []);
    exists = false;
    assert.equal((await runOpener(dir, env)).code, 0);
    assert.ok(repo.calls.some((c) => c.url === '/repos/o/r/issues' && /Re-scan: ab-cd needs approval/.test(c.body.title)));
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
