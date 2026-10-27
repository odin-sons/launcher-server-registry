'use strict';

const API = 'https://www.virustotal.com/api/v3';
const DAY = 24 * 3600 * 1000;

class QuotaError extends Error {}

/** Spaces requests to the per-minute limit and counts them against the daily one. Times are in ms. */
class Budget {
  constructor({ perMinute, perDay, reserve = 0, ledger = [], now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    Object.assign(this, { perMinute, perDay, reserve, now, sleep });
    this.ledger = ledger.filter((time) => this.now() - time < DAY);
  }

  get remainingToday() {
    return Math.max(0, this.perDay - this.reserve - this.ledger.length);
  }

  /** Waits for a free slot and records the request; false when the day is used up or `deadline` would pass. */
  async take(deadline) {
    if (this.remainingToday <= 0) return false;
    for (;;) {
      const now = this.now();
      this.ledger = this.ledger.filter((time) => now - time < DAY);
      const recent = this.ledger.filter((time) => now - time < 60000).sort((a, b) => a - b);
      if (recent.length < this.perMinute) {
        this.ledger.push(now);
        return true;
      }
      const wait = recent[recent.length - this.perMinute] + 60000 - now + 50;
      if (now + wait > deadline) return false;
      await this.sleep(wait);
    }
  }
}

function createClient({ apiKey, baseUrl = API, fetchImpl = fetch }) {
  const headers = { 'x-apikey': apiKey, accept: 'application/json' };
  async function call(method, route, body) {
    const response = await fetchImpl(`${baseUrl}${route}`, { method, headers, body, signal: AbortSignal.timeout(60000) });
    if (response.status === 404) return null;
    if (response.status === 429) throw new QuotaError('VirusTotal rate limit reached');
    if (!response.ok) throw new Error(`VirusTotal answered ${response.status}`);
    return response.json();
  }
  return {
    async lookup(sha256) {
      const body = await call('GET', `/files/${sha256}`);
      return body ? summarise(body.data.attributes.last_analysis_stats, body.data.attributes.last_analysis_date) : null;
    },
    async upload(name, bytes) {
      const form = new FormData();
      form.append('file', new Blob([bytes]), name);
      const body = await call('POST', '/files', form);
      return body.data.id;
    },
    async reanalyse(sha256) {
      const body = await call('POST', `/files/${sha256}/analyse`);
      return body.data.id;
    },
    async analysis(id) {
      const body = await call('GET', `/analyses/${encodeURIComponent(id)}`);
      if (!body || body.data.attributes.status !== 'completed') return null;
      return summarise(body.data.attributes.stats, Math.floor(Date.now() / 1000));
    }
  };
}

function summarise(stats, date) {
  const s = stats || {};
  const total = ['malicious', 'suspicious', 'undetected', 'harmless'].reduce((sum, key) => sum + (s[key] || 0), 0);
  return { malicious: s.malicious || 0, suspicious: s.suspicious || 0, total, date: date || null };
}

const detections = (result) => result.malicious + result.suspicious;

/**
 * Looks every target up by hash, uploads the unknown ones (within the size cap), and collects the verdicts of
 * those uploads while the budget lasts. Whatever does not fit is reported as queued, never guessed.
 * `cache` is a plain object { results: {sha256: {...}}, ledger: [ms] } that the caller persists.
 */
async function scan(targets, { client, budget, cache, benign, threshold, deadline, maxUploadBytes, download, cacheMaxAgeMs = 7 * DAY, reanalyseAfterMs = null, log = () => {} }) {
  const out = [];
  const pending = [];
  const uploads = [];
  const fresh = (entry) => entry && Date.now() - entry.at < cacheMaxAgeMs;

  for (const target of targets) {
    const base = { sha256: target.sha256, size: target.size, paths: target.paths };
    if (benign.has(target.sha256)) {
      out.push({ ...base, status: 'benign', note: benign.get(target.sha256) });
      continue;
    }
    const cached = cache.results[target.sha256];
    if (fresh(cached)) {
      out.push({ ...base, ...cached.result, status: classify(cached.result, threshold), cached: true });
      continue;
    }
    let found;
    try {
      if (!(await budget.take(deadline))) {
        out.push({ ...base, status: 'queued' });
        continue;
      }
      found = await client.lookup(target.sha256);
    } catch (error) {
      out.push({ ...base, status: error instanceof QuotaError ? 'queued' : 'error', note: error.message });
      continue;
    }
    if (found && reanalyseAfterMs !== null && found.date && Date.now() - found.date * 1000 > reanalyseAfterMs) {
      try {
        if (await budget.take(deadline)) {
          pending.push({ base, id: await client.reanalyse(target.sha256), fallback: found });
          continue;
        }
      } catch (error) {
        if (!(error instanceof QuotaError)) throw error;
      }
    }
    if (found) {
      cache.results[target.sha256] = { at: Date.now(), result: found };
      out.push({ ...base, ...found, status: classify(found, threshold) });
    } else if (target.size > maxUploadBytes) {
      out.push({ ...base, status: 'too-large' });
    } else {
      uploads.push({ target, base });
    }
  }

  for (const { target, base } of uploads) {
    try {
      if (budget.remainingToday <= 0 || !(await budget.take(deadline))) {
        out.push({ ...base, status: 'queued' });
        continue;
      }
      const bytes = await download(target);
      if (!bytes) {
        out.push({ ...base, status: 'error', note: 'could not download a copy that matches the manifest' });
        continue;
      }
      pending.push({ base, id: await client.upload(target.paths[0].split('/').pop(), bytes) });
    } catch (error) {
      out.push({ ...base, status: error instanceof QuotaError ? 'queued' : 'error', note: error.message });
    }
  }

  let wait = 15000;
  while (pending.length) {
    const entry = pending.shift();
    if (!(await budget.take(deadline))) {
      out.push(pendingResult(entry, threshold));
      continue;
    }
    let result = null;
    try {
      result = await client.analysis(entry.id);
    } catch (error) {
      out.push(error instanceof QuotaError ? pendingResult(entry, threshold) : { ...entry.base, status: 'error', note: error.message });
      continue;
    }
    if (result) {
      cache.results[entry.base.sha256] = { at: Date.now(), result };
      out.push({ ...entry.base, ...result, status: classify(result, threshold), uploaded: true });
    } else if (budget.now() + wait < deadline) {
      pending.push(entry);
      await budget.sleep(wait);
      wait = Math.min(wait * 2, 120000);
    } else {
      out.push(pendingResult(entry, threshold));
    }
  }
  log(`${out.length} files processed`);
  return out.sort((a, b) => (a.sha256 < b.sha256 ? -1 : 1));
}

function pendingResult(entry, threshold) {
  if (!entry.fallback) return { ...entry.base, status: 'analysis-pending' };
  return { ...entry.base, ...entry.fallback, status: classify(entry.fallback, threshold), note: 'newer analysis pending' };
}

function classify(result, threshold) {
  const count = detections(result);
  if (count >= threshold) return 'flagged';
  return count > 0 ? 'detections' : 'clean';
}

module.exports = { Budget, QuotaError, createClient, scan, classify, detections, summarise, DAY };
