#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { loadEntries } = require('./lib/entry');
const { createFetcher } = require('./lib/net');
const { encodePath } = require('./lib/validate-entry');
const { collectTargets } = require('./lib/scan-targets');
const { Budget, createClient, scan, DAY } = require('./lib/virustotal');
const { checkPinned, decide } = require('./lib/rescan');

const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback);

async function main() {
  const { values } = parseArgs({
    options: {
      servers: { type: 'string', default: 'servers' },
      cache: { type: 'string', default: '.cache/virustotal.json' },
      config: { type: 'string', default: 'config/virustotal.json' },
      benign: { type: 'string', default: 'data/virustotal-benign.json' },
      out: { type: 'string', default: '.tmp/rescan.json' },
      'api-url': { type: 'string' }
    }
  });
  const config = readJson(values.config);
  const apiKey = process.env.VIRUSTOTAL_API_KEY;
  const benign = new Map(readJson(values.benign, { benign: [] }).benign.map((item) => [item.sha256, item.note]));
  const cache = readJson(values.cache, { results: {}, ledger: [] });
  cache.results ||= {};
  const deadline = Date.now() + config.deadlineMinutes * 60000;
  const fetcher = createFetcher();
  const budget = new Budget({ perMinute: config.perMinute, perDay: config.perDay, ledger: cache.ledger || [] });
  const client = apiKey ? createClient({ apiKey, baseUrl: values['api-url'] }) : null;

  const approved = loadEntries(path.resolve(values.servers)).filter((item) => item.entry && item.errors.length === 0 && item.entry.status === 'approved');
  const report = [];
  for (const item of approved) {
    const { entry } = item;
    process.stderr.write(`Re-scanning ${entry.id}\n`);
    const pinned = await checkPinned(entry, fetcher, deadline);
    let scanned = [];
    if (client) {
      const { targets } = await collectTargets(entry, fetcher, deadline);
      const download = async (target) => {
        for (const mirror of entry.mirrors) {
          try {
            const downloaded = await fetcher.download(mirror + encodePath(target.paths[0]), { maxBytes: target.size, timeoutMs: 120000, deadline });
            if (downloaded.sha256 === target.sha256) return downloaded.bytes;
          } catch {
            // try the next mirror
          }
        }
        return null;
      };
      scanned = await scan(targets, { client, budget, cache, benign, threshold: config.threshold, deadline, maxUploadBytes: config.maxUploadBytes, download, cacheMaxAgeMs: DAY, reanalyseAfterMs: 7 * DAY });
    }
    report.push({ id: entry.id, name: entry.name, ...decide(pinned, scanned), scanned: client !== null });
  }

  cache.ledger = budget.ledger;
  fs.mkdirSync(path.dirname(values.cache), { recursive: true });
  fs.writeFileSync(values.cache, JSON.stringify(cache));
  fs.mkdirSync(path.dirname(values.out), { recursive: true });
  fs.writeFileSync(values.out, JSON.stringify({ entries: report, virustotal: client !== null }, null, 2));
  for (const item of report) process.stdout.write(`${item.id}: ${item.action}${item.reasons.length ? ` (${item.reasons.length} reasons)` : ''}${item.notes.length ? `; ${item.notes.join('; ')}` : ''}\n`);
  if (!client) process.stdout.write('VirusTotal is not configured: only the pinned files were compared\n');
  return 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 2; }
);
