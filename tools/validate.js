#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const limits = require('./lib/limits');
const { loadEntries, parseEntryText, validateEntry } = require('./lib/entry');
const { createFetcher } = require('./lib/net');
const { validateSubmission, normaliseName } = require('./lib/validate-entry');
const { renderComment } = require('./lib/report');
const { estimateEnvelopeBytes, fitsInEnvelope } = require('./lib/index-size');

const USAGE = `Usage: node tools/validate.js [options] [entry.json ...]

Checks registry entries the way CI does, including downloading every pinned file.
With no entry files, every file in the servers directory is checked.

  --servers <dir>          directory with the registry's entries (default: servers)
  --entries-dir <dir>      check every .json file in this directory instead of naming files
  --base <dir>             entries of the base branch, to report what a pull request changes
  --meta <file>            JSON with { commit, problems, removed } written by the pull request step
  --out <file>             write the result as JSON
  --markdown <file>        write the pull request comment
  --deadline-minutes <n>   time budget for all downloads (default: 30)
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      servers: { type: 'string', default: 'servers' },
      'entries-dir': { type: 'string' },
      base: { type: 'string' },
      meta: { type: 'string' },
      out: { type: 'string' },
      markdown: { type: 'string' },
      'deadline-minutes': { type: 'string', default: '30' },
      help: { type: 'boolean', default: false }
    }
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const serversDir = path.resolve(values.servers);
  const meta = values.meta ? JSON.parse(fs.readFileSync(values.meta, 'utf8')) : {};
  const baseEntries = values.base ? loadEntries(path.resolve(values.base)) : [];
  const baseById = new Map(baseEntries.filter((item) => item.entry && typeof item.entry.id === 'string').map((item) => [item.entry.id, item.entry]));

  let files;
  if (values['entries-dir']) files = loadEntries(path.resolve(values['entries-dir'])).map((item) => item.file);
  else if (positionals.length) files = positionals.map((file) => path.resolve(file));
  else files = loadEntries(serversDir).map((item) => item.file);
  const checking = new Set(files.map((file) => path.basename(file, '.json')));
  const otherNames = new Map();
  for (const item of loadEntries(serversDir)) {
    if (!item.entry || typeof item.entry.name !== 'string' || typeof item.entry.id !== 'string' || checking.has(item.entry.id)) continue;
    otherNames.set(normaliseName(item.entry.name), item.entry.id);
  }

  const fetcher = createFetcher();
  const deadline = Date.now() + Number(values['deadline-minutes']) * 60000;
  const entries = [];
  const checkedEntries = [];
  for (const file of files) {
    const name = path.basename(file);
    const parsed = parseEntryText(fs.readFileSync(file, 'utf8'));
    const staticChecks = parsed.entry === null ? { errors: [], warnings: [] } : validateEntry(parsed.entry, name);
    staticChecks.errors.unshift(...parsed.errors);
    if (parsed.entry !== null && staticChecks.errors.length === 0) checkedEntries.push(parsed.entry);
    const id = parsed.entry && typeof parsed.entry.id === 'string' ? parsed.entry.id : null;
    process.stderr.write(`Checking ${name}\n`);
    entries.push(await validateSubmission({
      file: `servers/${name}`,
      entry: parsed.entry,
      staticChecks,
      previous: id ? baseById.get(id) ?? null : null,
      otherNames,
      fetcher,
      deadline,
      log: (message) => process.stderr.write(`  ${message}\n`)
    }));
  }

  const problems = [...(meta.problems || [])];
  const overlay = new Map((values.base ? baseEntries : loadEntries(serversDir)).filter((item) => item.entry && item.errors.length === 0).map((item) => [item.entry.id, item.entry]));
  for (const entry of checkedEntries) overlay.set(entry.id, entry);
  if (!fitsInEnvelope([...overlay.values()])) {
    problems.push({ level: 'error', message: `The signed index would be about ${estimateEnvelopeBytes([...overlay.values()])} bytes with this change; the launcher reads at most ${limits.MAX_INDEX_ENVELOPE_BYTES}.` });
  }
  const known = new Set(baseEntries.map((item) => item.entry && item.entry.id).filter(Boolean));
  const added = entries.filter((entry) => entry.id && !known.has(entry.id)).length;
  if (values.base && known.size + added > limits.MAX_ENTRIES) {
    problems.push({ level: 'error', message: `The registry would list ${known.size + added} servers; the index holds at most ${limits.MAX_ENTRIES}.` });
  }
  const seen = new Set();
  for (const entry of entries) {
    if (entry.id && seen.has(entry.id)) problems.push({ level: 'error', message: `The id ${entry.id} appears twice in this change.` });
    if (entry.id) seen.add(entry.id);
  }

  const run = { commit: meta.commit || '', problems, removed: meta.removed || [], entries };
  if (values.out) fs.writeFileSync(values.out, JSON.stringify(run, null, 2));
  if (values.markdown) fs.writeFileSync(values.markdown, renderComment(run));

  const failed = entries.filter((entry) => entry.verdict === 'fail' || entry.verdict === 'incomplete').length + problems.filter((item) => item.level === 'error').length;
  for (const entry of entries) {
    process.stdout.write(`${entry.file}: ${entry.verdict} (${entry.errors.length} errors, ${entry.warnings.length} warnings)\n`);
    for (const item of entry.errors) process.stdout.write(`  error: ${item.message}\n`);
    for (const item of entry.warnings) process.stdout.write(`  warning: ${item.message}\n`);
  }
  for (const problem of problems) process.stdout.write(`${problem.level}: ${problem.message}\n`);
  return failed > 0 ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 2;
  }
);
