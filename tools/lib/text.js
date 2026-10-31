'use strict';

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁯﻿]/g;

const hasLoneSurrogate = (text) => LONE_SURROGATE.test(text);

/** True when any string or key in a parsed JSON value holds an unpaired UTF-16 surrogate, which the .NET reader rejects. */
function containsLoneSurrogate(value) {
  if (typeof value === 'string') return hasLoneSurrogate(value);
  if (Array.isArray(value)) return value.some(containsLoneSurrogate);
  if (value && typeof value === 'object') return Object.entries(value).some(([key, item]) => hasLoneSurrogate(key) || containsLoneSurrogate(item));
  return false;
}

const withoutInvisible = (text) => text.replace(INVISIBLE, '');

module.exports = { hasLoneSurrogate, containsLoneSurrogate, withoutInvisible };
