'use strict';

const crypto = require('node:crypto');

/** Reads an ECDSA P-256 private key from PEM text. Never echoes the text in an error. */
function loadPrivateKey(pem) {
  let key;
  try {
    key = crypto.createPrivateKey(pem);
  } catch {
    throw new Error('The signing key is not a readable PEM private key.');
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails.namedCurve !== 'prime256v1') throw new Error('The signing key must be an ECDSA P-256 key.');
  return key;
}

const publicPem = (privateKey) => crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
const spkiBase64 = (publicKey) => publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const fingerprint = (publicKey) => crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');

function generateThrowawayKey() {
  return crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
}

module.exports = { loadPrivateKey, publicPem, spkiBase64, fingerprint, generateThrowawayKey };
