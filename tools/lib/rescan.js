'use strict';

const limits = require('./limits');
const { FetchError, mapLimit } = require('./net');
const { encodePath } = require('./validate-entry');
const { manifestKind } = require('./manifest');

const maxFor = (key) => (manifestKind(key) ? limits.MAX_MANIFEST_BYTES : limits.MAX_ART_BYTES);

/**
 * Compares the files an approved entry pins with what its mirrors serve now. A different hash is a change;
 * a mirror that cannot be reached is not (an outage must not demote a community).
 * Returns { changed: [{ path, mirror, got }], unreachable: [mirrorIndex] }.
 */
async function checkPinned(entry, fetcher, deadline, concurrency = 6) {
  const changed = [];
  const answered = new Array(entry.mirrors.length).fill(false);
  const jobs = [];
  for (const key of Object.keys(entry.digests)) entry.mirrors.forEach((mirror, index) => jobs.push({ key, mirror, index }));
  await mapLimit(jobs, concurrency, async ({ key, mirror, index }) => {
    try {
      const downloaded = await fetcher.download(mirror + encodePath(key), { maxBytes: maxFor(key), timeoutMs: 30000, deadline, keep: false });
      answered[index] = true;
      if (downloaded.sha256 !== entry.digests[key]) changed.push({ path: key, mirror: index + 1, got: downloaded.sha256 });
    } catch (error) {
      if (error instanceof FetchError && (error.code === 'HTTP_STATUS' && error.status === 404)) {
        answered[index] = true;
        changed.push({ path: key, mirror: index + 1, got: null });
      } else if (error instanceof FetchError && error.code === 'TOO_LARGE') {
        answered[index] = true;
        changed.push({ path: key, mirror: index + 1, got: 'larger than the limit' });
      }
    }
  });
  changed.sort((a, b) => (a.path + a.mirror < b.path + b.mirror ? -1 : 1));
  return { changed, unreachable: answered.map((ok, index) => (ok ? null : index + 1)).filter(Boolean) };
}

/** Turns a pinned-file comparison and the scan results of the entry's code files into one decision. */
function decide(pinned, scanned) {
  const reasons = [];
  for (const item of pinned.changed.slice(0, 20)) {
    reasons.push(item.got === null ? `${item.path} is no longer served by mirror ${item.mirror}` : `${item.path} on mirror ${item.mirror} no longer matches its pinned digest`);
  }
  if (pinned.changed.length > 20) reasons.push(`${pinned.changed.length - 20} more pinned files changed`);
  const flagged = scanned.filter((file) => file.status === 'flagged');
  for (const file of flagged.slice(0, 20)) reasons.push(`${file.paths[0]} is now flagged by ${file.malicious + file.suspicious} of ${file.total} engines`);
  if (flagged.length > 20) reasons.push(`${flagged.length - 20} more files are flagged`);
  const notes = [];
  if (pinned.unreachable.length) notes.push(`mirror ${pinned.unreachable.join(', ')} could not be reached`);
  const unfinished = scanned.filter((file) => ['queued', 'analysis-pending', 'error'].includes(file.status)).length;
  if (unfinished) notes.push(`${unfinished} files could not be scanned this time`);
  return { action: reasons.length ? 'demote' : 'ok', reasons, notes };
}

module.exports = { checkPinned, decide };
