// Tests for the compact view's lines (src/Termilly.Desktop/wwwroot/js/compactlines.js): Reads in a row fold into one
// line, a turn's footer sums up the files it changed, and the words are escaped before any formatting.
// Run with: node --test tests/js/compactlines.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Just enough of a page for the modules to load (ui.js loads host.js).
globalThis.window = /** @type {any} */ ({ addEventListener() {}, external: { receiveMessage() {}, sendMessage() {} } });
globalThis.document = /** @type {any} */ ({ documentElement: { dataset: {} }, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] });
globalThis.localStorage = /** @type {any} */ ({ getItem: () => null, setItem() {} });
globalThis.addEventListener = () => {};
const { foldLines, turnChanges, wordsHtml, linesHtml } = await import('../../src/Termilly.Desktop/wwwroot/js/compactlines.js');

const tool = (key, verb, text, detail, extra = {}) => ({ key, kind: 'tool', verb, text, detail, failed: false, done: true, ...extra });

test('reads in a row fold into one line with their counts summed; a failed or running read stays apart', () => {
  const lines = foldLines([
    tool('1', 'Read', 'a.cs', '120 lines'),
    tool('2', 'Read', 'b.cs', '40 lines'),
    tool('3', 'Read', 'c.cs', '2 lines'),
    tool('4', 'Edit', 'a.cs', '+1 -1'),
    tool('5', 'Read', 'd.cs', 'File not found', { failed: true }),
    tool('6', 'Read', 'e.cs', null, { done: false }),
  ]);
  assert.deepEqual(lines.map(l => [l.text, l.more ?? 0, l.detail]), [
    ['a.cs', 2, '162 lines'], ['a.cs', 0, '+1 -1'], ['d.cs', 0, 'File not found'], ['e.cs', 0, null],
  ]);
});

test('a turn sums the files it changed and their lines, new files included; failed edits do not count', () => {
  assert.deepEqual(turnChanges([
    tool('1', 'Edit', 'a.cs', '+9 -2'),
    tool('2', 'Edit', 'a.cs', '+1'),
    tool('3', 'Write', 'new.md', 'new · 40 lines'),
    tool('4', 'Edit', 'b.cs', 'old_string not found', { failed: true }),
    tool('5', 'Read', 'c.cs', '12 lines'),
  ]), { files: 2, added: 50, removed: 2 });
});

test('words are escaped first, then bold and code are drawn', () => {
  assert.equal(wordsHtml('Use **<b>** and `a<b`'), 'Use <b>&lt;b&gt;</b> and <code>a&lt;b</code>');
});

test('a turn shows its prompt, its steps and a footer with its time and changes', () => {
  const html = linesHtml([
    { key: 'p', kind: 'prompt', text: 'Fix it', failed: false, done: true },
    tool('1', 'Edit', 'a.cs', '+2 -1'),
    { key: 'e', kind: 'end', text: '', detail: '41s', failed: false, done: true },
  ]);
  assert.match(html, /cv-prompt">Fix it</);
  assert.match(html, /cv-end">41s<span class="cv-sep">·<\/span>1 file <span class="cv-add">\+2<\/span> <span class="cv-del">-1<\/span>/);
});

test('web addresses in a reply are links, with what a sentence puts after them left out, inside code too', () => {
  const html = wordsHtml('Open http://localhost:5173/. Or `https://a.b/c?x=1&y=2`');
  assert.match(html, /<span class="cv-link" data-link="http:\/\/localhost:5173\/" data-web title="[^"]*Ctrl\+click[^"]*">http:\/\/localhost:5173\/<\/span>\. Or /);
  assert.match(html, /<code><span class="cv-link" data-link="https:\/\/a\.b\/c\?x=1&amp;y=2" data-web/);
});

test('a plain click opens web addresses when the setting says so', () => {
  assert.match(wordsHtml('see https://a.b', [], true), /data-web data-plain title="https:\/\/a\.b\nClick to open/);
});

test('paths found in a line are links; a path inside a web address is left to the address', () => {
  const text = 'Wrote src/a.js, see https://x.y/src/a.js';
  const paths = [{ start: 6, end: 14, text: 'src/a.js', title: 'Ctrl+click' }, { start: 32, end: 40, text: 'src/a.js' }];
  const html = linesHtml([{ key: '1', kind: 'reply', text }], { paths: () => paths, plainClick: false });
  assert.equal((html.match(/class="cv-link"/g) ?? []).length, 2);
  assert.match(html, /Wrote <span class="cv-link" data-link="src\/a\.js" title="Ctrl\+click">src\/a\.js<\/span>, see <span class="cv-link" data-link="https:\/\/x\.y\/src\/a\.js" data-web/);
});

test('a tool line links its subject and a prompt its web address', () => {
  const html = linesHtml([
    { key: '1', kind: 'prompt', text: 'check https://e.x/a' },
    tool('2', 'Read', 'src/a <b>.js', '3 lines'),
  ], { paths: l => (l.kind === 'tool' ? [{ start: 0, end: 12, text: l.text }] : []), plainClick: false });
  assert.match(html, /check <span class="cv-link" data-link="https:\/\/e\.x\/a" data-web/);
  assert.match(html, /<span class="cv-subject"><span class="cv-link" data-link="src\/a &lt;b&gt;\.js"[^>]*>src\/a &lt;b&gt;\.js<\/span><\/span>/);
});
