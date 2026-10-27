'use strict';

const crypto = require('node:crypto');
const { FetchError } = require('../../tools/lib/net');
const { makePng } = require('./png');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const MIRROR_A = 'https://files-a.example.test/Launcher/';
const MIRROR_B = 'https://files-b.example.test/Launcher/';

function manifest(files, extra = '') {
  const lines = Object.entries(files).map(([name, data]) => `${sha256(data)} ${data.length} ${name}`);
  return `MANIFEST 3 sha256\n${extra}${lines.join('\n')}\n`;
}

/** An in-memory community: its files keyed by path, and an entry that pins them. */
function makeSite(options = {}) {
  const optional = { 'BepInEx/plugins/Extra/Extra.dll': Buffer.from('extra') };
  const mods = {
    'BepInEx/plugins/Demo/Demo.dll': Buffer.from('demo plugin bytes'),
    'BepInEx/plugins/Demo/manifest.json': Buffer.from('{"name":"Demo","version_number":"1.0.0"}'),
    'BepInEx/config/demo.cfg': Buffer.from('[General]\nEnabled = true\n')
  };
  const files = {
    'servers.json': Buffer.from('{"Servers":[{"Name":"Test"}]}'),
    'Profile/update.info': Buffer.from(manifest(mods)),
    'Profile/optional.info': Buffer.from(manifest(optional)),
    'Profile/game.info': Buffer.from(manifest({ 'valheim.exe': Buffer.from('game') }, '# game: 892972_1234567890\n')),
    'Profile/changelog.md': Buffer.from('# Changelog\n\n- first release\n'),
    'theme/theme.json': Buffer.from(JSON.stringify({
      themeSchema: 1,
      layout: 'classic',
      online: 'left',
      font: 'montserrat',
      logo: { file: 'theme/logo.png' },
      button: { radius: 6, borderWidth: 2 },
      schemes: {
        dark: { accent: '#C8A24A', buttonFill: { type: 'solid', color: '#8F6B1F' }, art: { type: 'image', file: 'theme/art.png', position: 'right' } },
        light: { accent: '#8F6B1F', art: { type: 'solid', color: '#E6C477' } }
      }
    })),
    'theme/logo.png': makePng(64, 64),
    'theme/art.png': makePng(320, 180),
    'about.json': Buffer.from(JSON.stringify({
      aboutSchema: 1,
      tagline: { en: 'Hardcore survival, no wipes' },
      facts: { playstyle: 'Hardcore survival', pvp: 'off' },
      description: { en: 'A long-running server.\n\n- Weekly events' }
    })),
    'terms/en.md': Buffer.from('## Rules\n\nBe kind.\n'),
    ...(options.files || {})
  };
  const modFiles = { ...mods, ...optional, ...(options.modFiles || {}) };
  for (const [name, data] of Object.entries(modFiles)) files[`Profile/${name}`] = data;

  const pinned = Object.keys(files).filter((name) => !Object.hasOwn(modFiles, name.replace(/^Profile\//, '')) || name.endsWith('.info'));
  const digests = Object.fromEntries(pinned.sort().map((name) => [name, sha256(files[name])]));
  const entry = {
    id: 'test-community',
    name: 'Test Community',
    status: 'approved',
    mirrors: [MIRROR_A, MIRROR_B],
    website: 'https://test-community.example.test/',
    digests: options.digests ? options.digests(digests) : digests,
    theme: 'theme/theme.json',
    about: 'about.json',
    terms: { en: 'terms/en.md' },
    ...(options.entry || {})
  };
  return { files, entry, digests };
}

/**
 * A downloader over in-memory mirrors. `mirrors` maps a base URL to { path: Buffer | FetchError } overrides;
 * by default every mirror serves the site's files. It enforces maxBytes like the real one and records requests.
 */
function fakeFetcher(site, { overrides = {}, down = [] } = {}) {
  const requests = [];
  return {
    requests,
    async download(url, { maxBytes, keep = true }) {
      requests.push(url);
      const base = [MIRROR_A, MIRROR_B].find((candidate) => url.startsWith(candidate));
      if (!base) throw new FetchError('NETWORK', 'unknown host');
      if (down.includes(base)) throw new FetchError('NETWORK', 'ECONNREFUSED');
      const relative = decodeURIComponent(url.slice(base.length));
      const served = overrides[base] && Object.hasOwn(overrides[base], relative) ? overrides[base][relative] : site.files[relative];
      if (served instanceof Error) throw served;
      if (served === undefined) throw new FetchError('HTTP_STATUS', 'HTTP 404', { status: 404 });
      if (served.length > maxBytes) throw new FetchError('TOO_LARGE', `The file is larger than the limit of ${maxBytes} bytes.`);
      return { status: 200, size: served.length, sha256: sha256(served), bytes: keep ? served : null, url, redirects: 0 };
    }
  };
}

module.exports = { makeSite, fakeFetcher, sha256, manifest, MIRROR_A, MIRROR_B };
