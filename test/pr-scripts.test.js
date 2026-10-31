'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const MARKER = '<!-- registry-validation -->';

async function fakeGitHub(routes) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      calls.push({ method: req.method, url: req.url, body, auth: req.headers.authorization });
      const handler = routes(req.method, req.url.split("?")[0], req.url);
      if (!handler) {
        res.statusCode = 404;
        return res.end('{}');
      }
      res.statusCode = handler.status || 200;
      res.setHeader('content-type', handler.raw ? 'application/octet-stream' : 'application/json');
      return res.end(handler.raw ? handler.raw : JSON.stringify(handler.json));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { calls, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

function runScript(script, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, script), ...args], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

test('the pull request step reads entries as data and flags everything else', async () => {
  const entry = JSON.stringify({ id: 'a-community' });
  const github = await fakeGitHub((method, route) => {
    if (route === '/repos/o/r/pulls/7') return { json: { head: { sha: HEAD } } };
    if (route === '/repos/o/r/pulls/7/files') {
      return {
        json: [
          { filename: 'servers/a-community.json', status: 'added', sha: 'sha-a' },
          { filename: 'servers/huge.json', status: 'added', sha: 'sha-huge' },
          { filename: 'servers/gone.json', status: 'removed', sha: 'sha-gone' },
          { filename: 'servers/notes.txt', status: 'added', sha: 'sha-notes' },
          { filename: 'servers/new-name.json', status: 'renamed', previous_filename: 'servers/old-name.json', sha: 'sha-new' },
          { filename: 'tools/validate.js', status: 'modified', sha: 'sha-tool' }
        ]
      };
    }
    if (route === '/repos/o/r/git/blobs/sha-a' || route === '/repos/o/r/git/blobs/sha-new') return { raw: entry };
    if (route === '/repos/o/r/git/blobs/sha-huge') return { raw: Buffer.alloc(70 * 1024, 0x20) };
    return null;
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-pr-'));
  const output = path.join(dir, 'github-output');
  try {
    const { code, out } = await runScript('tools/ci/fetch-pr-entries.js', [path.join(dir, 'pr')], {
      GITHUB_API_URL: github.url, GITHUB_REPOSITORY: 'o/r', PR_NUMBER: '7', GITHUB_TOKEN: 'token-1', PR_HEAD_SHA: HEAD, PR_AUTHOR_ASSOCIATION: 'NONE', GITHUB_OUTPUT: output
    });
    assert.equal(code, 0, out);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'pr', 'servers')).sort(), ['a-community.json', 'new-name.json']);
    assert.equal(fs.readFileSync(path.join(dir, 'pr', 'servers', 'a-community.json'), 'utf8'), entry);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'pr', 'meta.json'), 'utf8'));
    assert.equal(meta.commit, HEAD);
    assert.deepEqual(meta.removed.sort(), ['gone.json', 'old-name.json']);
    const messages = meta.problems.map((problem) => `${problem.level}: ${problem.message}`).join('\n');
    assert.match(messages, /error: servers\/huge\.json is larger than 64 KiB/);
    assert.match(messages, /error: servers\/notes\.txt is not a servers\/<id>\.json file/);
    assert.match(messages, /error: This pull request also changes 1 file\(s\) outside servers\/ \(tools\/validate\.js\)/);
    assert.equal(fs.readFileSync(output, 'utf8'), 'relevant=true\n');
    assert.ok(github.calls.every((call) => call.auth === 'Bearer token-1'));
  } finally {
    await github.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('maintainers only get a warning for files outside servers/, and other pull requests are not relevant', async () => {
  const github = await fakeGitHub((method, route) => (route === '/repos/o/r/pulls/8/files' ? { json: [{ filename: 'tools/validate.js', status: 'modified', sha: 'x' }] } : route === '/repos/o/r/pulls/8' ? { json: { head: { sha: HEAD } } } : null));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-pr-'));
  try {
    const env = { GITHUB_API_URL: github.url, GITHUB_REPOSITORY: 'o/r', PR_NUMBER: '8', GITHUB_TOKEN: 't', PR_HEAD_SHA: HEAD, PR_AUTHOR_ASSOCIATION: 'OWNER', GITHUB_OUTPUT: path.join(dir, 'out') };
    const { code } = await runScript('tools/ci/fetch-pr-entries.js', [path.join(dir, 'pr')], env);
    assert.equal(code, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'pr', 'meta.json'), 'utf8')).problems[0].level, 'warning');
    assert.equal(fs.readFileSync(path.join(dir, 'out'), 'utf8'), 'relevant=false\n');
  } finally {
    await github.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the comment step edits its own comment and nobody else is touched', async () => {
  const github = await fakeGitHub((method, route) => {
    if (method === 'GET' && route === '/repos/o/r/issues/7/comments') {
      return { json: [
        { id: 1, user: { login: 'mallory' }, body: `${MARKER}\nforged` },
        { id: 2, user: { login: 'github-actions[bot]' }, body: `${MARKER}\nold` }
      ] };
    }
    if (method === 'PATCH' && route === '/repos/o/r/issues/comments/2') return { json: {} };
    if (method === 'POST' && route === '/repos/o/r/issues/9/comments') return { json: {} };
    if (method === 'GET' && route === '/repos/o/r/issues/9/comments') return { json: [{ id: 3, user: { login: 'mallory' }, body: `${MARKER}\nforged` }] };
    return null;
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-comment-'));
  try {
    const file = path.join(dir, 'comment.md');
    fs.writeFileSync(file, `${MARKER}\nnew text`);
    const env = { GITHUB_API_URL: github.url, GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't' };
    assert.equal((await runScript('tools/ci/post-comment.js', [file, MARKER], { ...env, PR_NUMBER: '7' })).code, 0);
    assert.equal((await runScript('tools/ci/post-comment.js', [file, MARKER], { ...env, PR_NUMBER: '9' })).code, 0);
    const writes = github.calls.filter((call) => call.method !== 'GET').map((call) => `${call.method} ${call.url}`);
    assert.deepEqual(writes, ['PATCH /repos/o/r/issues/comments/2', 'POST /repos/o/r/issues/9/comments']);

    fs.writeFileSync(file, 'no marker here');
    const refused = await runScript('tools/ci/post-comment.js', [file, MARKER], { ...env, PR_NUMBER: '7' });
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /does not start with its marker/);
  } finally {
    await github.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the validate command reports an invalid entry without touching the network', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-cli-'));
  try {
    fs.mkdirSync(path.join(dir, 'servers'));
    fs.writeFileSync(path.join(dir, 'servers', 'broken.json'), JSON.stringify({ id: 'broken', name: 'Broken', status: 'approved', mirrors: ['http://insecure.test/'], digests: { 'servers.json': 'a'.repeat(64) } }));
    const result = await runScript('tools/validate.js', ['--servers', path.join(dir, 'servers'), '--out', path.join(dir, 'out.json'), '--markdown', path.join(dir, 'c.md')], {});
    assert.equal(result.code, 1);
    assert.match(result.out, /servers\/broken\.json: fail/);
    const run = JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8'));
    assert.equal(run.entries[0].networkChecked, false);
    assert.ok(fs.readFileSync(path.join(dir, 'c.md'), 'utf8').startsWith(MARKER));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the validate command succeeds when there is nothing to check', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-cli-'));
  try {
    fs.mkdirSync(path.join(dir, 'servers'));
    fs.writeFileSync(path.join(dir, 'servers', '.gitkeep'), '');
    const result = await runScript('tools/validate.js', ['--servers', path.join(dir, 'servers'), '--entries-dir', path.join(dir, 'servers')], {});
    assert.equal(result.code, 0, result.out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const HEAD = 'a'.repeat(40);

test('the pull request step refuses to read a pull request that moved since the event', async () => {
  const github = await fakeGitHub((method, route) => {
    if (route === '/repos/o/r/pulls/9') return { json: { head: { sha: 'b'.repeat(40) } } };
    if (route === '/repos/o/r/pulls/9/files') return { json: [] };
    return null;
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-pr-'));
  try {
    const result = await runScript('tools/ci/fetch-pr-entries.js', [path.join(dir, 'pr')], { GITHUB_API_URL: github.url, GITHUB_REPOSITORY: 'o/r', PR_NUMBER: '9', GITHUB_TOKEN: 't', PR_HEAD_SHA: HEAD });
    assert.equal(result.code, 2);
    assert.match(result.out, /moved from a{40} to b{40}/);
    const missing = await runScript('tools/ci/fetch-pr-entries.js', [path.join(dir, 'pr')], { GITHUB_API_URL: github.url, GITHUB_REPOSITORY: 'o/r', PR_NUMBER: '9', GITHUB_TOKEN: 't' });
    assert.equal(missing.code, 2);
    assert.match(missing.out, /PR_HEAD_SHA/);
  } finally {
    await github.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a pull request with 300 files cannot hide its entries: it is relevant and an error', async () => {
  const filler = Array.from({ length: 300 }, (_, i) => ({ filename: `docs/f${i}.md`, status: 'added', sha: `s${i}` }));
  const github = await fakeGitHub((method, route, url) => {
    if (route === '/repos/o/r/pulls/10') return { json: { head: { sha: HEAD } } };
    if (route === '/repos/o/r/pulls/10/files') {
      const page = Number(/[?&]page=(\d+)/.exec(url)[1]);
      return { json: filler.slice((page - 1) * 100, page * 100) };
    }
    return null;
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-pr-'));
  try {
    const output = path.join(dir, 'out');
    const result = await runScript('tools/ci/fetch-pr-entries.js', [path.join(dir, 'pr')], { GITHUB_API_URL: github.url, GITHUB_REPOSITORY: 'o/r', PR_NUMBER: '10', GITHUB_TOKEN: 't', PR_HEAD_SHA: HEAD, PR_AUTHOR_ASSOCIATION: 'NONE', GITHUB_OUTPUT: output });
    assert.equal(result.code, 0, result.out);
    assert.equal(fs.readFileSync(output, 'utf8'), 'relevant=true\n');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'pr', 'meta.json'), 'utf8'));
    assert.ok(meta.problems.some((problem) => problem.level === 'error' && /300 files or more/.test(problem.message)));
  } finally {
    await github.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the validate command fails an incomplete run and an index that would not fit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-cli-'));
  try {
    fs.mkdirSync(path.join(dir, 'servers'));
    const digests = Object.fromEntries(Array.from({ length: 64 }, (_, n) => [`dir/file-number-${n}.json`, 'ab'.repeat(32)]));
    for (let i = 0; i < 120; i++) {
      const id = `h${String(i).padStart(4, '0')}`;
      fs.writeFileSync(path.join(dir, 'servers', `${id}.json`), JSON.stringify({ id, name: `Heavy ${i}`, status: 'approved', mirrors: ['http://insecure.test/'], digests }));
    }
    fs.mkdirSync(path.join(dir, 'pr'));
    const valid = { id: 'new-one', name: 'New One', status: 'approved', mirrors: ['https://files.example.test/'], digests };
    fs.writeFileSync(path.join(dir, 'pr', 'new-one.json'), JSON.stringify(valid));
    for (let i = 0; i < 120; i++) {
      const id = `h${String(i).padStart(4, '0')}`;
      fs.writeFileSync(path.join(dir, 'servers', `${id}.json`), JSON.stringify({ ...valid, id, name: `Heavy ${i}` }));
    }
    const result = await runScript('tools/validate.js', ['--servers', path.join(dir, 'servers'), '--base', path.join(dir, 'servers'), '--entries-dir', path.join(dir, 'pr'), '--deadline-minutes', '0'], {});
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /incomplete|fail/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
