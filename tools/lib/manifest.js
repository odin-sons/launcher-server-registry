'use strict';

const limits = require('./limits');

const MARKER = 'MANIFEST';
const CURRENT_VERSION = 3;
const ALGORITHM = 'sha256';
const MAX_REPORTED_PROBLEMS = 20;

const MAX_LINE_CHARS = 4096;
const DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function trimSlashes(text) {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === '/') start += 1;
  while (end > start && text[end - 1] === '/') end -= 1;
  return text.slice(start, end);
}

function normalisePath(raw) {
  return trimSlashes(raw).replaceAll('\\', '/');
}

/** What Windows makes of a name: no trailing dots or spaces, no alternate data stream, no case. */
function foldPath(normalised) {
  return normalised
    .split('/')
    .map((part) => part.replace(/:.*$/, '').replace(/[. ]+$/, ''))
    .join('/')
    .toLowerCase();
}

function pathProblem(normalised) {
  if (/[\u0000-\u001f\u007f]/.test(normalised)) return 'contains control characters';
  if (/^[A-Za-z]:/.test(normalised)) return 'starts with a drive letter';
  const parts = normalised.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return 'is not a plain relative path';
  if (/[<>:"|?*]/.test(normalised)) return 'contains a character Windows does not allow in file names';
  if (parts.some((part) => /[. ]$/.test(part))) return 'has a name that ends in a dot or a space';
  if (parts.some((part) => DEVICE_NAMES.test(part.split('.')[0]))) return 'uses a reserved Windows device name';
  return null;
}

/**
 * Parses the launcher's manifest format (Launcher.Core/Manifest.cs):
 *   MANIFEST 3 sha256
 *   <hash> <size> <path to the end of the line>
 * Returns { version, algorithm, game, entries: [{ path, hash, size, line }], problems: [{ line, message }] }.
 * The reader accepts everything the launcher's reader accepts; the extra checks (hash shape, safe paths,
 * duplicates, entry count) are reported as problems.
 */
function parseManifest(text) {
  const lines = text.split(/\r\n|\n|\r/);
  const problems = [];
  const problem = (line, message) => {
    if (problems.length < MAX_REPORTED_PROBLEMS) problems.push({ line, message });
    else if (problems.length === MAX_REPORTED_PROBLEMS) problems.push({ line, message: 'More problems follow.' });
  };

  let index = lines.findIndex((line) => line.length > 0 && line[0] !== '#');
  if (index < 0) return { version: null, algorithm: null, game: null, entries: [], problems: [{ line: 1, message: 'The manifest is empty.' }] };

  const header = lines[index];
  const parts = header.split(' ').filter((part) => part.length > 0);
  if (parts.length < 2 || parts[0] !== MARKER) {
    return { version: null, algorithm: null, game: null, entries: [], problems: [{ line: index + 1, message: `Not a manifest: the first line is ${JSON.stringify(header.slice(0, 80))}.` }] };
  }
  const version = /^[+-]?\d+$/.test(parts[1]) ? Number(parts[1]) : null;
  if (version === null) return { version: null, algorithm: null, game: null, entries: [], problems: [{ line: index + 1, message: `Malformed manifest version in ${JSON.stringify(header.slice(0, 80))}.` }] };
  if (version > CURRENT_VERSION) problem(index + 1, `Manifest version ${version} is newer than the supported ${CURRENT_VERSION}.`);
  const algorithm = parts.length >= 3 ? parts[2] : ALGORITHM;
  if (algorithm.toLowerCase() !== ALGORITHM) problem(index + 1, `The manifest uses ${JSON.stringify(algorithm.slice(0, 20))} hashes; only ${ALGORITHM} is supported.`);

  let game = null;
  const entries = [];
  const seen = new Map();
  let directivesOpen = true;

  for (index += 1; index < lines.length; index++) {
    const line = lines[index];
    const number = index + 1;
    if (line.length === 0) continue;
    if (line[0] === '#') {
      if (directivesOpen && game === null) {
        const body = line.replace(/^#+/, '').trim();
        if (body.toLowerCase().startsWith('game:')) game = body.slice('game:'.length).trim();
      }
      continue;
    }
    directivesOpen = false;

    if (line.length > MAX_LINE_CHARS) {
      problem(number, `The line is longer than ${MAX_LINE_CHARS} characters.`);
      continue;
    }
    const firstGap = line.indexOf(' ');
    const secondGap = firstGap > 0 ? line.indexOf(' ', firstGap + 1) : -1;
    if (firstGap <= 0 || secondGap <= firstGap + 1) {
      problem(number, 'Malformed entry: expected "<hash> <size> <path>".');
      continue;
    }
    const hash = line.slice(0, firstGap);
    const sizeText = line.slice(firstGap + 1, secondGap);
    const normalised = normalisePath(line.slice(secondGap + 1));

    if (!/^[+-]?\d+$/.test(sizeText)) {
      problem(number, `Malformed size ${JSON.stringify(sizeText.slice(0, 30))}.`);
      continue;
    }
    if (normalised.length === 0) {
      problem(number, 'Empty path.');
      continue;
    }
    if (!/^[0-9a-fA-F]{64}$/.test(hash)) problem(number, `The hash of ${JSON.stringify(normalised.slice(0, 80))} is not a SHA-256.`);
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size < 0) problem(number, `The size of ${JSON.stringify(normalised.slice(0, 80))} is not a non-negative integer.`);
    const bad = pathProblem(normalised);
    if (bad) problem(number, `The path ${JSON.stringify(normalised.slice(0, 80))} ${bad}.`);
    const folded = foldPath(normalised);
    if (seen.has(folded)) problem(number, `The path ${JSON.stringify(normalised.slice(0, 80))} repeats line ${seen.get(folded)} (paths that differ only in case, trailing dots or spaces collide on Windows and macOS).`);
    else seen.set(folded, number);

    entries.push({ path: normalised, hash: hash.toLowerCase(), size, line: number });
    if (entries.length > limits.MAX_MANIFEST_ENTRIES) {
      problem(number, `The manifest lists more than ${limits.MAX_MANIFEST_ENTRIES} files.`);
      break;
    }
  }

  return { version, algorithm, game, entries, problems };
}

/** game*.info describe the vanilla game; every other .info file lists mods. */
function manifestKind(digestPath) {
  const name = digestPath.split('/').pop();
  if (!name.endsWith('.info')) return null;
  return /^game(_macos|_linux)?\.info$/.test(name) ? 'game' : 'mods';
}

module.exports = { parseManifest, manifestKind, normalisePath, foldPath, MAX_LINE_CHARS };
