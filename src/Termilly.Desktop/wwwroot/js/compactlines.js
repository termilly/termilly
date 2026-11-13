// @ts-check
// The compact view's lines as HTML (js/compact.js shows them): the user's prompt at the top of each turn, the agent's
// words, its thinking as one dim line, a line per tool with what came of it, and a footer when the turn ends with how
// long it took and what it changed. Reads in a row fold into one line ("+2 files"). The minimal view keeps only the
// prompts and the final answers. Pure: lines in, HTML out.

import { escapeHtml } from './ui.js';
import { findWebLinks } from './webaddress.js';
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
 * A link in a line's text, by character offset: a web address, or a path that leads somewhere (js/compactlinks.js
 * finds those), with its tooltip.
 * @typedef {{ start: number, end: number, text: string, title?: string, web?: boolean }} TextLink
 */
/**
 * What the lines' links are: the paths found in a line so far, and how a web address is opened.
 * @typedef {{ paths: (line: CompactLine) => TextLink[], plainClick: boolean }} LineLinks
 */

export const LINK_CLASS = 'cv-link';
/** A link's attribute when it's a web address. */
export const WEB_ATTR = 'data-web';
/** Stands in a text for its link while the rest is escaped and marked up: a character no text holds. */
const HOLDER = '';
const HOLDERS = new RegExp(`${HOLDER}(\\d+)${HOLDER}`, 'g');
/** No links: the paths aren't known, and web addresses open on Ctrl+click. */
const NO_LINKS = Object.freeze({ paths: () => [], plainClick: false });

/**
 * A text's links: its web addresses, and the paths that don't overlap one, in the text's order.
 * @param {string} text
 * @param {TextLink[]} paths
 * @returns {TextLink[]}
 */
function linksIn(text, paths) {
  const web = findWebLinks(text).map(w => ({ ...w, web: true }));
  return [...web, ...paths.filter(p => !web.some(w => p.start < w.end && p.end > w.start))].sort((a, b) => a.start - b.start);
}

/**
 * A link as HTML: its text, what it opens, and whether a plain click opens it.
 * @param {string} shown
 * @param {TextLink} link
 * @param {boolean} plainClick
 */
function linkHtml(shown, link, plainClick) {
  const plain = link.web && plainClick;
  const title = link.title ?? `${link.text}\n${plain ? 'Click' : 'Ctrl+click'} to open in your browser`;
  return `<span class="${LINK_CLASS}" data-link="${escapeHtml(link.text)}"${link.web ? ` ${WEB_ATTR}` : ''}${plain ? ' data-plain' : ''}`
    + ` title="${escapeHtml(title)}">${escapeHtml(shown)}</span>`;
}

/**
 * A text as HTML with its links marked; a reply's with **bold** and `code` drawn as such too (the rest of Markdown is
 * left as written).
 * @param {string} text
 * @param {TextLink[]} paths
 * @param {{ words?: boolean, plainClick?: boolean }} [how]
 */
export function linkedHtml(text, paths, how = {}) {
  const links = linksIn(text, paths);
  let held = '';
  let at = 0;
  links.forEach((l, i) => {
    held += `${text.slice(at, l.start)}${HOLDER}${i}${HOLDER}`;
    at = l.end;
  });
  let html = escapeHtml(held + text.slice(at));
  if (how.words) html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  return html.replace(HOLDERS, (whole, i) => {
    const l = links[Number(i)];
    return l ? linkHtml(text.slice(l.start, l.end), l, !!how.plainClick) : whole;
  });
}

/**
 * A reply's words, escaped, with **bold** and `code` drawn as such and its web addresses linked.
 * @param {string} text
 * @param {TextLink[]} [paths]
 * @param {boolean} [plainClick]
 */
export const wordsHtml = (text, paths = [], plainClick = false) => linkedHtml(text, paths, { words: true, plainClick });

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
 * @param {LineLinks} links
 */
function toolHtml(line, links) {
  const state = !line.done ? STATE.running : line.failed ? STATE.failed : STATE.worked;
  const more = line.more ? ` <i>+${line.more} file${line.more === 1 ? '' : 's'}</i>` : '';
  const detail = line.done ? detailHtml(line.detail) : STATE.running;
  const subject = linkedHtml(line.text, links.paths(line), { plainClick: links.plainClick });
  return `<div class="cv-tool ${state}" title="${escapeHtml(line.text)}"><span class="cv-dot"></span><span class="cv-verb">${escapeHtml(line.verb ?? '')}</span>`
    + `<span class="cv-subject">${subject}${more}</span><span class="cv-detail">${detail}</span></div>`;
}

/**
 * The footer of a turn that ended: how long it took and what it changed.
 * @param {CompactLine} end
 * @param {CompactLine[]} turn the turn's lines before it
 */
function endHtml(end, turn) {
  const { files, added, removed } = turnChanges(turn);
  const parts = [end.detail ? escapeHtml(end.detail) : ''];
  // Only the counts there are: "+11", not "+11 -0".
  const counts = [added && `+${added}`, removed && `-${removed}`].filter(Boolean).join(' ');
  if (files) parts.push(`${files} file${files === 1 ? '' : 's'} ${detailHtml(counts)}`);
  return `<div class="cv-end">${parts.filter(Boolean).join('<span class="cv-sep">·</span>')}</div>`;
}

/**
 * One line as HTML.
 * @param {CompactLine & { more?: number }} line
 * @param {CompactLine[]} turn the lines of its turn so far (a footer sums them up)
 * @param {LineLinks} links
 */
function lineHtml(line, turn, links) {
  switch (line.kind) {
    case COMPACT_KIND.prompt: return `<div class="cv-prompt">${linkedHtml(line.text, links.paths(line), { plainClick: links.plainClick })}</div>`;
    case COMPACT_KIND.reply: return `<div class="cv-reply">${wordsHtml(line.text, links.paths(line), links.plainClick)}</div>`;
    case COMPACT_KIND.thinking: return `<div class="cv-thinking" title="${escapeHtml(line.text)}">${escapeHtml(line.text.split('\n')[0])}</div>`;
    case COMPACT_KIND.tool: return toolHtml(line, links);
    case COMPACT_KIND.end: return endHtml(line, turn);
    case COMPACT_KIND.interrupted: return '<div class="cv-note">Stopped</div>';
    default: return '';
  }
}

/**
 * The lines split into turns, each starting at a prompt (lines before the first prompt are a turn of their own).
 * @template {CompactLine} T
 * @param {T[]} lines
 * @returns {T[][]}
 */
function turnsOf(lines) {
  /** @type {T[][]} */
  const turns = [];
  for (const line of lines) {
    if (line.kind === COMPACT_KIND.prompt || !turns.length) turns.push([]);
    turns[turns.length - 1].push(line);
  }
  return turns;
}

/**
 * What the minimal view shows of a turn: its prompt and, once it's over, the agent's final answer and how it ended.
 * The answer is the replies after its last tool; when it ended on a tool (a last call after its summary), its last
 * reply. A turn is over when it ended or was stopped, when a newer one follows, or when the agent no longer works on it.
 * @template {CompactLine} T
 * @param {T[]} turn
 * @param {boolean} live whether the agent still works on this turn
 * @returns {T[]}
 */
function finalOf(turn, live) {
  const prompt = turn.filter(line => line.kind === COMPACT_KIND.prompt);
  const ending = turn.filter(line => line.kind === COMPACT_KIND.end || line.kind === COMPACT_KIND.interrupted);
  if (live && !ending.length) return prompt;
  const lastTool = turn.findLastIndex(line => line.kind === COMPACT_KIND.tool);
  let answer = turn.slice(lastTool + 1).filter(line => line.kind === COMPACT_KIND.reply);
  if (!answer.length) answer = turn.filter(line => line.kind === COMPACT_KIND.reply).slice(-1);
  return [...prompt, ...answer, ...ending];
}

/**
 * Every line as HTML, oldest first. The minimal view shows only the prompts and the agents' final answers (finalOf);
 * a turn's footer still sums up all it changed.
 * @param {CompactLine[]} lines
 * @param {LineLinks} [links] the paths found in them, and how web addresses open
 * @param {{ minimal?: boolean, live?: boolean }} [how] minimal: the minimal view; live: the agent works on the newest turn
 */
export function linesHtml(lines, links = NO_LINKS, how = {}) {
  const turns = turnsOf(foldLines(lines));
  /** @type {string[]} */
  const html = [];
  turns.forEach((turn, i) => {
    const shown = how.minimal ? new Set(finalOf(turn, !!how.live && i === turns.length - 1)) : null;
    /** @type {CompactLine[]} */
    const before = [];
    for (const line of turn) {
      if (!shown || shown.has(line)) html.push(lineHtml(line, before, links));
      before.push(line);
    }
  });
  return html.join('');
}
