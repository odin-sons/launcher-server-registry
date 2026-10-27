'use strict';

// Untrusted text (names, URLs, messages from hostile servers) goes into pull request comments through these.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

function clean(value, max) {
  const text = String(value).replace(/\r?\n|\r/g, ' ').replace(CONTROL, '');
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/** Plain text with every markdown, HTML, mention and autolink trigger neutralised. */
function esc(value, max = 300) {
  return clean(value, max)
    .replace(/[\\`*_{}[\]<>()#+!|~&]/g, '\\$&')
    .replace(/:\/\//g, ':​//')
    .replace(/www\./gi, 'www​.')
    .replace(/@/g, '@​');
}

/** Inline code; nothing inside it is interpreted. */
function code(value, max = 200) {
  return `\`${clean(value, max).replace(/`/g, "'")}\``;
}

function bytes(count) {
  if (count < 1024) return `${count} B`;
  if (count < 1024 ** 2) return `${(count / 1024).toFixed(1)} KiB`;
  if (count < 1024 ** 3) return `${(count / 1024 ** 2).toFixed(1)} MiB`;
  return `${(count / 1024 ** 3).toFixed(2)} GiB`;
}

module.exports = { esc, code, bytes, clean };
