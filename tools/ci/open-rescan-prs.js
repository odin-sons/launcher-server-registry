#!/usr/bin/env node
'use strict';

// Turns the decisions of a re-scan into pull requests that set an entry to needs-approval. The decisions file is
// data: only ids that exist as approved entries on the base branch are acted on, and every text is escaped.

const fs = require('node:fs');
const path = require('node:path');
const { client: githubClient, GitHubError } = require('../lib/github');
const { esc, code } = require('../lib/markdown');

const ID = /^[a-z0-9][a-z0-9-]{1,31}$/;

/** Sets the top-level status of the entry and nothing else, whatever else the file contains. */
function demoteText(text) {
  const entry = JSON.parse(text);
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry) || entry.status !== 'approved') throw new Error('The entry is not an approved entry.');
  entry.status = 'needs-approval';
  return `${JSON.stringify(entry, null, 2)}\n`;
}

const issueTitle = (id) => `Re-scan: ${id} needs approval`;

function body(item, runUrl) {
  return [
    'Refs odin-sons/Launcher#21',
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

async function exists(github, route) {
  try {
    await github.request('GET', route);
    return true;
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return false;
    throw error;
  }
}

/** True when a maintainer already has this entry on their list: an open pull request from its branch or an open issue. */
async function isHandled(github, repository, id, branch) {
  const owner = repository.split('/')[0];
  const pulls = await github.request('GET', `/repos/${repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`);
  if (pulls.length > 0) return true;
  const issues = await github.paginate(`/repos/${repository}/issues?state=open`, { pages: 3 });
  return issues.some((issue) => !issue.pull_request && issue.title === issueTitle(id));
}

async function demote(github, { repository, base, item, runUrl }) {
  const file = path.join('servers', `${item.id}.json`);
  if (!fs.existsSync(file) || JSON.parse(fs.readFileSync(file, 'utf8')).status !== 'approved') return 'not approved here';
  const branch = `rescan/${item.id}`;
  if (await isHandled(github, repository, item.id, branch)) return 'already being handled';

  if (await exists(github, `/repos/${repository}/git/ref/heads/${branch}`)) {
    await github.request('DELETE', `/repos/${repository}/git/refs/heads/${branch}`);
  }

  const title = `fix: move ${item.id} to needs-approval after a re-scan`;
  const head = await github.request('GET', `/repos/${repository}/git/ref/heads/${base}`);
  await github.request('POST', `/repos/${repository}/git/refs`, { ref: `refs/heads/${branch}`, sha: head.object.sha });
  try {
    const current = await github.request('GET', `/repos/${repository}/contents/${file}?ref=${encodeURIComponent(base)}`);
    const text = Buffer.from(current.content, 'base64').toString('utf8');
    await github.request('PUT', `/repos/${repository}/contents/${file}`, {
      message: `${title}\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`,
      content: Buffer.from(demoteText(text)).toString('base64'),
      sha: current.sha,
      branch
    });
    await github.request('POST', `/repos/${repository}/pulls`, { title, head: branch, base, body: body(item, runUrl) });
    return 'opened';
  } catch (error) {
    if (error instanceof GitHubError && error.status === 403) {
      await github.request('POST', `/repos/${repository}/issues`, {
        title: issueTitle(item.id),
        body: `${body(item, runUrl)}\n\nA pull request could not be opened (the repository does not allow Actions to create pull requests), so the branch \`${branch}\` holds the change.`
      });
      return 'issue opened';
    }
    await github.request('DELETE', `/repos/${repository}/git/refs/heads/${branch}`).catch(() => {});
    throw error;
  }
}

async function main() {
  const [decisionsFile] = process.argv.slice(2);
  const repository = process.env.GITHUB_REPOSITORY;
  const base = process.env.DEFAULT_BRANCH || 'main';
  const runUrl = process.env.RUN_URL || '';
  const github = githubClient({ token: process.env.GITHUB_TOKEN, repository });
  const decisions = JSON.parse(fs.readFileSync(decisionsFile, 'utf8')).entries.filter((item) => item.action === 'demote' && ID.test(item.id));
  const failures = [];

  for (const item of decisions) {
    try {
      process.stdout.write(`${item.id}: ${await demote(github, { repository, base, item, runUrl })}\n`);
    } catch (error) {
      failures.push(item.id);
      process.stderr.write(`${item.id}: ${error.message}\n`);
    }
  }
  if (failures.length) throw new Error(`Could not handle: ${failures.join(', ')}`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 2;
  });
}

module.exports = { demoteText };
