#!/usr/bin/env node
'use strict';

// Reads the registry entries of a pull request through the API and writes them as plain data. The pull
// request's code is never checked out; nothing it contains is executed.

const fs = require('node:fs');
const path = require('node:path');
const limits = require('../lib/limits');
const { client } = require('../lib/github');

const ENTRY_FILE = /^servers\/([A-Za-z0-9._-]+)$/;
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const MAX_FILES = 300;

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const number = process.env.PR_NUMBER;
  const out = process.argv[2];
  if (!repository || !/^\d+$/.test(number || '') || !out) throw new Error('Usage: GITHUB_REPOSITORY=... PR_NUMBER=... GITHUB_TOKEN=... fetch-pr-entries.js <out-dir>');

  const headSha = process.env.PR_HEAD_SHA;
  if (!/^[0-9a-f]{40}$/.test(headSha || '')) throw new Error('PR_HEAD_SHA must be the commit the event was triggered for.');

  const github = client({ token: process.env.GITHUB_TOKEN, repository });
  const assertHead = async () => {
    const pull = await github.request('GET', `/repos/${repository}/pulls/${number}`);
    if (pull.head.sha !== headSha) throw new Error(`The pull request moved from ${headSha} to ${pull.head.sha} while it was being read; a newer run checks the new commit.`);
  };
  await assertHead();
  const files = await github.paginate(`/repos/${repository}/pulls/${number}/files`, { pages: MAX_FILES / 100 });
  const problems = [];
  const removed = [];
  const outside = [];
  let entryCount = 0;

  fs.mkdirSync(path.join(out, 'servers'), { recursive: true });
  const truncated = files.length >= MAX_FILES;
  if (truncated) problems.push({ level: 'error', message: `The pull request changes ${MAX_FILES} files or more; split it.` });

  for (const file of files) {
    const names = [file.filename];
    if (file.status === 'renamed' && file.previous_filename) {
      if (ENTRY_FILE.test(file.previous_filename)) removed.push(file.previous_filename.slice('servers/'.length));
      else outside.push(file.previous_filename);
    }
    for (const name of names) {
      const match = ENTRY_FILE.exec(name);
      if (!match) {
        outside.push(name);
        continue;
      }
      if (file.status === 'removed') {
        removed.push(match[1]);
        continue;
      }
      if (!match[1].endsWith('.json') || match[1].startsWith('.')) {
        if (match[1] !== '.gitkeep') problems.push({ level: 'error', message: `servers/${match[1]} is not a servers/<id>.json file.` });
        continue;
      }
      if (entryCount >= limits.MAX_ENTRIES_PER_PULL_REQUEST) {
        problems.push({ level: 'error', message: `Only ${limits.MAX_ENTRIES_PER_PULL_REQUEST} entries are checked per pull request; servers/${match[1]} was skipped.` });
        continue;
      }
      const bytes = await github.readBlob(file.sha, limits.MAX_ENTRY_FILE_BYTES);
      if (bytes === null) {
        problems.push({ level: 'error', message: `servers/${match[1]} is larger than ${limits.MAX_ENTRY_FILE_BYTES / limits.KiB} KiB.` });
        continue;
      }
      fs.writeFileSync(path.join(out, 'servers', match[1]), bytes);
      entryCount += 1;
    }
  }

  await assertHead();

  if (outside.length) {
    const level = TRUSTED.has(process.env.PR_AUTHOR_ASSOCIATION || '') ? 'warning' : 'error';
    const shown = outside.slice(0, 5).join(', ');
    problems.push({ level, message: `This pull request also changes ${outside.length} file(s) outside servers/ (${shown}${outside.length > 5 ? ', ...' : ''}). A listing should only add or change servers/<id>.json; a maintainer reviews anything else by hand.` });
  }

  if (process.env.GITHUB_OUTPUT) {
    const relevant = truncated || files.some((file) => file.filename.startsWith('servers/') || (file.previous_filename || '').startsWith('servers/'));
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `relevant=${relevant}\n`);
  }

  fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify({ commit: process.env.PR_HEAD_SHA || '', problems, removed }, null, 2));
  process.stdout.write(`Fetched ${entryCount} entries, ${removed.length} removed, ${outside.length} files outside servers/\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 2;
});
