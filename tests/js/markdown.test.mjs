// Tests for issue text as HTML (src/Termilly.Desktop/wwwroot/js/markdown.js): what GitHub issues hold most (templates
// with comments and headings, lists and task boxes, code, tables, links) draws as such, and nothing written in an
// issue reaches the page as HTML.
// Run with: node --test tests/js/markdown.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Just enough of a page for the modules to load (ui.js loads host.js).
globalThis.window = /** @type {any} */ ({ addEventListener() {}, external: { receiveMessage() {}, sendMessage() {} } });
globalThis.document = /** @type {any} */ ({ documentElement: { dataset: {} }, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] });
globalThis.localStorage = /** @type {any} */ ({ getItem: () => null, setItem() {} });
globalThis.addEventListener = () => {};
const { markdownHtml } = await import('../../src/Termilly.Desktop/wwwroot/js/markdown.js');

test('an issue template: its comments go, headings and paragraphs draw, line breaks stay', () => {
  const html = markdownHtml('<!-- Describe the bug -->\r\n### What happened\r\nIt broke\r\nagain.\r\n\r\n## Steps');
  assert.equal(html, '<h3>What happened</h3><p>It broke<br>again.</p><h2>Steps</h2>');
});

test('raw HTML is text, never markup; layout tags go quietly', () => {
  assert.equal(markdownHtml('<script>alert(1)</script> <details><summary>More</summary>x</details>'),
    '<p>&lt;script&gt;alert(1)&lt;/script&gt; Morex</p>');
  assert.equal(markdownHtml('"quoted" & \'single\''), '<p>&quot;quoted&quot; &amp; &#39;single&#39;</p>');
});

test('links keep their address out of href, and only web or mail addresses link', () => {
  assert.equal(markdownHtml('[docs](https://a.b/c "Docs") and https://x.y/z.'),
    '<p><a class="md-link" data-href="https://a.b/c" title="https://a.b/c">docs</a> and '
    + '<a class="md-link" data-href="https://x.y/z" title="https://x.y/z">https://x.y/z</a>.</p>');
  assert.equal(markdownHtml('[bad](javascript:alert(1))'), '<p>bad)</p>');
  assert.equal(markdownHtml('[here](./README.md)'), '<p>here</p>');
});

test('images and the tags GitHub\'s editor writes become links to them', () => {
  assert.equal(markdownHtml('<img width="300" alt="shot" src="https://github.com/u/a.png">'),
    '<p><a class="md-link md-image" data-href="https://github.com/u/a.png" title="https://github.com/u/a.png">Image: shot</a></p>');
  assert.equal(markdownHtml('<a href="https://a.b">site</a><br>next'),
    '<p><a class="md-link" data-href="https://a.b" title="https://a.b">site</a><br>next</p>');
});

test('inline code holds its text as written; emphasis, strikethrough and mentions draw', () => {
  assert.equal(markdownHtml('Run `a **b** <c>` now'), '<p>Run <code>a **b** &lt;c&gt;</code> now</p>');
  assert.equal(markdownHtml('**bold** _it_ *it* ~~gone~~ snake_case_name @alice'),
    '<p><strong>bold</strong> <em>it</em> <em>it</em> <del>gone</del> snake_case_name <span class="md-mention">@alice</span></p>');
  assert.equal(markdownHtml('\\*not italic\\*'), '<p>*not italic*</p>');
});

test('code blocks keep their lines and escape them', () => {
  assert.equal(markdownHtml('```\nif (a < b) {\n  go();\n}\n```\nafter'),
    '<pre class="md-code"><code>if (a &lt; b) {\n  go();\n}</code></pre><p>after</p>');
  assert.equal(markdownHtml('~~~\nnever closed'), '<pre class="md-code"><code>never closed</code></pre>');
});

test('lists nest, number from where they start, and tasks show their boxes', () => {
  assert.equal(markdownHtml('- one\n- two\n  - inner\n- [x] done\n- [ ] todo'),
    '<ul><li>one</li><li>two<ul><li>inner</li></ul></li><li class="md-task"><input type="checkbox" disabled checked> done</li>'
    + '<li class="md-task"><input type="checkbox" disabled> todo</li></ul>');
  assert.equal(markdownHtml('3. three\n4. four'), '<ol start="3"><li>three</li><li>four</li></ol>');
  assert.equal(markdownHtml('- a line\ncarried on'), '<ul><li>a line<br>carried on</li></ul>');
});

test('quotes, rules and tables', () => {
  assert.equal(markdownHtml('> said\n> this\n\n---'), '<blockquote><p>said<br>this</p></blockquote><hr>');
  assert.equal(markdownHtml('| OS | Ver |\n|:--|--:|\n| Mac | `15` |'),
    '<div class="md-table"><table><thead><tr><th>OS</th><th style="text-align:right">Ver</th></tr></thead>'
    + '<tbody><tr><td>Mac</td><td style="text-align:right"><code>15</code></td></tr></tbody></table></div>');
});
