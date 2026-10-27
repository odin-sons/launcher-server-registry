'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseManifest, manifestKind } = require('../tools/lib/manifest');
const { checkImage, checkTheme, checkAbout, checkTerms } = require('../tools/lib/display');
const { makePng, makeJpegHeader } = require('./helpers/png');
const { detectImage } = require('../tools/lib/images');

const h = (c) => c.repeat(64);

test('parses the launcher manifest format', () => {
  const text = `MANIFEST 3 sha256\n${h('a')} 5 .doorstop_version\n${h('b')} 241 changelog.txt\n`;
  const manifest = parseManifest(text);
  assert.deepEqual(manifest.problems, []);
  assert.deepEqual(manifest.entries.map((entry) => [entry.path, entry.size]), [['.doorstop_version', 5], ['changelog.txt', 241]]);
  assert.equal(manifest.version, 3);
  assert.equal(manifest.algorithm, 'sha256');
});

test('paths keep their spaces and take everything to the end of the line', () => {
  const manifest = parseManifest(`MANIFEST 3 sha256\n${h('a')} 1 Old Bearded One spawn_odin_priest.yml\n`);
  assert.equal(manifest.entries[0].path, 'Old Bearded One spawn_odin_priest.yml');
});

test('comments, blank lines and CRLF are accepted, and the game directive is read', () => {
  const manifest = parseManifest(`# header comment\r\nMANIFEST 3 sha256\r\n# game: 892972_123\r\n\r\n${h('c')} 0 a.txt\r\n# trailing\r\n`);
  assert.deepEqual(manifest.problems, []);
  assert.equal(manifest.game, '892972_123');
  assert.equal(manifest.entries.length, 1);
});

test('the algorithm defaults to sha256 and is checked', () => {
  assert.deepEqual(parseManifest(`MANIFEST 3\n${h('a')} 1 a\n`).problems, []);
  assert.match(parseManifest(`MANIFEST 3 md5\n${h('a')} 1 a\n`).problems[0].message, /only sha256/);
  assert.match(parseManifest(`MANIFEST 4 sha256\n`).problems[0].message, /newer than the supported 3/);
});

test('slashes are trimmed and backslashes become slashes, as in the launcher', () => {
  const manifest = parseManifest(`MANIFEST 3 sha256\n${h('a')} 1 /dir\\file.txt/\n`);
  assert.equal(manifest.entries[0].path, 'dir/file.txt');
});

test('rejects what the launcher would trip over or what is unsafe', () => {
  const cases = {
    'not a manifest': 'hello\n',
    'empty': '',
    'bad version': 'MANIFEST x sha256\n',
    'missing size': `MANIFEST 3 sha256\n${h('a')} a.txt\n`,
    'bad size': `MANIFEST 3 sha256\n${h('a')} big a.txt\n`,
    'short hash': `MANIFEST 3 sha256\n${'a'.repeat(63)} 1 a.txt\n`,
    'negative size': `MANIFEST 3 sha256\n${h('a')} -1 a.txt\n`,
    'parent path': `MANIFEST 3 sha256\n${h('a')} 1 a/../b.txt\n`,
    'drive letter': `MANIFEST 3 sha256\n${h('a')} 1 C:/Windows/x.dll\n`,
    'duplicate by case': `MANIFEST 3 sha256\n${h('a')} 1 A.txt\n${h('b')} 1 a.TXT\n`,
    'control character': `MANIFEST 3 sha256\n${h('a')} 1 a\u0001b\n`
  };
  for (const [name, text] of Object.entries(cases)) assert.notEqual(parseManifest(text).problems.length, 0, name);
});

test('problems are capped', () => {
  const text = `MANIFEST 3 sha256\n${Array.from({ length: 100 }, () => 'bad').join('\n')}\n`;
  assert.ok(parseManifest(text).problems.length <= 21);
});

test('game manifests are told apart from mod manifests', () => {
  assert.equal(manifestKind('Profile/game.info'), 'game');
  assert.equal(manifestKind('Profile/game_macos.info'), 'game');
  assert.equal(manifestKind('Profile/update.info'), 'mods');
  assert.equal(manifestKind('Profile/update_admin.info'), 'mods');
  assert.equal(manifestKind('Profile/optional.info'), 'mods');
  assert.equal(manifestKind('servers.json'), null);
});

test('pictures: type, animation and size limits', () => {
  assert.equal(detectImage(makePng(2, 2)), 'png');
  assert.equal(detectImage(makeJpegHeader(2, 2)), 'jpeg');
  assert.equal(detectImage(Buffer.from('<svg/>')), null);
  assert.deepEqual(checkImage(makePng(512, 512), 'logo').errors, []);
  assert.match(checkImage(makePng(513, 512), 'logo').errors[0], /limit is 512 x 512/);
  assert.match(checkImage(makeJpegHeader(100, 100), 'logo').errors[0], /must be a PNG/);
  assert.deepEqual(checkImage(makeJpegHeader(1920, 1080), 'art').errors, []);
  assert.match(checkImage(makeJpegHeader(1921, 1080), 'art').errors[0], /limit is 1920 x 1080/);
  assert.match(checkImage(makePng(10, 10, { animated: true }), 'art').errors[0], /Animated/);
  assert.match(checkImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'art').errors[0], /neither a PNG nor a JPEG/);
  assert.equal(checkImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), 'art').errors.length, 1);
});

const pinned = { 'theme/logo.png': h('a'), 'theme/art.jpg': h('b') };
const theme = (value) => checkTheme(Buffer.from(JSON.stringify(value)), pinned);

test('theme.json: the documented example is accepted and its images are found', () => {
  const result = theme({
    themeSchema: 1, layout: 'classic', online: 'left', font: 'montserrat', logo: { file: 'theme/logo.png' }, button: { radius: 6, borderWidth: 2 },
    schemes: {
      dark: { accent: '#C8A24A', buttonFill: { type: 'gradient', from: '#C8A24A', to: '#8F6B1F', direction: 'horizontal' }, buttonBorder: { type: 'solid', color: '#E6C477' }, art: { type: 'image', file: 'theme/art.jpg', position: 'right' } },
      light: { accent: '#8F6B1F', buttonFill: { type: 'solid', color: '#8F6B1F' }, buttonBorder: { type: 'none' }, art: { type: 'image', file: 'theme/art.jpg', position: 'right' } }
    }
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.images.map((image) => image.role), ['logo', 'art', 'art']);
});

test('theme.json: unpinned images and a missing schema are errors', () => {
  const result = theme({ logo: { file: 'theme/other.png' }, schemes: { dark: { art: { type: 'image', file: '../x.png' } } } });
  assert.equal(result.errors.length, 3);
  assert.match(result.errors.join('\n'), /themeSchema must be an integer/);
  assert.match(result.errors.join('\n'), /logo\.file "theme\/other\.png" is not listed in digests/);
});

test('theme.json: things the launcher tolerates are warnings', () => {
  const result = theme({
    themeSchema: 1, layout: 'fancy', online: 'middle', font: 'comic', button: { radius: 40, borderWidth: 9 },
    schemes: { dark: { accent: '#C8A24A80', buttonFill: { type: 'none' }, art: { type: 'gradient', from: '#000000', to: 'red', direction: 'sideways' } } }
  });
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.length >= 8, result.warnings.join('\n'));
});

test('theme.json: broken input is an error', () => {
  assert.match(checkTheme(Buffer.from('{'), pinned).errors[0], /not valid JSON/);
  assert.match(checkTheme(Buffer.from('[]'), pinned).errors[0], /must be a JSON object/);
  assert.match(checkTheme(Buffer.from([0xff, 0xfe, 0xfd]), pinned).errors[0], /not valid UTF-8/);
});

test('about.json: limits of server-page.md', () => {
  const about = (value) => checkAbout(Buffer.from(JSON.stringify(value)));
  assert.deepEqual(about({ aboutSchema: 1, tagline: { en: 'x'.repeat(80) }, facts: { pvp: 'off', region: 'EU' }, description: { en: 'x'.repeat(2000) } }).errors, []);
  assert.match(about({ aboutSchema: 1, tagline: { en: 'x'.repeat(81) } }).errors[0], /limit is 80/);
  assert.match(about({ aboutSchema: 1, tagline: { en: 'a\nb' } }).errors[0], /one line/);
  assert.match(about({ aboutSchema: 1, tagline: { de: 'x' } }).errors[0], /tagline\.en is required/);
  assert.match(about({ aboutSchema: 1, facts: { pvp: 'x'.repeat(49) } }).errors[0], /limit is 48/);
  assert.match(about({ aboutSchema: 1, description: { en: 'x'.repeat(2001) } }).errors[0], /limit is 2000/);
  assert.match(about({ aboutSchema: 1, description: { de: 'x' } }).errors[0], /description\.en is required/);
  assert.match(about({}).errors[0], /aboutSchema/);
  assert.match(about({ aboutSchema: 1, facts: { mood: 'x' } }).warnings[0], /not in the vocabulary/);
});

test('markdown text: HTML, images and non-https links are flagged', () => {
  const warnings = checkTerms(Buffer.from('<b>x</b> ![p](https://x.test/p.png) [a](http://x.test) [b](javascript:alert(1)) [ok](https://x.test)'), 'en').warnings;
  assert.equal(warnings.length, 3);
  assert.deepEqual(checkTerms(Buffer.from('## Rules\n\n- be kind [site](https://x.test)'), 'en').warnings, []);
  assert.match(checkTerms(Buffer.from('  \n'), 'en').errors[0], /empty/);
  assert.match(checkTerms(Buffer.from([0xc3, 0x28]), 'en').errors[0], /not valid UTF-8/);
});
