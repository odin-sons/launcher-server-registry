'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validate } = require('./json-schema');
const limits = require('./limits');
const { containsLoneSurrogate } = require('./text');

const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'schema', 'server.schema.json'), 'utf8'));

const FIELD_ORDER = ['id', 'name', 'status', 'mirrors', 'website', 'community', 'digests', 'theme', 'about', 'terms'];

function isRelativePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.split('/').some((part) => part === '' || part === '.' || part === '..')
  );
}

// Stricter than the launcher: characters that change the meaning of a URL are never part of a pinned path.
function isSafeUrlPath(value) {
  return isRelativePath(value) && !/[?#%\u0000-\u001f\u007f-\u009f]/.test(value);
}

function describe(errors) {
  return errors.map((error) => ({ code: 'schema', where: error.path, message: `${error.path} ${error.message}` }));
}

/**
 * Validates one parsed entry file. Returns { errors, warnings } of { code, where, message }.
 * `fileName` is the base name of the file the entry was read from.
 */
function validateEntry(entry, fileName) {
  const errors = [];
  const warnings = [];
  const error = (code, message, where = '/') => errors.push({ code, where, message });
  const warn = (code, message, where = '/') => warnings.push({ code, where, message });

  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    error('schema', 'The entry must be a JSON object.');
    return { errors, warnings };
  }

  errors.push(...describe(validate(schema, entry)));
  if (containsLoneSurrogate(entry)) error('schema', 'The entry contains an unpaired UTF-16 surrogate (half of an emoji, for example); the launcher cannot read it.');

  if (typeof entry.id === 'string' && fileName !== undefined && `${entry.id}.json` !== fileName) {
    error('file-name', `The file name must be ${entry.id}.json, but it is ${fileName}.`, '/id');
  }

  if (Array.isArray(entry.mirrors)) {
    const seen = new Set();
    entry.mirrors.forEach((mirror, index) => {
      if (typeof mirror !== 'string') return;
      let url;
      try {
        url = new URL(mirror);
      } catch {
        error('mirror', `Mirror ${index + 1} is not a valid URL.`, `/mirrors/${index}`);
        return;
      }
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !mirror.endsWith('/')) {
        error('mirror', `Mirror ${index + 1} must be an https base URL ending in / without credentials, query or fragment.`, `/mirrors/${index}`);
      }
      if (seen.has(url.href)) warn('mirror', `Mirror ${index + 1} is listed twice.`, `/mirrors/${index}`);
      seen.add(url.href);
    });
  }

  const digests = entry.digests && typeof entry.digests === 'object' && !Array.isArray(entry.digests) ? entry.digests : {};
  for (const key of Object.keys(digests)) {
    if (isRelativePath(key) && !isSafeUrlPath(key)) {
      error('digest-path', `The digest path ${JSON.stringify(key)} contains characters that are not allowed in a pinned path (? # % or control characters).`, `/digests`);
    }
  }
  const pinned = (value, where, what) => {
    if (typeof value === 'string' && isRelativePath(value) && !Object.hasOwn(digests, value)) {
      error('digest-missing', `${what} ${JSON.stringify(value)} is not listed in digests.`, where);
    }
  };
  pinned(entry.theme, '/theme', 'The theme file');
  pinned(entry.about, '/about', 'The About file');
  if (entry.terms && typeof entry.terms === 'object' && !Array.isArray(entry.terms)) {
    for (const [language, file] of Object.entries(entry.terms)) pinned(file, `/terms/${language}`, `The ${language} terms file`);
  }

  return { errors, warnings };
}

/** The documented fields in a fixed order, so the same entry always serialises the same way. */
function toIndexRecord(entry) {
  const record = {};
  for (const field of FIELD_ORDER) {
    const value = entry[field];
    if (value === undefined || value === null) continue;
    if (field === 'digests') record.digests = Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    else if (field === 'terms') record.terms = Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    else record[field] = value;
  }
  return record;
}

/** Parses an entry file's text; returns { entry, errors } and never throws. */
function parseEntryText(text) {
  if (text.charCodeAt(0) === 0xfeff) return { entry: null, errors: [{ code: 'json', where: '/', message: 'Remove the byte order mark at the start of the file.' }] };
  if (Buffer.byteLength(text) > limits.MAX_ENTRY_FILE_BYTES) {
    return { entry: null, errors: [{ code: 'size', where: '/', message: `The entry file is larger than ${limits.MAX_ENTRY_FILE_BYTES / limits.KiB} KiB.` }] };
  }
  try {
    return { entry: JSON.parse(text), errors: [] };
  } catch (cause) {
    return { entry: null, errors: [{ code: 'json', where: '/', message: `The file is not valid JSON: ${cause.message}` }] };
  }
}

/** Reads every servers/<id>.json under `dir`; returns [{ file, entry, errors, warnings }] sorted by file name. */
function loadEntries(dir) {
  const files = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const loaded = [];
  for (const dirent of files) {
    if (dirent.name === '.gitkeep') continue;
    const file = path.join(dir, dirent.name);
    if (!dirent.isFile() || !dirent.name.endsWith('.json')) {
      loaded.push({ file, name: dirent.name, entry: null, errors: [{ code: 'layout', where: '/', message: `${dirent.name} is not a servers/<id>.json file.` }], warnings: [] });
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    const parsed = parseEntryText(text);
    const checked = parsed.entry === null ? { errors: [], warnings: [] } : validateEntry(parsed.entry, dirent.name);
    loaded.push({ file, name: dirent.name, entry: parsed.entry, errors: [...parsed.errors, ...checked.errors], warnings: checked.warnings });
  }
  return loaded;
}

module.exports = { schema, FIELD_ORDER, isRelativePath, isSafeUrlPath, validateEntry, toIndexRecord, parseEntryText, loadEntries };
