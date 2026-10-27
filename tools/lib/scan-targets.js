'use strict';

const limits = require('./limits');
const { parseManifest, manifestKind } = require('./manifest');
const { isScannable, encodePath, dirOf } = require('./validate-entry');

/**
 * The code-bearing files an entry's mod manifests list. Only the manifests are downloaded, and only a copy that
 * matches its pinned digest is believed; the files themselves are fetched later, and only when VirusTotal does not
 * know them. Returns { targets: [{ sha256, size, paths, mirrors }], problems: [string] }.
 */
async function collectTargets(entry, fetcher, deadline) {
  const targets = new Map();
  const problems = [];
  for (const [key, pinned] of Object.entries(entry.digests)) {
    if (manifestKind(key) !== 'mods') continue;
    let bytes = null;
    for (const mirror of entry.mirrors) {
      try {
        const downloaded = await fetcher.download(mirror + encodePath(key), { maxBytes: limits.MAX_MANIFEST_BYTES, timeoutMs: 60000, deadline });
        if (downloaded.sha256 === pinned) {
          bytes = downloaded.bytes;
          break;
        }
      } catch {
        // try the next mirror
      }
    }
    if (!bytes) {
      problems.push(`${key} could not be downloaded with its pinned digest`);
      continue;
    }
    const manifest = parseManifest(bytes.toString('utf8'));
    if (manifest.problems.length) {
      problems.push(`${key} does not parse`);
      continue;
    }
    for (const item of manifest.entries) {
      if (!isScannable(item.path)) continue;
      const full = dirOf(key) ? `${dirOf(key)}/${item.path}` : item.path;
      const known = targets.get(item.hash);
      if (known) {
        if (known.paths.length < 3) known.paths.push(full);
      } else {
        targets.set(item.hash, { sha256: item.hash, size: item.size, paths: [full], mirrors: entry.mirrors });
      }
    }
  }
  return { targets: [...targets.values()], problems };
}

module.exports = { collectTargets };
