// @ts-check
// GitHub's Markdown as HTML, for an issue's text and comments (js/gitissues.js): headings, paragraphs (their line
// breaks kept, as GitHub shows comments), lists with task boxes, quotes, code blocks (coloured when their language is
// known), tables and rules; inline code, bold, italic, strikethrough, links and bare web addresses.
// Everything is escaped: raw HTML shows as text, except comments (issue templates are full of them), which go, the
// few tags GitHub's editor writes (an image, a link, a line break) read as their Markdown, and layout tags (details,
// summary, p, div...), which go quietly. Links carry their address in data-href, never href, so a click can't take the
// window away; the caller opens them in the browser. Images show as links to them.

import { escapeHtml } from './ui.js';
import { findWebLinks } from './webaddress.js';
import { highlightLines, languageOf } from './highlight.js';

/** The attribute a link keeps its address in. */
export const LINK_HREF = 'data-href';
/** Stands in a line for a piece already made HTML, while the rest is escaped: a character no text holds. */
const HOLDER = '';
const HELD = new RegExp(`${HOLDER}(\\d+)${HOLDER}`, 'g');

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( *)([-*+]|(\d{1,9})[.)])(?:\s+(.*))?$/;
const TABLE_LINE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const TASK = /^\[([ xX])\]\s+/;
const HEADING_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
/** A table column's alignment, from the line under its head: ":--:" centres it, "--:" puts it right. */
const CENTRE = 'center';
const RIGHT = 'right';
/** Tags left out quietly, keeping what they hold. */
const LAYOUT_TAGS = /<\/?(?:details|summary|p|div|span|sub|sup|kbd|picture|source|center|b|strong|i|em|ins|code)\b[^>]*>/gi;
const IMG_TAG = /<img\b[^>]*?\bsrc=["']([^"']+)["'][^>]*>/gi;
const ALT = /\balt=["']([^"']*)["']/i;
const A_TAG = /<a\b[^>]*?\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const BR_TAG = /<br\s*\/?>/gi;
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const SAFE_ADDRESS = /^(?:https?:\/\/|mailto:)/i;

/**
 * The text as HTML, safe to put in the page.
 * @param {string | null | undefined} text
 */
export function markdownHtml(text) {
  const plain = String(text ?? '').replace(/\r\n?/g, '\n').replace(COMMENT, '')
    .replace(IMG_TAG, (tag, src) => `![${ALT.exec(tag)?.[1] ?? ''}](${src})`)
    .replace(A_TAG, (_, href, inner) => `[${inner}](${href})`)
    .replace(BR_TAG, '\n').replace(LAYOUT_TAGS, '');
  return blocksHtml(plain.split('\n'));
}

/**
 * Lines as blocks: each block's reader takes the lines it holds and says where the next block starts.
 * @param {string[]} lines
 */
function blocksHtml(lines) {
  const out = [];
  let at = 0;
  while (at < lines.length) {
    const line = lines[at];
    if (!line.trim()) { at++; continue; }
    const read = FENCE.test(line) ? codeBlock(lines, at)
      : HEADING.test(line) ? heading(line, at)
      : RULE.test(line) ? { html: '<hr>', next: at + 1 }
      : QUOTE.test(line) ? quote(lines, at)
      : ITEM.test(line) ? list(lines, at)
      : isTable(lines, at) ? table(lines, at)
      : paragraph(lines, at);
    out.push(read.html);
    at = read.next;
  }
  return out.join('');
}

/** @typedef {{ html: string, next: number }} Read */

/** @param {string[]} lines @param {number} at @returns {Read} */
function codeBlock(lines, at) {
  const [, fence, info] = /** @type {RegExpExecArray} */ (FENCE.exec(lines[at]));
  let end = at + 1;
  while (end < lines.length && !lines[end].trim().startsWith(fence)) end++;
  const code = lines.slice(at + 1, end).join('\n');
  const { lines: html } = highlightLines(code, info ? languageOf(`code.${info.toLowerCase()}`) : null);
  return { html: `<pre class="md-code"><code>${html.join('\n')}</code></pre>`, next: end + 1 };
}

/** @param {string} line @param {number} at @returns {Read} */
function heading(line, at) {
  const [, marks, words] = /** @type {RegExpExecArray} */ (HEADING.exec(line));
  const tag = HEADING_TAGS[marks.length - 1];
  return { html: `<${tag}>${inlineHtml(words)}</${tag}>`, next: at + 1 };
}

/** @param {string[]} lines @param {number} at @returns {Read} */
function quote(lines, at) {
  let end = at;
  while (end < lines.length && QUOTE.test(lines[end])) end++;
  return { html: `<blockquote>${blocksHtml(lines.slice(at, end).map(l => l.replace(QUOTE, '')))}</blockquote>`, next: end };
}

/**
 * A list: its items at the first one's indent, each with the lines under it (a nested list, more paragraphs), which
 * are read as blocks of their own.
 * @param {string[]} lines @param {number} at @returns {Read}
 */
function list(lines, at) {
  const first = /** @type {RegExpExecArray} */ (ITEM.exec(lines[at]));
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  let end = at;
  while (end < lines.length) {
    const m = ITEM.exec(lines[end]);
    if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) break;
    const inner = indent + m[2].length + 1;
    const [, , , , text = ''] = m;
    const body = [text];
    end++;
    for (; end < lines.length && belongsToItem(lines, end, indent); end++) {
      body.push(lines[end].slice(Math.min(inner, indentOf(lines[end])))); // its text, out from under the marker
    }
    items.push(itemHtml(body));
  }
  const [, , , number] = first;
  const from = Number(number);
  const start = ordered && from !== 1 ? ` start="${from}"` : '';
  const tag = ordered ? 'ol' : 'ul';
  return { html: `<${tag}${start}>${items.join('')}</${tag}>`, next: end };
}

/** @param {string} line */
const indentOf = line => line.length - line.trimStart().length;

/**
 * Whether a line still belongs to the item above: indented under it, or a line that carries its text on (not a
 * new item, not after a blank line).
 * @param {string[]} lines @param {number} at @param {number} indent the list's
 */
function belongsToItem(lines, at, indent) {
  const line = lines[at];
  if (!line.trim()) return at + 1 < lines.length && !!lines[at + 1].trim() && indentOf(lines[at + 1]) > indent;
  if (indentOf(line) > indent) return true;
  return !!lines[at - 1].trim() && !ITEM.test(line) && !FENCE.test(line) && !HEADING.test(line) && !QUOTE.test(line);
}

/** An item: a task's box, then its text. @param {string[]} body */
function itemHtml(body) {
  const task = TASK.exec(body[0]);
  if (task) body[0] = body[0].slice(task[0].length);
  const box = task ? `<input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}> ` : '';
  const html = blocksHtml(body).replace(/^<p>([\s\S]*?)<\/p>/, (_, words) => words); // its first lines bare, as GitHub shows them
  return `<li${task ? ' class="md-task"' : ''}>${box}${html}</li>`;
}

/** @param {string[]} lines @param {number} at */
const isTable = (lines, at) => lines[at].includes('|') && at + 1 < lines.length && TABLE_LINE.test(lines[at + 1]) && lines[at + 1].includes('-');

/** @param {string} line */
const cells = line => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map(c => c.trim());

/** @param {string[]} lines @param {number} at @returns {Read} */
function table(lines, at) {
  const aligns = cells(lines[at + 1]).map(c => (c.startsWith(':') && c.endsWith(':') ? CENTRE : c.endsWith(':') ? RIGHT : ''));
  const row = (/** @type {string} */ line, /** @type {string} */ tag) => `<tr>${cells(line).map((c, i) =>
    `<${tag}${aligns[i] ? ` style="text-align:${aligns[i]}"` : ''}>${inlineHtml(c)}</${tag}>`).join('')}</tr>`;
  let end = at + 2;
  const body = [];
  while (end < lines.length && lines[end].trim() && lines[end].includes('|')) body.push(row(lines[end++], 'td'));
  return { html: `<div class="md-table"><table><thead>${row(lines[at], 'th')}</thead><tbody>${body.join('')}</tbody></table></div>`, next: end };
}

/** Lines up to a blank one or another block's start, their breaks kept. @param {string[]} lines @param {number} at @returns {Read} */
function paragraph(lines, at) {
  let end = at + 1;
  while (end < lines.length && lines[end].trim() && !startsBlock(lines, end)) end++;
  return { html: `<p>${lines.slice(at, end).map(l => inlineHtml(l.trim())).join('<br>')}</p>`, next: end };
}

/** @param {string[]} lines @param {number} at */
const startsBlock = (lines, at) => [FENCE, HEADING, RULE, QUOTE].some(r => r.test(lines[at]))
  || /^ {0,3}[-*+]\s+\S/.test(lines[at]) || isTable(lines, at);

/**
 * A line's words as HTML: code, links and web addresses are taken out first (nothing inside them is Markdown), the
 * rest escaped and marked up, then they go back in.
 * @param {string} text
 */
export function inlineHtml(text) {
  /** @type {string[]} */
  const held = [];
  const hold = (/** @type {string} */ html) => `${HOLDER}${held.push(html) - 1}${HOLDER}`;
  let s = text.replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, (_, c) => hold(escapeHtml(c)))
    .replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, __, code) => hold(`<code>${escapeHtml(code.trim())}</code>`))
    .replace(/(!?)\[([^\]]*)\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_, image, words, href) => hold(linkHtml(href, words, !!image)))
    .replace(/<(https?:\/\/[^\s>]+)>/g, (_, href) => hold(linkHtml(href, '', false)));
  s = holdAddresses(s, hold);
  s = emphasis(escapeHtml(s));
  return s.replace(HELD, (whole, i) => held[Number(i)] ?? whole);
}

/**
 * Bare web addresses, as links.
 * @param {string} s
 * @param {(html: string) => string} hold
 */
function holdAddresses(s, hold) {
  let out = '';
  let at = 0;
  for (const link of findWebLinks(s)) {
    out += s.slice(at, link.start) + hold(linkHtml(link.text, '', false));
    at = link.end;
  }
  return out + s.slice(at);
}

/** Bold, italic and strikethrough on escaped text. @param {string} s */
const emphasis = s => s
  .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>')
  .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
  .replace(/(^|[^*\w])\*(?=[^\s*])([^*]*?[^\s*])\*(?!\*)/g, '$1<em>$2</em>')
  .replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>')
  .replace(/(^|[\s(])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\b/g, '$1<span class="md-mention">@$2</span>');

/**
 * A link: its words (or its address) marked up; an image's says what it is. An address that isn't on the web (a
 * relative one, "javascript:") leaves the words alone.
 * @param {string} href
 * @param {string} words
 * @param {boolean} image
 */
function linkHtml(href, words, image) {
  const shown = image ? `Image${words ? `: ${words}` : ''}` : words;
  const inner = shown ? emphasis(escapeHtml(shown)) : escapeHtml(href);
  if (!SAFE_ADDRESS.test(href)) return inner;
  return `<a class="md-link${image ? ' md-image' : ''}" ${LINK_HREF}="${escapeHtml(href)}" title="${escapeHtml(href)}">${inner}</a>`;
}
