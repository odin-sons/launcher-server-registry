'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { demoteText } = require('../tools/ci/open-rescan-prs');

async function fakeRepo(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      const answer = handler(req.method, req.url.split('?')[0], req.url) || { status: 404, json: {} };
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

const ORIGINAL = '{\n  "id": "ab-cd",\n  "status": "approved",\n  "name": "Ab"\n}\n';

function workspace(entries, decisions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-opener-'));
  fs.mkdirSync(path.join(dir, 'servers'));
  for (const [name, text] of Object.entries(entries)) fs.writeFileSync(path.join(dir, 'servers', name), text);
  fs.writeFileSync(path.join(dir, 'rescan.json'), JSON.stringify({ entries: decisions }));
  return dir;
}
const demoteAbCd = { id: 'ab-cd', action: 'demote', reasons: ['x.dll is now <b>flagged</b> @everyone'], notes: [] };
const env = (repo) => ({ GITHUB_API_URL: repo.url, GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't', DEFAULT_BRANCH: 'main', RUN_URL: 'https://example.test/run' });

function routes({ branchExists = false, openPulls = [], openIssues = [], pullStatus = 201, putStatus = 200 } = {}) {
  return (method, route) => {
    if (route === '/repos/o/r/git/ref/heads/rescan/ab-cd') return branchExists ? { json: { ref: 'x' } } : { status: 404, json: {} };
    if (route === '/repos/o/r/git/ref/heads/main') return { json: { object: { sha: 'basesha' } } };
    if (route === '/repos/o/r/git/refs/heads/rescan/ab-cd' && method === 'DELETE') return { status: 204, json: null };
    if (route === '/repos/o/r/git/refs' && method === 'POST') return { status: 201, json: {} };
    if (route === '/repos/o/r/contents/servers/ab-cd.json' && method === 'GET') return { json: { sha: 'filesha', content: Buffer.from(ORIGINAL).toString('base64') } };
    if (route === '/repos/o/r/contents/servers/ab-cd.json' && method === 'PUT') return { status: putStatus, json: {} };
    if (route === '/repos/o/r/pulls' && method === 'GET') return { json: openPulls };
    if (route === '/repos/o/r/pulls' && method === 'POST') return { status: pullStatus, json: {} };
    if (route === '/repos/o/r/issues' && method === 'GET') return { json: openIssues };
    if (route === '/repos/o/r/issues' && method === 'POST') return { status: 201, json: {} };
    return null;
  };
}
const writes = (repo) => repo.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.url}`);

test('the status is set on the top level of the parsed file, whatever else it holds', () => {
  const decoy = '{\n  "name": "x",\n  "extra": { "status": "approved" },\n  "status": "approved"\n}\n';
  const out = JSON.parse(demoteText(decoy));
  assert.equal(out.status, 'needs-approval');
  assert.deepEqual(out.extra, { status: 'approved' });
  assert.equal(JSON.parse(demoteText('{"a":"\\"status\\": \\"approved\\"","status":"approved"}')).status, 'needs-approval');
  assert.throws(() => demoteText('{"status":"suspended"}'), /not an approved entry/);
  assert.throws(() => demoteText('[]'), /not an approved entry/);
});

test('the opener makes one branch, one edit and one pull request per demoted entry', async () => {
  const dir = workspace({ 'ab-cd.json': ORIGINAL, 'other.json': '{"status":"approved"}' }, [
    demoteAbCd,
    { id: 'other', action: 'ok', reasons: [], notes: [] },
    { id: '../evil', action: 'demote', reasons: ['x'], notes: [] },
    { id: 'missing', action: 'demote', reasons: ['x'], notes: [] }
  ]);
  const repo = await fakeRepo(routes());
  try {
    const result = await runOpener(dir, env(repo));
    assert.equal(result.code, 0, result.out);
    assert.deepEqual(writes(repo), ['POST /repos/o/r/git/refs', 'PUT /repos/o/r/contents/servers/ab-cd.json', 'POST /repos/o/r/pulls']);
    const put = repo.calls.find((c) => c.method === 'PUT').body;
    assert.equal(JSON.parse(Buffer.from(put.content, 'base64')).status, 'needs-approval');
    const pr = repo.calls.find((c) => c.url === '/repos/o/r/pulls' && c.method === 'POST').body;
    assert.doesNotMatch(pr.body, /<b>|@everyone/);
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an open pull request or an open issue means the entry is already handled', async () => {
  for (const options of [{ openPulls: [{ number: 5 }] }, { openIssues: [{ title: 'Re-scan: ab-cd needs approval' }] }]) {
    const dir = workspace({ 'ab-cd.json': ORIGINAL }, [demoteAbCd]);
    const repo = await fakeRepo(routes({ branchExists: true, ...options }));
    try {
      assert.equal((await runOpener(dir, env(repo))).code, 0);
      assert.deepEqual(writes(repo), []);
    } finally {
      repo.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('a leftover branch without a pull request does not suppress the demotion', async () => {
  const dir = workspace({ 'ab-cd.json': ORIGINAL }, [demoteAbCd]);
  const repo = await fakeRepo(routes({ branchExists: true, openIssues: [{ title: 'Re-scan: ab-cd needs approval', pull_request: {} }] }));
  try {
    assert.equal((await runOpener(dir, env(repo))).code, 0);
    assert.deepEqual(writes(repo), ['DELETE /repos/o/r/git/refs/heads/rescan/ab-cd', 'POST /repos/o/r/git/refs', 'PUT /repos/o/r/contents/servers/ab-cd.json', 'POST /repos/o/r/pulls']);
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failure rolls the branch back, is reported, and does not stop the other entries', async () => {
  const second = '{\n  "id": "zz-yy",\n  "status": "approved"\n}\n';
  const dir = workspace({ 'ab-cd.json': ORIGINAL, 'zz-yy.json': second }, [demoteAbCd, { id: 'zz-yy', action: 'demote', reasons: ['r'], notes: [] }]);
  const base = routes({ putStatus: 500 });
  const repo = await fakeRepo((method, route, url) => {
    if (route.includes('zz-yy')) return { status: 404, json: {} };
    return base(method, route, url);
  });
  try {
    const result = await runOpener(dir, env(repo));
    assert.equal(result.code, 2, result.out);
    assert.match(result.out, /Could not handle: ab-cd, zz-yy|Could not handle: ab-cd/);
    assert.ok(writes(repo).includes('DELETE /repos/o/r/git/refs/heads/rescan/ab-cd'), 'the branch is removed again');
    assert.ok(repo.calls.some((c) => c.url.includes('zz-yy')), 'the second entry was still tried');
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a refused pull request becomes an issue that also stops a second one', async () => {
  const dir = workspace({ 'ab-cd.json': ORIGINAL }, [demoteAbCd]);
  const repo = await fakeRepo(routes({ pullStatus: 403 }));
  try {
    assert.equal((await runOpener(dir, env(repo))).code, 0);
    const issue = repo.calls.find((c) => c.url === '/repos/o/r/issues' && c.method === 'POST');
    assert.equal(issue.body.title, 'Re-scan: ab-cd needs approval');
    assert.match(issue.body.body, /holds the change/);
  } finally {
    repo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
