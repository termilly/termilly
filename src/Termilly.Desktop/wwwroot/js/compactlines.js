// @ts-check
// The compact view's lines as HTML (js/compact.js shows them): the user's prompt at the top of each turn, the agent's
// words, its thinking as one dim line, a line per tool with what came of it, and a footer when the turn ends with how
// long it took and what it changed. Reads in a row fold into one line ("+2 files"). Pure: lines in, HTML out.

import { escapeHtml } from './ui.js';
import { COMPACT_KIND, COMPACT_VERB } from './constants.js';

/** @typedef {import('./protocol.js').Host_compactLines['lines'][number]} CompactLine */

/** A patch's counts as the host writes them: "+9 -2", "+4", "-3". */
const CHANGES = /^(?:\+(\d+))?\s*(?:-(\d+))?$/;
/** A tool line's state, its class. */
const STATE = Object.freeze({ running: 'running', failed: 'failed', worked: 'worked' });
/** A count at the start of a result: "412 lines". */
const COUNT = /^(\d+)\s+(\S+)$/;

/**
 * The lines folded for showing: Reads in a row (finished, not failed) become one, with how many more files it covers.
 * @param {CompactLine[]} lines
 * @returns {(CompactLine & { more?: number })[]}
 */
export function foldLines(lines) {
  /** @type {(CompactLine & { more?: number })[]} */
  const out = [];
  for (const line of lines) {
    const last = out[out.length - 1];
    if (isPlainRead(line) && last && isPlainRead(last)) {
      out[out.length - 1] = { ...last, more: (last.more ?? 0) + 1, detail: sumCounts(last.detail, line.detail) };
    } else {
      out.push(line);
    }
  }
  return out;
}

/** @param {CompactLine} line */
const isPlainRead = line => line.kind === COMPACT_KIND.tool && line.verb === COMPACT_VERB.read && line.done && !line.failed;

/**
 * Two results that count the same thing ("120 lines", "40 lines") summed; the first one when they don't.
 * @param {string | null | undefined} a
 * @param {string | null | undefined} b
 */
function sumCounts(a, b) {
  const x = COUNT.exec(a ?? '');
  const y = COUNT.exec(b ?? '');
  if (!x || !y) return a;
  return `${Number(x[1]) + Number(y[1])} ${y[2]}`;
}

/**
 * What a turn changed, from its edit lines: how many files and the lines added and removed.
 * @param {CompactLine[]} turn
 * @returns {{ files: number, added: number, removed: number }}
 */
export function turnChanges(turn) {
  const files = new Set();
  let added = 0;
  let removed = 0;
  for (const line of turn) {
    if (line.kind !== COMPACT_KIND.tool || line.failed || (line.verb !== COMPACT_VERB.edit && line.verb !== COMPACT_VERB.write)) continue;
    files.add(line.text);
    const counts = CHANGES.exec(line.detail ?? '');
    if (counts) {
      added += Number(counts[1] ?? 0);
      removed += Number(counts[2] ?? 0);
    }
    const created = /(\d+) lines?$/.exec(line.detail ?? '');
    if (line.verb === COMPACT_VERB.write && created) added += Number(created[1]);
  }
  return { files: files.size, added, removed };
}

/**
 * A reply's words, escaped, with **bold** and `code` drawn as such (the rest of Markdown is left as written).
 * @param {string} text
 */
export function wordsHtml(text) {
  return escapeHtml(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
}

/**
 * A result, with a patch's counts coloured.
 * @param {string | null | undefined} detail
 */
function detailHtml(detail) {
  if (!detail) return '';
  const counts = CHANGES.exec(detail);
  if (counts && (counts[1] || counts[2])) {
    return [counts[1] && `<span class="cv-add">+${counts[1]}</span>`, counts[2] && `<span class="cv-del">-${counts[2]}</span>`].filter(Boolean).join(' ');
  }
  return escapeHtml(detail);
}

/**
 * A tool's line: its state (running, failed), verb, what it worked on and what came of it.
 * @param {CompactLine & { more?: number }} line
 */
function toolHtml(line) {
  const state = !line.done ? STATE.running : line.failed ? STATE.failed : STATE.worked;
  const more = line.more ? ` <i>+${line.more} file${line.more === 1 ? '' : 's'}</i>` : '';
  const detail = line.done ? detailHtml(line.detail) : STATE.running;
  return `<div class="cv-tool ${state}" title="${escapeHtml(line.text)}"><span class="cv-dot"></span><span class="cv-verb">${escapeHtml(line.verb ?? '')}</span>`
    + `<span class="cv-subject">${escapeHtml(line.text)}${more}</span><span class="cv-detail">${detail}</span></div>`;
}

/**
 * The footer of a turn that ended: how long it took and what it changed.
 * @param {CompactLine} end
 * @param {CompactLine[]} turn the turn's lines before it
 */
function endHtml(end, turn) {
  const { files, added, removed } = turnChanges(turn);
  const parts = [end.detail ? escapeHtml(end.detail) : ''];
  if (files) parts.push(`${files} file${files === 1 ? '' : 's'} ${detailHtml(`+${added} -${removed}`)}`);
  return `<div class="cv-end">${parts.filter(Boolean).join('<span class="cv-sep">·</span>')}</div>`;
}

/**
 * One line as HTML.
 * @param {CompactLine & { more?: number }} line
 * @param {CompactLine[]} turn the lines of its turn so far (a footer sums them up)
 */
function lineHtml(line, turn) {
  switch (line.kind) {
    case COMPACT_KIND.prompt: return `<div class="cv-prompt">${escapeHtml(line.text)}</div>`;
    case COMPACT_KIND.reply: return `<div class="cv-reply">${wordsHtml(line.text)}</div>`;
    case COMPACT_KIND.thinking: return `<div class="cv-thinking" title="${escapeHtml(line.text)}">${escapeHtml(line.text.split('\n')[0])}</div>`;
    case COMPACT_KIND.tool: return toolHtml(line);
    case COMPACT_KIND.end: return endHtml(line, turn);
    case COMPACT_KIND.interrupted: return '<div class="cv-note">Stopped</div>';
    default: return '';
  }
}

/**
 * Every line as HTML, oldest first.
 * @param {CompactLine[]} lines
 */
export function linesHtml(lines) {
  /** @type {CompactLine[]} */
  let turn = [];
  const html = [];
  for (const line of foldLines(lines)) {
    if (line.kind === COMPACT_KIND.prompt) turn = [];
    html.push(lineHtml(line, turn));
    turn.push(line);
  }
  return html.join('');
}
