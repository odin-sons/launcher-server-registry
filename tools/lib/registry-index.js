'use strict';

const crypto = require('node:crypto');
const limits = require('./limits');
const { toIndexRecord } = require('./entry');
const { containsLoneSurrogate } = require('./text');

const SUPPORTED_SCHEMA = 1;
const MAX_ENVELOPE_BYTES = 1 << 20;
const MAX_VALIDITY_MS = 31 * 24 * 3600 * 1000;
const ID = /^[a-z0-9][a-z0-9-]{1,31}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
const STATUSES = new Set(['approved', 'needs-approval', 'suspended']);
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
const MAX_TERMS_LANGUAGES = 16;

/** The failures of Launcher.Core's RegistryFailure that the reader and the freshness checks can produce. */
class RegistryError extends Error {
  constructor(failure, message) {
    super(message);
    this.name = 'RegistryError';
    this.failure = failure;
  }
}
const invalid = (message) => new RegistryError('Invalid', message);

const formatTime = (date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * The payload for `entries` (parsed, valid servers/*.json files) issued at `now`. The serial is the issue time in
 * Unix seconds, so every later signing has a higher one without any stored counter.
 */
function buildPayload(entries, { now, validityDays, minLauncher }) {
  const issued = new Date(Math.floor(now.getTime() / 1000) * 1000);
  const expires = new Date(issued.getTime() + validityDays * 24 * 3600 * 1000);
  if (!(expires - issued > 0) || expires - issued > MAX_VALIDITY_MS) throw new Error('The validity must be between 0 and 31 days.');
  if (entries.length > limits.MAX_ENTRIES) throw new Error(`The index would list ${entries.length} servers; the limit is ${limits.MAX_ENTRIES}.`);
  const ids = entries.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) throw new Error('Two entries have the same id.');
  return {
    schema: SUPPORTED_SCHEMA,
    serial: issued.getTime() / 1000,
    issuedAt: formatTime(issued),
    expiresAt: formatTime(expires),
    minLauncher,
    servers: [...entries].sort((a, b) => (a.id < b.id ? -1 : 1)).map(toIndexRecord)
  };
}

/** Signs the payload bytes as they will be shipped: ECDSA P-256, SHA-256, DER. Returns the envelope text. */
function signEnvelope(payload, privateKey, keyId) {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = crypto.sign('sha256', bytes, { key: privateKey, dsaEncoding: 'der' });
  const text = `${JSON.stringify({ keyId, signature: signature.toString('base64'), payload: bytes.toString('base64') })}\n`;
  if (Buffer.byteLength(text) > MAX_ENVELOPE_BYTES) throw new Error(`The index is ${Buffer.byteLength(text)} bytes; the launcher reads at most ${MAX_ENVELOPE_BYTES}.`);
  return text;
}

function decodeBase64(value, what) {
  const compact = value.replace(/[ \t\r\n]/g, '');
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) throw new RegistryError('Malformed', `The ${what} is not base64.`);
  return Buffer.from(compact, 'base64');
}

function requireString(object, name) {
  if (typeof object[name] !== 'string') throw invalid(`Field '${name}' must be a string.`);
  return object[name];
}

function requireInteger(object, name) {
  if (!Number.isSafeInteger(object[name])) throw invalid(`Field '${name}' must be an integer.`);
  return object[name];
}

function requireTime(object, name) {
  const text = requireString(object, name);
  const match = TIME.exec(text);
  if (!match) throw invalid(`Field '${name}' must be a UTC time like 2026-01-01T00:00:00Z.`);
  const date = new Date(text);
  if (Number.isNaN(date.getTime()) || formatTime(date) !== text) throw invalid(`Field '${name}' is not a real time.`);
  return date;
}

const isRelativePath = (value) => value.length > 0 && !value.startsWith('/') && !value.includes('\\') && !value.split('/').some((part) => part === '' || part === '.' || part === '..');

function isHttpsLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isBaseUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && !value.includes('?') && !value.includes('#') && value.endsWith('/');
  } catch {
    return false;
  }
}

/** Mirrors RegistryIndexReader.ParseEntry: what the launcher insists on for one entry of the index. */
function parseReaderEntry(element) {
  if (element === null || typeof element !== 'object' || Array.isArray(element)) throw invalid('The server entry must be a JSON object.');
  const id = requireString(element, 'id');
  if (!ID.test(id)) throw invalid(`'${id}' is not a valid server id.`);
  const name = requireString(element, 'name');
  if (name.length === 0 || name.length > 48 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) throw invalid(`Server '${id}' has an invalid name.`);
  if (!Array.isArray(element.mirrors) || element.mirrors.length === 0 || element.mirrors.length > limits.MAX_MIRRORS || !element.mirrors.every((m) => typeof m === 'string' && isBaseUrl(m))) {
    throw invalid(`Server '${id}' has invalid mirrors.`);
  }
  for (const field of ['website', 'community']) {
    if (element[field] !== undefined && element[field] !== null && !(typeof element[field] === 'string' && isHttpsLink(element[field]))) throw invalid(`Server '${id}' has an invalid ${field} link.`);
  }
  const status = requireString(element, 'status');
  if (!STATUSES.has(status)) throw invalid(`Server '${id}' has an unknown status '${status}'.`);
  const digests = element.digests;
  if (digests === null || typeof digests !== 'object' || Array.isArray(digests)) throw invalid(`Server '${id}' digests must be an object.`);
  const keys = Object.keys(digests);
  if (keys.length === 0 || keys.length > limits.MAX_DIGESTS) throw invalid(`Server '${id}' needs between 1 and ${limits.MAX_DIGESTS} digests.`);
  for (const key of keys) {
    if (!isRelativePath(key) || typeof digests[key] !== 'string' || !DIGEST.test(digests[key])) throw invalid(`Server '${id}' has an invalid digest entry '${key}'.`);
  }
  const pinned = (field) => {
    const value = element[field];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || !isRelativePath(value) || !Object.hasOwn(digests, value)) throw invalid(`Server '${id}' has a ${field} that is not a pinned path.`);
    return value;
  };
  const theme = pinned('theme');
  const about = pinned('about');
  const terms = {};
  if (element.terms !== undefined && element.terms !== null) {
    if (typeof element.terms !== 'object' || Array.isArray(element.terms)) throw invalid(`Server '${id}' terms must be an object.`);
    for (const [language, file] of Object.entries(element.terms)) {
      if (!LANGUAGE.test(language) || typeof file !== 'string' || !isRelativePath(file) || !Object.hasOwn(digests, file)) throw invalid(`Server '${id}' has an invalid terms entry '${language}'.`);
      terms[language] = file;
    }
    const count = Object.keys(terms).length;
    if (count > MAX_TERMS_LANGUAGES || (count > 0 && !Object.hasOwn(terms, 'en'))) throw invalid(`Server '${id}' terms need an 'en' text and at most ${MAX_TERMS_LANGUAGES} languages.`);
  }
  return { id, name, status, mirrors: element.mirrors, digests, theme, about, terms, raw: element };
}

/** Mirrors RegistryIndexReader.ParsePayload, for a payload whose signature was already checked. */
function parsePayload(bytes) {
  let root;
  try {
    root = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new RegistryError('Malformed', 'The registry index payload is not valid JSON.');
  }
  if (root === null || typeof root !== 'object' || Array.isArray(root)) throw invalid('The payload must be a JSON object.');
  if (containsLoneSurrogate(root)) throw invalid('The payload contains an unpaired UTF-16 surrogate.');
  const schema = requireInteger(root, 'schema');
  if (schema !== SUPPORTED_SCHEMA) throw new RegistryError('UnsupportedSchema', `The registry index uses schema ${schema}; this reader supports ${SUPPORTED_SCHEMA}.`);
  const issuedAt = requireTime(root, 'issuedAt');
  const expiresAt = requireTime(root, 'expiresAt');
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_VALIDITY_MS) throw invalid('The registry index has an invalid validity window.');
  const serial = requireInteger(root, 'serial');
  if (serial < 1) throw invalid('The registry index serial must be positive.');
  const minLauncher = requireString(root, 'minLauncher');
  if (!/^\d+(\.\d+){1,3}$/.test(minLauncher)) throw invalid('The registry index minLauncher is not a version.');
  if (!Array.isArray(root.servers) || root.servers.length > limits.MAX_ENTRIES) throw invalid('The registry index server list is invalid.');
  const servers = root.servers.map(parseReaderEntry);
  if (new Set(servers.map((server) => server.id)).size !== servers.length) throw invalid('The registry index lists the same id twice.');
  return { schema, serial, issuedAt, expiresAt, minLauncher, servers };
}

/**
 * Reads index.json the way RegistryIndexReader.Read does: envelope shape, key id, signature, then payload.
 * `keys` maps a key id to a public key (KeyObject or PEM).
 */
function readIndex(envelopeBytes, keys) {
  if (!envelopeBytes || envelopeBytes.length === 0 || envelopeBytes.length > MAX_ENVELOPE_BYTES) throw new RegistryError('Malformed', 'The registry index has an unexpected size.');
  let keyId;
  let signature;
  let payload;
  try {
    const root = JSON.parse(Buffer.from(envelopeBytes).toString('utf8'));
    if (root === null || typeof root !== 'object' || Array.isArray(root)) throw new Error('not an object');
    for (const name of ['keyId', 'signature', 'payload']) if (typeof root[name] !== 'string') throw new Error(name);
    keyId = root.keyId;
    signature = decodeBase64(root.signature, 'signature');
    payload = decodeBase64(root.payload, 'payload');
  } catch {
    throw new RegistryError('Malformed', 'The registry index is not a valid envelope.');
  }
  const key = keys.get(keyId);
  if (!key) throw new RegistryError('UnknownKey', `Unknown registry key '${String(keyId).slice(0, 20)}'.`);
  let verified = false;
  try {
    verified = crypto.verify('sha256', payload, { key, dsaEncoding: 'der' }, signature);
  } catch {
    verified = false;
  }
  if (!verified) throw new RegistryError('BadSignature', 'The registry index signature is not valid.');
  return parsePayload(payload);
}

/** The checks RegistryClient adds on top of the reader: expiry, rollback and the launcher version. */
function checkFreshness(index, { now = new Date(), serialFloor = 0, launcherVersion = null } = {}) {
  if (now >= index.expiresAt) throw new RegistryError('Expired', 'The registry index has expired.');
  if (index.serial < serialFloor) throw new RegistryError('Rollback', 'The registry index is older than one already accepted.');
  if (launcherVersion) {
    const have = launcherVersion.split('.').map(Number);
    const need = index.minLauncher.split('.').map(Number);
    for (let i = 0; i < Math.max(have.length, need.length); i++) {
      if ((have[i] || 0) !== (need[i] || 0)) {
        if ((have[i] || 0) < (need[i] || 0)) throw new RegistryError('LauncherTooOld', 'This launcher is too old for the registry index.');
        break;
      }
    }
  }
}

function loadPublicKey(pem) {
  const key = crypto.createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails.namedCurve !== 'prime256v1') throw new Error('The registry key must be an ECDSA P-256 key.');
  return key;
}

module.exports = {
  RegistryError, buildPayload, signEnvelope, readIndex, parsePayload, checkFreshness, loadPublicKey, formatTime,
  SUPPORTED_SCHEMA, MAX_ENVELOPE_BYTES
};
