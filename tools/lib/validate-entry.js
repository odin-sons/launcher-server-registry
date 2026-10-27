'use strict';

const path = require('node:path');
const limits = require('./limits');
const { FetchError, mapLimit } = require('./net');
const { parseManifest, manifestKind } = require('./manifest');
const { checkTheme, checkAbout, checkTerms, checkImage, parseJsonFile } = require('./display');

const SCANNABLE = new Set([
  '.dll', '.exe', '.so', '.dylib', '.jar', '.msi', '.bat', '.cmd', '.ps1', '.sh', '.vbs', '.js', '.py', '.pyd',
  '.scr', '.com', '.x86_64', '.pkg', '.dmg', '.zip', '.7z', '.rar', '.gz', '.tgz', '.tar', '.bz2', '.xz'
]);
const IMPERSONATION = /official|odinsons|odin sons|launcher|registry|verified/i;
const UNREACHABLE = new Set(['NETWORK', 'TIMEOUT', 'BLOCKED_ADDRESS', 'BAD_URL', 'TOO_MANY_REDIRECTS']);

const isScannable = (file) => SCANNABLE.has(path.posix.extname(file).toLowerCase());
const encodePath = (file) => file.split('/').map(encodeURIComponent).join('/');
const dirOf = (file) => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '');
const normaliseName = (name) => name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const short = (hash) => `${hash.slice(0, 12)}...`;

function describeFailure(error, limit) {
  if (error instanceof FetchError) {
    if (error.code === 'TOO_LARGE') return { state: 'too-large', detail: `larger than the limit of ${limit} bytes` };
    if (error.code === 'HTTP_STATUS') return { state: 'http', detail: error.message };
    return { state: error.code.toLowerCase(), detail: error.message };
  }
  return { state: 'error', detail: String(error.message).slice(0, 120) };
}

function roleFor(key, entry, imageRoles) {
  if (key === entry.theme) return { role: 'theme', max: limits.MAX_THEME_BYTES };
  if (key === entry.about) return { role: 'about', max: limits.MAX_ABOUT_BYTES };
  const language = entry.terms && Object.keys(entry.terms).find((code) => entry.terms[code] === key);
  if (language) return { role: 'terms', language, max: limits.MAX_TERMS_BYTES };
  const image = imageRoles.get(key);
  if (image === 'logo') return { role: 'logo', max: limits.MAX_LOGO_BYTES };
  if (image === 'art') return { role: 'art', max: limits.MAX_ART_BYTES };
  if (manifestKind(key)) return { role: 'manifest', max: limits.MAX_MANIFEST_BYTES };
  return { role: 'listing', max: limits.MAX_LISTING_BYTES };
}

function diffEntries(previous, next) {
  if (!previous) return { isNew: true, lines: [] };
  const lines = [];
  if (previous.status !== next.status) lines.push(`status: ${previous.status} -> ${next.status}`);
  if (previous.name !== next.name) lines.push(`name: ${previous.name} -> ${next.name}`);
  const mirrorsBefore = new Set(previous.mirrors || []);
  const mirrorsAfter = new Set(next.mirrors || []);
  for (const mirror of mirrorsAfter) if (!mirrorsBefore.has(mirror)) lines.push(`mirror added: ${mirror}`);
  for (const mirror of mirrorsBefore) if (!mirrorsAfter.has(mirror)) lines.push(`mirror removed: ${mirror}`);
  const before = previous.digests || {};
  const after = next.digests || {};
  for (const key of Object.keys(after)) {
    if (!Object.hasOwn(before, key)) lines.push(`digest added: ${key}`);
    else if (before[key] !== after[key]) lines.push(`digest changed: ${key}`);
  }
  for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) lines.push(`digest removed: ${key}`);
  for (const field of ['website', 'community', 'theme', 'about']) {
    if ((previous[field] ?? null) !== (next[field] ?? null)) lines.push(`${field} changed`);
  }
  if (JSON.stringify(previous.terms ?? null) !== JSON.stringify(next.terms ?? null)) lines.push('terms changed');
  return { isNew: false, lines };
}

/**
 * Runs every check on one entry. `entry` is the parsed file, `staticChecks` the { errors, warnings } of the
 * entry module. Never throws for hostile input; everything is reported in the returned plain object.
 */
async function validateSubmission({ file, entry, staticChecks, previous = null, otherNames = new Map(), fetcher, deadline, concurrency = 6, log = () => {} }) {
  const errors = [...staticChecks.errors];
  const warnings = [...staticChecks.warnings];
  const error = (code, message, where = '/') => errors.push({ code, where, message });
  const warn = (code, message, where = '/') => warnings.push({ code, where, message });

  const result = {
    file,
    id: typeof entry?.id === 'string' ? entry.id : null,
    name: typeof entry?.name === 'string' ? entry.name : null,
    status: typeof entry?.status === 'string' ? entry.status : null,
    isNew: previous === null,
    changes: [],
    errors,
    warnings,
    mirrors: [],
    files: [],
    manifests: [],
    display: [],
    listed: { checked: 0, ok: 0, failed: 0, skipped: 0, bytes: 0, declaredBytes: 0, usedMirror: [] },
    scanTargets: [],
    networkChecked: false,
    verdict: 'fail'
  };
  if (entry === null || typeof entry !== 'object') return finish(result);

  const diff = diffEntries(previous, entry);
  result.changes = diff.lines;

  if (typeof entry.name === 'string') {
    const taken = otherNames.get(normaliseName(entry.name));
    if (taken && taken !== entry.id) error('name-taken', `The name is already used by the entry ${taken}.`, '/name');
    else if (IMPERSONATION.test(entry.name) && entry.id !== 'odinsons') warn('name-check', 'The name contains a word that could be mistaken for the launcher or the registry; a maintainer will check it.', '/name');
  }

  const blocking = errors.some((item) => ['schema', 'mirror', 'digest-path', 'json'].includes(item.code));
  if (blocking) {
    warn('network-skipped', 'Network checks were skipped because the entry is not valid yet.');
    return finish(result);
  }

  result.networkChecked = true;
  const mirrors = entry.mirrors;
  const digests = entry.digests;
  const mirrorStats = mirrors.map((url) => ({ url, ok: 0, failed: 0, onlyUnreachable: true, problems: [] }));
  const contents = new Map();
  const imageRoles = new Map();

  async function fetchPinned(key, force) {
    const { role, language, max } = force || roleFor(key, entry, imageRoles);
    const record = { path: key, role, language: language ?? null, pinned: digests[key], size: null, verified: false, mirrors: [] };
    for (let index = 0; index < mirrors.length; index++) {
      const url = mirrors[index] + encodePath(key);
      try {
        const downloaded = await fetcher.download(url, { maxBytes: max, timeoutMs: 30000, deadline });
        const match = downloaded.sha256 === digests[key];
        record.mirrors.push({ state: match ? 'ok' : 'mismatch', detail: match ? '' : `expected ${short(digests[key])}, got ${short(downloaded.sha256)}` });
        record.size = downloaded.size;
        if (match) {
          record.verified = true;
          mirrorStats[index].ok += 1;
          if (!contents.has(key)) contents.set(key, downloaded.bytes);
        } else {
          mirrorStats[index].failed += 1;
          mirrorStats[index].onlyUnreachable = false;
          error('file-mismatch', `${key} on mirror ${index + 1} does not match the pinned digest (${record.mirrors[index].detail}).`, `/digests/${key}`);
        }
      } catch (failure) {
        const { state, detail } = describeFailure(failure, max);
        record.mirrors.push({ state, detail });
        mirrorStats[index].failed += 1;
        if (!(failure instanceof FetchError) || !UNREACHABLE.has(failure.code)) mirrorStats[index].onlyUnreachable = false;
        const wording = state === 'too-large' ? `exceeds the ${max} byte limit for this file (${role})` : detail;
        error(`file-${state}`, `${key} on mirror ${index + 1}: ${wording}.`, `/digests/${key}`);
      }
    }
    result.files.push(record);
    return record;
  }

  if (entry.theme && Object.hasOwn(digests, entry.theme)) {
    await fetchPinned(entry.theme);
    const bytes = contents.get(entry.theme);
    if (bytes) {
      const checked = checkTheme(bytes, digests);
      for (const image of checked.images) imageRoles.set(image.file, imageRoles.get(image.file) === 'art' ? 'art' : image.role);
    }
  }

  const rest = Object.keys(digests).filter((key) => key !== entry.theme);
  await mapLimit(rest, concurrency, (key) => fetchPinned(key));
  result.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  result.mirrors = mirrorStats.map((stat) => ({
    url: stat.url,
    ok: stat.ok,
    failed: stat.failed,
    state: stat.failed === 0 ? 'ok' : stat.ok === 0 && stat.onlyUnreachable ? 'unreachable' : 'partial'
  }));
  result.mirrors.forEach((mirror, index) => {
    if (mirror.state === 'unreachable') error('mirror-unreachable', `Mirror ${index + 1} is not reachable.`, `/mirrors/${index}`);
  });

  checkDisplayFiles({ entry, digests, contents, imageRoles, result, error, warn });
  const mods = checkManifests({ digests, contents, result, error, warn });

  await verifyListedFiles({ mods, mirrors, fetcher, deadline, concurrency, result, error, warn, log });
  collectScanTargets(mods, result);

  return finish(result);
}

function checkDisplayFiles({ entry, digests, contents, imageRoles, result, error, warn }) {
  const note = (key, role, checked) => {
    for (const message of checked.errors) error('content', `${key}: ${message}`, `/digests/${key}`);
    for (const message of checked.warnings) warn('content', `${key}: ${message}`, `/digests/${key}`);
    result.display.push({ path: key, role, ok: checked.errors.length === 0 });
  };

  if (entry.theme && contents.has(entry.theme)) note(entry.theme, 'theme', checkTheme(contents.get(entry.theme), digests));
  if (entry.about && contents.has(entry.about)) note(entry.about, 'about', checkAbout(contents.get(entry.about)));
  for (const [language, key] of Object.entries(entry.terms || {})) {
    if (contents.has(key)) note(key, `terms (${language})`, checkTerms(contents.get(key), language));
  }
  for (const [key, role] of imageRoles) {
    if (contents.has(key)) note(key, role, checkImage(contents.get(key), role));
  }
  for (const [key, bytes] of contents) {
    if (key.split('/').pop() !== 'servers.json') continue;
    const parsed = parseJsonFile(bytes);
    if (parsed.error) error('content', `${key}: ${parsed.error}`, `/digests/${key}`);
    else if (!parsed.value || typeof parsed.value !== 'object' || !Array.isArray(parsed.value.Servers)) warn('content', `${key}: expected an object with a Servers array.`, `/digests/${key}`);
    result.display.push({ path: key, role: 'servers.json', ok: !parsed.error });
  }
}

function checkManifests({ digests, contents, result, error, warn }) {
  const mods = [];
  for (const key of Object.keys(digests)) {
    const kind = manifestKind(key);
    if (!kind || !contents.has(key)) continue;
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(contents.get(key));
    } catch {
      error('manifest', `${key}: the manifest is not valid UTF-8.`, `/digests/${key}`);
      continue;
    }
    const manifest = parseManifest(text);
    for (const problem of manifest.problems) error('manifest', `${key} line ${problem.line}: ${problem.message}`, `/digests/${key}`);
    if (kind === 'game' && manifest.game !== null && !/^\d+_\d+$/.test(manifest.game)) {
      warn('manifest', `${key}: the game version ${JSON.stringify(manifest.game.slice(0, 30))} is not <depot>_<manifest>; the launcher ignores it.`, `/digests/${key}`);
    }
    const declared = manifest.entries.reduce((total, item) => total + (Number.isSafeInteger(item.size) ? item.size : 0), 0);
    result.manifests.push({ path: key, kind, entries: manifest.entries.length, declaredBytes: declared, problems: manifest.problems.length });
    if (kind === 'mods' && manifest.problems.length === 0) mods.push({ key, dir: dirOf(key), entries: manifest.entries });
  }
  return mods;
}

async function verifyListedFiles({ mods, mirrors, fetcher, deadline, concurrency, result, error, warn, log }) {
  const plan = new Map();
  for (const mod of mods) {
    for (const item of mod.entries) {
      const full = mod.dir ? `${mod.dir}/${item.path}` : item.path;
      const known = plan.get(full.toLowerCase());
      if (known && (known.hash !== item.hash || known.size !== item.size)) {
        error('manifest', `${mod.key}: ${full} is listed with a different hash or size than in ${known.from}.`, `/digests/${mod.key}`);
        continue;
      }
      if (!known) plan.set(full.toLowerCase(), { path: full, hash: item.hash, size: item.size, from: mod.key });
    }
  }
  const items = [...plan.values()];
  const declared = items.reduce((total, item) => total + item.size, 0);
  result.listed.declaredBytes = declared;
  result.listed.checked = items.length;
  if (items.length === 0) return;

  const oversize = items.filter((item) => item.size > limits.MAX_LISTED_FILE_BYTES);
  for (const item of oversize.slice(0, 10)) error('listed-too-large', `${item.path} is ${item.size} bytes; the limit for one file is ${limits.MAX_LISTED_FILE_BYTES}.`, `/digests/${item.from}`);
  if (declared > limits.MAX_LISTED_TOTAL_BYTES || oversize.length > 0) {
    if (declared > limits.MAX_LISTED_TOTAL_BYTES) error('listed-too-large', `The manifests list ${declared} bytes in total; the limit is ${limits.MAX_LISTED_TOTAL_BYTES}.`);
    result.listed.skipped = items.length;
    return;
  }

  const problems = [];
  let done = 0;
  await mapLimit(items, concurrency, async (item) => {
    if (Date.now() >= deadline) {
      result.listed.skipped += 1;
      return;
    }
    let verdict = null;
    for (let index = 0; index < mirrors.length && verdict === null; index++) {
      const url = mirrors[index] + encodePath(item.path);
      const timeoutMs = 60000 + Math.ceil(item.size / limits.MiB) * 1000;
      try {
        const downloaded = await fetcher.download(url, { maxBytes: item.size, timeoutMs, deadline, keep: false });
        if (downloaded.sha256 === item.hash && downloaded.size === item.size) verdict = { ok: true, mirror: index };
        else verdict = { ok: false, mirror: index, message: downloaded.size !== item.size ? `${item.path}: the size is ${downloaded.size}, the manifest says ${item.size}.` : `${item.path}: the hash differs from the manifest (expected ${short(item.hash)}, got ${short(downloaded.sha256)}).` };
      } catch (failure) {
        if (failure instanceof FetchError && failure.code === 'TOO_LARGE') verdict = { ok: false, mirror: index, message: `${item.path}: larger than the ${item.size} bytes the manifest says.` };
        else if (index === mirrors.length - 1) verdict = { ok: false, mirror: index, message: `${item.path}: ${describeFailure(failure, item.size).detail}.` };
      }
    }
    done += 1;
    if (done % 100 === 0) log(`${done} of ${items.length} listed files checked`);
    if (verdict.ok) {
      result.listed.ok += 1;
      result.listed.bytes += item.size;
      result.listed.usedMirror[verdict.mirror] = (result.listed.usedMirror[verdict.mirror] || 0) + 1;
    } else {
      result.listed.failed += 1;
      problems.push({ path: item.path, from: item.from, message: verdict.message });
    }
  });

  problems.sort((a, b) => (a.path < b.path ? -1 : 1));
  for (const problem of problems.slice(0, 25)) error('listed-file', problem.message, `/digests/${problem.from}`);
  if (problems.length > 25) error('listed-file', `${problems.length - 25} more listed files failed.`);
  if (result.listed.skipped > 0) {
    warn('budget', `${result.listed.skipped} of ${items.length} listed files were not verified because the time budget ran out; a maintainer has to verify them.`);
  }
}

function collectScanTargets(mods, result) {
  const byHash = new Map();
  for (const mod of mods) {
    for (const item of mod.entries) {
      if (!isScannable(item.path)) continue;
      const full = mod.dir ? `${mod.dir}/${item.path}` : item.path;
      const known = byHash.get(item.hash);
      if (known) {
        if (known.paths.length < 3) known.paths.push(full);
        known.count += 1;
      } else {
        byHash.set(item.hash, { sha256: item.hash, size: item.size, paths: [full], count: 1 });
      }
    }
  }
  result.scanTargets = [...byHash.values()].sort((a, b) => (a.sha256 < b.sha256 ? -1 : 1));
}

function finish(result) {
  const budget = result.warnings.some((item) => item.code === 'budget');
  result.verdict = result.errors.length > 0 ? 'fail' : budget ? 'incomplete' : result.warnings.length > 0 ? 'warn' : 'pass';
  return result;
}

module.exports = { validateSubmission, isScannable, diffEntries, encodePath, dirOf, normaliseName, SCANNABLE };
