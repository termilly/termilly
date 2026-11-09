// @ts-check
// What Claude did after each prompt, for Prompt history (js/myprompts.js): its replies and the tools it used, as the
// host read them from the session's transcript (Features/TranscriptSteps.cs). Here: which prompt each belongs to,
// which reply was the last of its prompt, where each is in the terminal's output (Claude Code starts each with "● "),
// and how a row shows.

import { AGENT_STEP } from './constants.js';
import { escapeHtml, highlight, ICONS } from './ui.js';

/**
 * A step as the host sends it (C#'s AgentStep).
 * @typedef {{ kind: string, text: string, at: string, tool?: string | null, failed?: boolean }} AgentStep
 */
/**
 * A step with where it is: its line in the output (-1: no longer there), the prompt it followed (its index, -1: none
 * listed), and whether it's that prompt's last reply.
 * @typedef {{ step: AgentStep, line: number, turn: number, last: boolean }} PlacedStep
 */

/** How Claude Code starts a reply or a tool's line: a dot (● on Windows and Linux, ⏺ on macOS), then the text. */
const STEP_LINE = /^[●⏺]\s(.*)$/;
/** Its next lines are indented: by two spaces, a wrapped tool line by more. */
const MORE_LINE = /^ {2,}\S/;
/** How many of a step's lines in the output are read to match it. */
const MATCH_LINES = 3;
/** A reply is matched by this many characters of its start; a tool by this many of what it was used on. */
const REPLY_CHARS = 50;
const TOOL_CHARS = 60;
/** A shown line shorter than this can't stand for a reply that's longer (too many would match). */
const MIN_PARTIAL = 16;
/** What a row no longer in the output says: a click reads it in the list instead (js/myprompts.js). */
export const GONE_TITLE = 'No longer in this terminal’s output. Click to read it.';
/** A reply's row shows this many lines; a long one goes on in the terminal. */
const ROW_LINES = 8;
/**
 * A reply whose first line the output no longer has (Claude Code draws a long answer over its own start) is found by
 * a later piece of it this long, tried every PIECE_STEP characters, at most PIECE_TRIES times.
 */
const PIECE_CHARS = 40;
const PIECE_STEP = 30;
const PIECE_TRIES = 20;

/** @param {string} s */
const norm = s => s.replace(/\s+/g, ' ').trim().toLowerCase();
/** The terminal shows Markdown without its marks: a reply's text is compared without them too. @param {string} s */
const plain = s => norm(s.replace(/[*`_]|^#+\s/gm, ''));

/**
 * The replies and tool lines the output shows, top to bottom: each one's line and its text (its first few lines).
 * @param {string[]} lines
 */
export function shownSteps(lines) {
  /** @type {{ line: number, text: string }[]} */
  const shown = [];
  for (let i = 0; i < lines.length; i++) {
    const m = STEP_LINE.exec(lines[i]);
    if (!m || !m[1].trim()) continue;
    let text = m[1];
    for (let j = i + 1; j < Math.min(lines.length, i + MATCH_LINES) && MORE_LINE.test(lines[j]); j++) text += ` ${lines[j]}`;
    shown.push({ line: i, text: plain(text) });
  }
  return shown;
}

/**
 * A tool's text as compared: without spaces, so a line Claude Code wrapped in the middle of a word still matches,
 * and without the marks a shown line loses (plain).
 * @param {string} s
 */
const bare = s => plain(s).replace(/\s/g, '');

/**
 * What a tool's line in the output would hold: what it was used on, a path by its file name (Claude Code shortens
 * paths), cut to its start.
 * @param {AgentStep} step
 */
function toolNeedle(step) {
  const subject = step.text.trim();
  const file = /[\\/]/.test(subject) && !/\s/.test(subject) ? subject.split(/[\\/]/).pop() ?? subject : subject;
  return bare(file).slice(0, TOOL_CHARS);
}

/**
 * Whether a shown line is this step.
 * @param {AgentStep} step
 * @param {string} shown
 */
function matches(step, shown) {
  if (step.kind === AGENT_STEP.tool) {
    const needle = toolNeedle(step);
    return !!needle && shown.replace(/\s/g, '').includes(needle);
  }
  const want = plain(step.text).slice(0, REPLY_CHARS);
  return !!want && (shown.startsWith(want) || (shown.length >= MIN_PARTIAL && want.startsWith(shown)));
}

/**
 * Places the steps: which prompt each followed (by time), which reply was the last of its prompt, and where each is
 * in the output. Replies first (their text is their own), newest first from the bottom up so a repeated line (a
 * conversation Claude Code drew again after a resize) finds its own place. Then each tool, only between the replies
 * placed around it: Claude Code folds many tool calls into one line ("Searched for 2 patterns, read 1 file") and
 * commands often start alike, so a tool searched freely took another's line, and every step above it was lost.
 * @param {AgentStep[]} steps oldest first
 * @param {{ at: string | null }[]} prompts oldest first
 * @param {{ line: number, text: string }[]} shown
 * @param {string[]} [lines] the output, for the replies whose first line it no longer has
 * @returns {PlacedStep[]}
 */
export function placeSteps(steps, prompts, shown, lines = []) {
  const times = prompts.map(p => (p.at ? Date.parse(p.at) : NaN));
  const placed = steps.map(step => {
    const at = Date.parse(step.at);
    let turn = -1;
    times.forEach((t, i) => { if (t <= at) turn = i; });
    return { step, line: -1, turn, last: false };
  });
  /** @type {Set<number>} */
  const seenTurns = new Set();
  /** Each placed step's index in shown, by its index in placed. @type {number[]} */
  const at = placed.map(() => -1);
  let below = shown.length;
  for (let i = placed.length - 1; i >= 0; i--) {
    const p = placed[i];
    if (p.step.kind !== AGENT_STEP.reply) continue;
    if (!seenTurns.has(p.turn)) {
      p.last = true;
      seenTurns.add(p.turn);
    }
    const s = findAbove(p.step, shown, below, -1);
    if (s >= 0) [at[i], below] = [s, s];
  }
  /** A reply found only by a later piece of it: its line in the output, by its index in placed. @type {Map<number, number>} */
  const byPiece = new Map();
  for (let i = 0; i < placed.length; i++) {
    if (placed[i].step.kind !== AGENT_STEP.reply || at[i] >= 0) continue;
    const before = nearestReply(placed, at, i, -1);
    const after = nearestReply(placed, at, i, 1);
    const from = Math.max(before >= 0 ? shown[before].line + 1 : 0, ...[...byPiece.values()].map(l => l + 1));
    const line = findPiece(placed[i].step, lines, from, after >= 0 ? shown[after].line : lines.length);
    if (line >= 0) byPiece.set(i, line);
  }
  // Each tool between the nearest placed replies before and after it, newest first, each above the one after it.
  let after = shown.length;
  for (let i = placed.length - 1; i >= 0; i--) {
    if (placed[i].step.kind === AGENT_STEP.reply) {
      if (at[i] >= 0) after = at[i];
      continue;
    }
    let before = -1;
    for (let j = i - 1; j >= 0 && before < 0; j--) if (placed[j].step.kind === AGENT_STEP.reply && at[j] >= 0) before = at[j];
    const s = findAbove(placed[i].step, shown, after, before);
    if (s >= 0) [at[i], after] = [s, s];
  }
  placed.forEach((p, i) => { if (at[i] >= 0) p.line = shown[at[i]].line; else p.line = byPiece.get(i) ?? -1; });
  return placed;
}

/**
 * The index in shown of the nearest reply placed before (dir -1) or after (dir 1) the step at i, or -1.
 * @param {PlacedStep[]} placed
 * @param {number[]} at
 * @param {number} i
 * @param {number} dir
 */
function nearestReply(placed, at, i, dir) {
  for (let j = i + dir; j >= 0 && j < placed.length; j += dir) if (placed[j].step.kind === AGENT_STEP.reply && at[j] >= 0) return at[j];
  return -1;
}

/**
 * The first line, from `from` up to `to`, where a later piece of a reply shows, or -1. Compared without spaces
 * (Claude Code wraps the text, sometimes inside a word) and without Markdown's marks.
 * @param {AgentStep} step
 * @param {string[]} lines
 * @param {number} from
 * @param {number} to
 */
function findPiece(step, lines, from, to) {
  const want = bare(step.text);
  if (want.length < PIECE_CHARS || from >= to) return -1;
  let text = '';
  /** Where each line starts in text. @type {number[]} */
  const starts = [];
  for (let l = from; l < to; l++) {
    starts.push(text.length);
    text += bare(lines[l] ?? '');
  }
  for (let k = 0, off = 0; k < PIECE_TRIES && off + PIECE_CHARS <= want.length; k++, off += PIECE_STEP) {
    const found = text.indexOf(want.slice(off, off + PIECE_CHARS));
    if (found < 0) continue;
    let l = starts.length - 1;
    while (starts[l] > found) l--;
    return from + l;
  }
  return -1;
}

/**
 * The nearest shown line above index `below` (and below `floor`) that is this step, or -1.
 * @param {AgentStep} step
 * @param {{ text: string }[]} shown
 * @param {number} below
 * @param {number} floor
 */
function findAbove(step, shown, below, floor) {
  for (let s = below - 1; s > floor; s--) if (matches(step, shown[s].text)) return s;
  return -1;
}

/**
 * One step's row: a reply (its first lines), or a tool and what it was used on, green or red.
 * @param {PlacedStep} p
 * @param {number} k its index in the list of steps
 * @param {string} filter text to mark in it
 * @param {{ nested?: boolean }} [how] nested: shown under its prompt
 */
export function stepRowHtml(p, k, filter, { nested = false } = {}) {
  const { step, line, last } = p;
  const gone = line < 0;
  const text = (/** @type {string} */ t) => (filter ? highlight(t, filter) : escapeHtml(t));
  const tool = step.kind === AGENT_STEP.tool;
  const body = tool
    ? `<span class="step-tool">${escapeHtml(step.tool ?? '')}</span> ${text(step.text)}`
    : text(step.text.split('\n').slice(0, ROW_LINES).join('\n'));
  const when = new Date(step.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `<div class="step-row ${tool ? 'step-is-tool' : 'step-is-reply'}${last ? ' last' : ''}${step.failed ? ' failed' : ''}${gone ? ' gone' : ''}${nested ? ' nested' : ''}"
      role="option" tabindex="-1" data-s="${k}" title="${gone ? GONE_TITLE : 'Show it in the terminal'}">
      <span class="prompt-time">${nested ? '' : escapeHtml(when)}</span>
      <span class="step-mark"></span>
      <span class="step-text">${last && !nested ? '<span class="step-last">Last reply</span>' : ''}${body}</span>
      <button class="prompt-copy" data-copy-step="${k}" title="Copy" aria-label="Copy">${ICONS.copy}</button>
    </div>`;
}
