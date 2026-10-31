'use strict';

const limits = require('./limits');
const { toIndexRecord } = require('./entry');

/** A cautious estimate of the signed envelope for these entries: base64 of the payload plus the envelope fields. */
function estimateEnvelopeBytes(entries) {
  const payload = JSON.stringify({
    schema: 1,
    serial: 9999999999,
    issuedAt: '2026-01-01T00:00:00Z',
    expiresAt: '2026-01-15T00:00:00Z',
    minLauncher: '99.99.99.99',
    servers: entries.map(toIndexRecord)
  });
  return Math.ceil(Buffer.byteLength(payload) / 3) * 4 + 400;
}

const fitsInEnvelope = (entries) => estimateEnvelopeBytes(entries) <= limits.MAX_INDEX_ENVELOPE_BYTES;

module.exports = { estimateEnvelopeBytes, fitsInEnvelope };
