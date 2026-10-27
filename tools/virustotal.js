#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { loadEntries } = require('./lib/entry');
const { createFetcher } = require('./lib/net');
const { encodePath } = require('./lib/validate-entry');
const { collectTargets } = require('./lib/scan-targets');
const { Budget, createClient, scan } = require('./lib/virustotal');
const { renderScan, renderSkipped } = require('./lib/vt-report');

const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback);

async function main() {
  const { values } = parseArgs({
    options: {
      'entries-dir': { type: 'string', default: 'servers' },
      meta: { type: 'string' },
      cache: { type: 'string', default: '.cache/virustotal.json' },
      config: { type: 'string', default: 'config/virustotal.json' },
      benign: { type: 'string', default: 'data/virustotal-benign.json' },
      out: { type: 'string' },
      markdown: { type: 'string' },
      'api-url': { type: 'string' },
      reserve: { type: 'boolean', default: true }
    }
  });
  const write = (file, text) => file && fs.writeFileSync(file, text);
  const apiKey = process.env.VIRUSTOTAL_API_KEY;
  if (!apiKey) {
    write(values.markdown, renderSkipped('The VIRUSTOTAL_API_KEY secret is not configured for this repository, so nothing was sent to VirusTotal.'));
    process.stdout.write('VirusTotal is not configured; skipping\n');
    return 0;
  }

  const config = readJson(values.config);
  const benign = new Map((readJson(values.benign, { benign: [] }).benign).map((item) => [item.sha256, item.note]));
  const cache = readJson(values.cache, { results: {}, ledger: [] });
  cache.results ||= {};
  const deadline = Date.now() + config.deadlineMinutes * 60000;
  const budget = new Budget({ perMinute: config.perMinute, perDay: config.perDay, reserve: values.reserve ? config.reservedForRescan : 0, ledger: cache.ledger || [] });
  const fetcher = createFetcher();
  const meta = values.meta ? readJson(values.meta, {}) : {};

  const entries = loadEntries(path.resolve(values['entries-dir'])).filter((item) => item.entry && item.errors.length === 0);
  const collected = [];
  const byHash = new Map();
  for (const item of entries) {
    const { targets, problems } = await collectTargets(item.entry, fetcher, deadline);
    collected.push({ id: item.entry.id, entry: item.entry, targets, problems });
    for (const target of targets) if (!byHash.has(target.sha256)) byHash.set(target.sha256, { ...target, entry: item.entry });
  }

  const client = createClient({ apiKey, baseUrl: values['api-url'] });
  const download = async (target) => {
    const owner = byHash.get(target.sha256);
    for (const mirror of owner.mirrors) {
      try {
        const downloaded = await fetcher.download(mirror + encodePath(target.paths[0]), { maxBytes: target.size, timeoutMs: 120000, deadline });
        if (downloaded.sha256 === target.sha256) return downloaded.bytes;
      } catch {
        // try the next mirror
      }
    }
    return null;
  };

  const results = await scan([...byHash.values()], {
    client, budget, cache, benign, threshold: config.threshold, deadline, maxUploadBytes: config.maxUploadBytes, download,
    log: (message) => process.stderr.write(`${message}\n`)
  });
  const byResult = new Map(results.map((result) => [result.sha256, result]));

  cache.ledger = budget.ledger;
  fs.mkdirSync(path.dirname(values.cache), { recursive: true });
  fs.writeFileSync(values.cache, JSON.stringify(cache));

  const report = collected.map((item) => ({ id: item.id, problems: item.problems, files: item.targets.map((target) => byResult.get(target.sha256)) }));
  write(values.out, JSON.stringify({ entries: report, threshold: config.threshold }, null, 2));
  write(values.markdown, renderScan(report, { threshold: config.threshold, remainingToday: budget.remainingToday, commit: meta.commit }));
  process.stdout.write(`${results.length} files scanned for ${collected.length} entries\n`);
  return 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 2; }
);
