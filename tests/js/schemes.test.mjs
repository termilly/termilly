// Tests for readSchemes (src/Termilly.Desktop/wwwroot/js/schemes.js): Dracula as iTerm2, Windows Terminal, Ghostty,
// Kitty, Alacritty and Warp write it (fixtures/schemes, from github.com/mbadolato/iTerm2-Color-Schemes and
// github.com/warpdotdev/themes). Run with: node --test tests/js/schemes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readSchemes, hexColour, SCHEME_ERROR } from '../../src/Termilly.Desktop/wwwroot/js/schemes.js';

const fixture = name => readFileSync(new URL(`./fixtures/schemes/${name}`, import.meta.url), 'utf8');
const one = (file, text = fixture(file)) => {
  const schemes = readSchemes(file, text);
  assert.equal(schemes.length, 1);
  return schemes[0];
};

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

test('a scheme is named from the file, or from the name it gives', () => {
  assert.equal(one('Dracula.itermcolors').name, 'Dracula');
  assert.equal(one('Dracula.json').name, 'Dracula');
  assert.equal(one('C:\\themes\\Dracula.toml', fixture('Dracula.toml')).name, 'Dracula', 'the folder goes');
});

test('a Windows Terminal settings file gives each of its schemes', () => {
  const night = JSON.parse(fixture('Dracula.json'));
  const text = JSON.stringify({ profiles: {}, schemes: [night, { ...night, name: 'Second' }, { name: 'No colours' }] });
  assert.deepEqual(readSchemes('settings.json', text).map(s => s.name), ['Dracula', 'Second']);
});

test('Alacritty’s selection background doesn’t replace the terminal’s', () => {
  const text = `${fixture('Dracula.toml')}\n[colors.selection]\nbackground = "#44475a"\n`;
  assert.equal(one('Dracula.toml', text).background, '#282a36');
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
