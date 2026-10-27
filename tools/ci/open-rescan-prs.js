#!/usr/bin/env node
'use strict';

// Turns the decisions of a re-scan into pull requests that set an entry to needs-approval. The decisions file is
// data: only ids that exist as approved entries on the base branch are acted on, and every text is escaped.

const fs = require('node:fs');
const path = require('node:path');
const { client: githubClient, GitHubError } = require('../lib/github');
const { esc, code } = require('../lib/markdown');

const ID = /^[a-z0-9][a-z0-9-]{1,31}$/;

function demoteText(text) {
  const pattern = /("status"\s*:\s*)"approved"/;
  if (pattern.test(text)) return text.replace(pattern, '$1"needs-approval"');
  const entry = JSON.parse(text);
  entry.status = 'needs-approval';
  return `${JSON.stringify(entry, null, 2)}\n`;
}

function body(item, runUrl) {
  return [
    `Refs odin-sons/Launcher#21`,
    '',
    `The scheduled re-scan moved ${code(item.id)} to \`needs-approval\`. The launcher stops offering it for new installs and pauses its updates until a maintainer has looked again.`,
    '',
    '## Why',
    ...item.reasons.map((reason) => `- ${esc(reason)}`),
    ...(item.notes.length ? ['', '## Also', ...item.notes.map((note) => `- ${esc(note)}`)] : []),
    '',
    '## What to do',
    '- Read what changed on the community\'s mirrors and decide.',
    '- To keep the community listed, update `digests` to the new files (a normal submission) and set `status` back to `approved` in the same pull request; or add a reviewed hash to `data/virustotal-benign.json` if a flag is a known false positive.',
    '- To remove it, set `status` to `suspended` or delete the file.',
    '',
    `Run: ${runUrl}`,
    '',
    '🤖 Generated with [Claude Code](https://claude.com/claude-code)'
  ].join('\n');
}

async function main() {
  const [decisionsFile] = process.argv.slice(2);
  const repository = process.env.GITHUB_REPOSITORY;
  const base = process.env.DEFAULT_BRANCH || 'main';
  const runUrl = process.env.RUN_URL || '';
  const github = githubClient({ token: process.env.GITHUB_TOKEN, repository });
  const decisions = JSON.parse(fs.readFileSync(decisionsFile, 'utf8')).entries.filter((item) => item.action === 'demote' && ID.test(item.id));
  let opened = 0;

  for (const item of decisions) {
    const file = path.join('servers', `${item.id}.json`);
    if (!fs.existsSync(file) || JSON.parse(fs.readFileSync(file, 'utf8')).status !== 'approved') continue;
    const branch = `rescan/${item.id}`;
    try {
      await github.request('GET', `/repos/${repository}/git/ref/heads/${branch}`);
      process.stdout.write(`${item.id}: ${branch} already exists, skipping\n`);
      continue;
    } catch (error) {
      if (!(error instanceof GitHubError) || error.status !== 404) throw error;
    }

    const title = `fix: move ${item.id} to needs-approval after a re-scan`;
    try {
      const head = await github.request('GET', `/repos/${repository}/git/ref/heads/${base}`);
      await github.request('POST', `/repos/${repository}/git/refs`, { ref: `refs/heads/${branch}`, sha: head.object.sha });
      const current = await github.request('GET', `/repos/${repository}/contents/${file}?ref=${encodeURIComponent(base)}`);
      const text = Buffer.from(current.content, 'base64').toString('utf8');
      await github.request('PUT', `/repos/${repository}/contents/${file}`, {
        message: `${title}\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`,
        content: Buffer.from(demoteText(text)).toString('base64'),
        sha: current.sha,
        branch
      });
      await github.request('POST', `/repos/${repository}/pulls`, { title, head: branch, base, body: body(item, runUrl) });
      opened += 1;
    } catch (error) {
      if (!(error instanceof GitHubError) || error.status !== 403) throw error;
      await github.request('POST', `/repos/${repository}/issues`, {
        title: `Re-scan: ${item.id} needs approval`,
        body: `${body(item, runUrl)}\n\nA pull request could not be opened (the repository does not allow Actions to create pull requests), so the branch \`${branch}\` may hold the change.`
      });
    }
  }
  process.stdout.write(`${opened} pull requests opened\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 2;
});
