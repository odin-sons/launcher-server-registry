#!/usr/bin/env node
'use strict';

// Posts a prepared comment on a pull request, or edits the one this workflow posted before. The text is
// data: it must start with the marker, and is cut to the size GitHub allows.

const fs = require('node:fs');
const { client } = require('../lib/github');

const MAX_CHARS = 60000;

async function main() {
  const [file, marker] = process.argv.slice(2);
  const repository = process.env.GITHUB_REPOSITORY;
  const number = process.env.PR_NUMBER;
  if (!file || !marker || !repository || !/^\d+$/.test(number || '')) throw new Error('Usage: GITHUB_REPOSITORY=... PR_NUMBER=... GITHUB_TOKEN=... post-comment.js <file> <marker>');

  let body = fs.readFileSync(file, 'utf8');
  if (!body.startsWith(marker)) throw new Error('The comment does not start with its marker; refusing to post it.');
  if (body.length > MAX_CHARS) body = `${body.slice(0, MAX_CHARS - 100)}\n\n_The comment was cut because it is too long._`;

  const github = client({ token: process.env.GITHUB_TOKEN, repository });
  await github.upsertComment(number, marker, body);
  process.stdout.write('Comment updated\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 2;
});
