'use strict';

const limits = require('./limits');
const { isRelativePath } = require('./entry');
const { imageInfo } = require('./images');

const LAYOUTS = new Set(['classic', 'sidebar', 'banner', 'minimal']);
const FONTS = new Set(['montserrat']);
const FACT_KEYS = new Set(['playstyle', 'pvp', 'difficulty', 'region', 'languages', 'wipes', 'restarts']);
const SCHEMES = ['dark', 'light'];
const DIRECTIONS = new Set(['horizontal', 'vertical', 'diagonal']);
const POSITIONS = new Set(['left', 'center', 'right']);
const COLOR = /^#[0-9A-Fa-f]{6}$/;
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

function decodeUtf8(bytes) {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

function parseJsonFile(bytes) {
  let text;
  try {
    text = decodeUtf8(bytes);
  } catch {
    return { error: 'The file is not valid UTF-8.' };
  }
  if (text.charCodeAt(0) === 0xfeff) return { error: 'Remove the byte order mark at the start of the file.' };
  try {
    return { value: JSON.parse(text) };
  } catch (cause) {
    return { error: `The file is not valid JSON: ${cause.message}` };
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function collector() {
  const errors = [];
  const warnings = [];
  return { errors, warnings, error: (message) => errors.push(message), warn: (message) => warnings.push(message) };
}

function checkPaint(value, where, c, allowNone) {
  if (!isObject(value)) return c.warn(`${where} is not a paint; the default is used.`);
  if (value.type === 'none' && allowNone) return undefined;
  if (value.type === 'solid') {
    if (typeof value.color !== 'string' || !COLOR.test(value.color)) c.warn(`${where}.color must be #RRGGBB (no alpha); the default is used.`);
  } else if (value.type === 'gradient') {
    for (const stop of ['from', 'to']) {
      if (typeof value[stop] !== 'string' || !COLOR.test(value[stop])) c.warn(`${where}.${stop} must be #RRGGBB (no alpha); the default is used.`);
    }
    if (!DIRECTIONS.has(value.direction)) c.warn(`${where}.direction must be horizontal, vertical or diagonal.`);
  } else {
    c.warn(`${where}.type is not a known paint type; the default is used.`);
  }
  return undefined;
}

/** Checks theme.json against docs/themes.md. Returns { errors, warnings, images: [{ file, role }] }. */
function checkTheme(bytes, digests) {
  const c = collector();
  const images = [];
  const parsed = parseJsonFile(bytes);
  if (parsed.error) {
    c.error(parsed.error);
    return { ...c, images };
  }
  const theme = parsed.value;
  if (!isObject(theme)) {
    c.error('theme.json must be a JSON object.');
    return { ...c, images };
  }

  const pinned = (file, where) => {
    if (typeof file !== 'string' || !isRelativePath(file)) {
      c.error(`${where} must be a relative path without .., a leading / or a backslash.`);
      return false;
    }
    if (!Object.hasOwn(digests, file)) {
      c.error(`${where} ${JSON.stringify(file)} is not listed in digests.`);
      return false;
    }
    return true;
  };

  if (!Number.isInteger(theme.themeSchema)) c.error('themeSchema must be an integer.');
  if (theme.layout !== undefined && !LAYOUTS.has(theme.layout)) c.warn(`layout ${JSON.stringify(String(theme.layout).slice(0, 30))} is not a known template; the launcher uses classic.`);
  if (theme.online !== undefined && theme.online !== 'left' && theme.online !== 'right') c.warn('online must be left or right; the launcher uses left.');
  if (theme.font !== undefined && !FONTS.has(theme.font)) c.warn(`font ${JSON.stringify(String(theme.font).slice(0, 30))} is not on the allowlist; the default font is used.`);

  if (theme.logo !== undefined) {
    if (!isObject(theme.logo)) c.error('logo must be an object with a file.');
    else if (pinned(theme.logo.file, 'logo.file')) images.push({ file: theme.logo.file, role: 'logo' });
  }

  let borderWidth = 0;
  if (theme.button !== undefined) {
    if (!isObject(theme.button)) c.warn('button must be an object.');
    else {
      const { radius, borderWidth: width } = theme.button;
      if (radius !== undefined && !(Number.isInteger(radius) && radius >= 0 && radius <= 12)) c.warn('button.radius must be an integer from 0 to 12; the launcher clamps it.');
      if (width !== undefined && !(Number.isInteger(width) && width >= 0 && width <= 4)) c.warn('button.borderWidth must be an integer from 0 to 4; the launcher clamps it.');
      if (Number.isInteger(width)) borderWidth = width;
    }
  }

  if (theme.schemes !== undefined) {
    if (!isObject(theme.schemes)) c.warn('schemes must be an object.');
    else {
      for (const name of SCHEMES) {
        const scheme = theme.schemes[name];
        if (scheme === undefined) continue;
        const where = `schemes.${name}`;
        if (!isObject(scheme)) {
          c.warn(`${where} must be an object; the other scheme is used.`);
          continue;
        }
        if (scheme.accent !== undefined && !(typeof scheme.accent === 'string' && COLOR.test(scheme.accent))) c.warn(`${where}.accent must be #RRGGBB (no alpha); the default is used.`);
        if (scheme.buttonFill !== undefined) checkPaint(scheme.buttonFill, `${where}.buttonFill`, c, true);
        if (scheme.buttonBorder !== undefined) checkPaint(scheme.buttonBorder, `${where}.buttonBorder`, c, true);
        if (isObject(scheme.buttonFill) && scheme.buttonFill.type === 'none') {
          const border = scheme.buttonBorder;
          if (!isObject(border) || border.type === 'none' || borderWidth < 1) c.warn(`${where}: a button without a fill needs a border paint and a borderWidth of at least 1; the default fill is used.`);
        }
        if (scheme.art !== undefined) {
          if (isObject(scheme.art) && scheme.art.type === 'image') {
            if (scheme.art.position !== undefined && !POSITIONS.has(scheme.art.position)) c.warn(`${where}.art.position must be left, center or right.`);
            if (pinned(scheme.art.file, `${where}.art.file`)) images.push({ file: scheme.art.file, role: 'art' });
          } else {
            checkPaint(scheme.art, `${where}.art`, c, false);
          }
        }
      }
    }
  }
  return { ...c, images };
}

function checkMarkdown(text, label, c) {
  if (text.includes('\u0000')) c.error(`${label} contains NUL characters.`);
  if (/<\/?[A-Za-z][A-Za-z0-9-]*(\s[^>]*)?>/.test(text)) c.warn(`${label} contains HTML; the launcher shows it as plain text.`);
  if (/!\[[^\]]*\]\(/.test(text)) c.warn(`${label} contains an image; the launcher never renders images.`);
  const targets = [...text.matchAll(/\]\(\s*<?([^)\s>]+)/g)].map((match) => match[1]);
  targets.push(...[...text.matchAll(/<([A-Za-z][A-Za-z0-9+.-]*:[^>\s]*)>/g)].map((match) => match[1]));
  const bad = targets.filter((target) => /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) && !/^https:/i.test(target));
  if (bad.length) c.warn(`${label} has ${bad.length} link(s) that are not https (for example ${JSON.stringify(bad[0].slice(0, 40))}); the launcher does not open them.`);
}

function checkTextMap(value, name, maxChars, c, { oneLine }) {
  if (!isObject(value)) {
    c.error(`${name} must be an object of language code to text.`);
    return;
  }
  if (typeof value.en !== 'string' || value.en.length === 0) c.error(`${name}.en is required.`);
  for (const [language, text] of Object.entries(value)) {
    if (!LANGUAGE.test(language)) c.warn(`${name} has a language code that looks wrong: ${JSON.stringify(language.slice(0, 20))}.`);
    if (typeof text !== 'string') c.error(`${name}.${language} must be text.`);
    else if (text.length > maxChars) c.error(`${name}.${language} is ${text.length} characters; the limit is ${maxChars}.`);
    else if (oneLine && /[\r\n]/.test(text)) c.error(`${name}.${language} must be one line.`);
    else if (!oneLine) checkMarkdown(text, `${name}.${language}`, c);
  }
}

/** Checks about.json against docs/server-page.md. */
function checkAbout(bytes) {
  const c = collector();
  const parsed = parseJsonFile(bytes);
  if (parsed.error) {
    c.error(parsed.error);
    return c;
  }
  const about = parsed.value;
  if (!isObject(about)) {
    c.error('about.json must be a JSON object.');
    return c;
  }
  if (!Number.isInteger(about.aboutSchema)) c.error('aboutSchema must be an integer.');
  if (about.tagline !== undefined) checkTextMap(about.tagline, 'tagline', limits.MAX_TAGLINE_CHARS, c, { oneLine: true });
  if (about.facts !== undefined) {
    if (!isObject(about.facts)) c.error('facts must be an object.');
    else {
      for (const [key, value] of Object.entries(about.facts)) {
        if (!FACT_KEYS.has(key)) c.warn(`facts.${key.slice(0, 30)} is not in the vocabulary and is ignored.`);
        else if (typeof value !== 'string') c.error(`facts.${key} must be text.`);
        else if (value.length > limits.MAX_FACT_CHARS) c.error(`facts.${key} is ${value.length} characters; the limit is ${limits.MAX_FACT_CHARS}.`);
      }
    }
  }
  if (about.description !== undefined) checkTextMap(about.description, 'description', limits.MAX_DESCRIPTION_CHARS, c, { oneLine: false });
  return c;
}

/** Checks one terms file. */
function checkTerms(bytes, language) {
  const c = collector();
  let text;
  try {
    text = decodeUtf8(bytes);
  } catch {
    c.error(`The ${language} terms are not valid UTF-8.`);
    return c;
  }
  if (text.trim().length === 0) c.error(`The ${language} terms are empty.`);
  checkMarkdown(text, `The ${language} terms`, c);
  return c;
}

/** Checks a picture against the limits of docs/themes.md; `role` is logo or art. */
function checkImage(bytes, role) {
  const c = collector();
  let info;
  try {
    info = imageInfo(bytes);
  } catch (cause) {
    c.error(cause.message);
    return { ...c, info: null };
  }
  const maxWidth = role === 'logo' ? limits.LOGO_MAX_WIDTH : limits.ART_MAX_WIDTH;
  const maxHeight = role === 'logo' ? limits.LOGO_MAX_HEIGHT : limits.ART_MAX_HEIGHT;
  if (role === 'logo' && info.format !== 'png') c.error('The logo must be a PNG.');
  if (info.animated) c.error('Animated pictures are not accepted.');
  if (info.width > maxWidth || info.height > maxHeight) c.error(`The ${role} is ${info.width} x ${info.height} pixels; the limit is ${maxWidth} x ${maxHeight}.`);
  return { ...c, info };
}

module.exports = { checkTheme, checkAbout, checkTerms, checkImage, parseJsonFile, decodeUtf8, LAYOUTS, FACT_KEYS };
