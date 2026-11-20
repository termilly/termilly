// Tests for readSchemes (src/Termilly.Desktop/wwwroot/js/schemes.js): Dracula as iTerm2, Windows Terminal, Ghostty,
// Kitty, Alacritty and Warp write it (fixtures/schemes, from github.com/mbadolato/iTerm2-Color-Schemes and
// github.com/warpdotdev/themes), and the ways real files differ from them. Run with: node --test tests/js/schemes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readSchemes, hexColour, SCHEME_ERROR } from '../../src/Termilly.Desktop/wwwroot/js/schemes.js';

const fixture = name => readFileSync(new URL(`./fixtures/schemes/${name}`, import.meta.url), 'utf8');
const one = (file, text = fixture(file)) => {
  const { schemes, skipped } = readSchemes(file, text);
  assert.equal(schemes.length, 1);
  assert.equal(skipped, 0);
  return schemes[0];
};
/** Dracula's colours as Kitty writes them, to build other formats' lines from. */
const DRACULA = one('Dracula.conf');
const NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

for (const file of ['Dracula.itermcolors', 'Dracula.json', 'Dracula-ghostty', 'Dracula.conf', 'Dracula.toml']) {
  test(`${file}: Dracula's background, text and 16 colours`, () => {
    const s = one(file);
    assert.equal(s.background, '#282a36');
    assert.equal(s.foreground, '#f8f8f2');
    assert.equal(s.ansi.length, 16);
    assert.equal(s.ansi[1], '#ff5555');
    assert.equal(s.ansi[4], '#bd93f9');
    assert.ok(s.ansi.every(c => /^#[0-9a-f]{6}$/.test(c)));
  });
}

test('Warp reads its normal and bright colours whatever their order', () => {
  const s = one('dracula.yaml');
  assert.equal(s.background, '#282a36');
  assert.equal(s.ansi[0], '#000000');
  assert.equal(s.ansi[4], '#bd93f9');
  assert.equal(s.ansi[8], '#555555');
  assert.equal(s.ansi[12], '#caa9fa');
});

test('Warp with its background after the terminal colours, and comments after values', () => {
  const lines = fixture('dracula.yaml').split('\n');
  const root = lines.filter(l => /^(background|foreground|accent|details):/.test(l));
  const rest = lines.filter(l => !root.includes(l)).map(l => (/#[0-9a-f]{6}"$/i.test(l) ? `${l} # a comment` : l));
  const s = one('dracula.yaml', [...rest, ...root].join('\n'));
  assert.equal(s.background, '#282a36');
  assert.equal(s.ansi[12], '#caa9fa');
});

test('Alacritty’s older YAML', () => {
  const section = (name, from) => [`  ${name}:`, ...NAMES.map((n, i) => `    ${n}: '${DRACULA.ansi[from + i]}'`)];
  const text = ['colors:', '  primary:', `    background: '${DRACULA.background}'`, `    foreground: '${DRACULA.foreground}' # text`,
    '  cursor:', "    text: '#282a36'", "    cursor: '#f8f8f2'", ...section('normal', 0), ...section('bright', 8)].join('\n');
  const s = one('dracula.yml', text);
  assert.deepEqual(s.ansi, DRACULA.ansi);
  assert.equal(s.cursor, '#f8f8f2');
});

test('Alacritty’s TOML with comments after values and headers, and an inline cursor table', () => {
  const body = fixture('Dracula.toml').replace(/^(\w+\s*=\s*['"]#[0-9a-f]{6}['"])/gim, '$1 # comment').replace('[colors.normal]', '[colors.normal] # the 8');
  assert.ok((body.match(/# comment/g) ?? []).length >= 16, 'the comments are there');
  const s = one('Dracula.toml', `${body}\n[colors]\ncursor = { text = "#282a36", cursor = "#aabbcc" }\n`);
  assert.equal(s.ansi[1], '#ff5555');
  assert.equal(s.cursor, '#aabbcc');
});

test('Alacritty’s selection background doesn’t replace the terminal’s', () => {
  const text = `${fixture('Dracula.toml')}\n[colors.selection]\nbackground = "#44475a"\n`;
  assert.equal(one('Dracula.toml', text).background, '#282a36');
});

test('Ghostty’s palette numbers in other forms', () => {
  const text = fixture('Dracula-ghostty').replace('palette = 0=', 'palette = 00=').replace('palette = 15=', 'palette = 0x0f=');
  assert.deepEqual(one('Dracula', text).ansi, one('Dracula-ghostty').ansi);
});

test('iTerm2 with whole-number components, and a colour missing one refused', () => {
  const whole = fixture('Dracula.itermcolors').replace(/<real>1<\/real>/g, '<integer>1</integer>');
  assert.deepEqual(one('Dracula.itermcolors', whole).ansi, one('Dracula.itermcolors').ansi);
  const missing = fixture('Dracula.itermcolors').replace(/<key>Red Component<\/key>\s*<real>[^<]+<\/real>/, '');
  assert.throws(() => readSchemes('Dracula.itermcolors', missing), { message: SCHEME_ERROR.incomplete });
});

test('a scheme is named from the file, or from the name it gives', () => {
  assert.equal(one('Dracula.itermcolors').name, 'Dracula');
  assert.equal(one('Dracula.json').name, 'Dracula');
  assert.equal(one('C:\\themes\\Dracula.toml', fixture('Dracula.toml')).name, 'Dracula', 'the folder goes');
});

test('a Windows Terminal settings file gives each of its schemes, and counts the ones missing colours', () => {
  const dracula = JSON.parse(fixture('Dracula.json'));
  const half = { name: 'Half', background: '#000000' };
  const text = JSON.stringify({ profiles: {}, schemes: [dracula, { ...dracula, name: 'Second' }, half, { name: 'No colours' }] });
  const read = readSchemes('settings.json', text);
  assert.deepEqual(read.schemes.map(s => s.name), ['Dracula', 'Second']);
  assert.equal(read.skipped, 2, "Half, and the one with no colours at all");
});

test('Windows Terminal JSON with a byte order mark, comments and trailing commas', () => {
  const body = fixture('Dracula.json')
    .replace('{', '{\n  // copied from https://example.com/a//b\n  /* a block */\n')
    .replace(/("selectionBackground": "[^"]+")/, '$1,');
  assert.equal(one('settings.json', `\uFEFF// my schemes\n${body}`).name, 'Dracula');
});

test('a file that is no scheme, or one without all its colours, says so', () => {
  assert.throws(() => readSchemes('notes.txt', 'just some text'), { message: SCHEME_ERROR.unknown });
  assert.throws(() => readSchemes('half.conf', 'background #000000\nforeground #ffffff\ncolor0 #000000\n'), { message: SCHEME_ERROR.incomplete });
  assert.throws(() => readSchemes('x.json', '{"profiles": {}}'), { message: SCHEME_ERROR.unknown });
});

test('colours are read however a scheme writes them', () => {
  assert.equal(hexColour('#FFF'), '#ffffff');
  assert.equal(hexColour('0x1E1E2E'), '#1e1e2e');
  assert.equal(hexColour("'282a36'"), '#282a36');
  assert.equal(hexColour('rgb(1,2,3)'), null);
});

test('JSON wins over an iTerm2 look-alike, and commas inside names stay', () => {
  const dracula = JSON.parse(fixture('Dracula.json'));
  assert.equal(one('a.json', JSON.stringify({ ...dracula, name: '<plist>' })).name, '<plist>');
  assert.equal(one('a.json', JSON.stringify({ ...dracula, name: 'Comma,]' })).name, 'Comma,]');
});

test('a Windows Terminal list counts every entry that isn’t a whole scheme, and odd values break nothing', () => {
  const dracula = JSON.parse(fixture('Dracula.json'));
  const read = readSchemes('list.json', JSON.stringify([dracula, { name: 'No background' }, { ...dracula, name: 'Odd', black: { toString: null } }, 7]));
  assert.deepEqual(read.schemes.map(s => s.name), ['Dracula']);
  assert.equal(read.skipped, 3);
  assert.throws(() => readSchemes('profiles.json', '{"profiles": {"list": []}}'), { message: SCHEME_ERROR.unknown });
});

test('quoted section names in Alacritty’s TOML and Warp’s YAML', () => {
  const toml = fixture('Dracula.toml').replace('[colors.normal]', '["colors"."normal"]');
  assert.equal(one('Dracula.toml', toml).ansi[1], '#ff5555');
  const yaml = fixture('dracula.yaml').replace('terminal_colors:', '"terminal_colors":');
  assert.equal(one('dracula.yaml', yaml).ansi[12], '#caa9fa');
});

test('XML comments in iTerm2 files neither hide a value nor bring one back', () => {
  const between = fixture('Dracula.itermcolors').replace(/(<key>Red Component<\/key>)/, '$1<!-- note -->');
  assert.equal(one('Dracula.itermcolors', between).ansi.length, 16);
  const commented = fixture('Dracula.itermcolors').replace(/(<key>Red Component<\/key>\s*<real>[^<]+<\/real>)/, '<!-- $1 -->');
  assert.throws(() => readSchemes('Dracula.itermcolors', commented), { message: SCHEME_ERROR.incomplete });
});
