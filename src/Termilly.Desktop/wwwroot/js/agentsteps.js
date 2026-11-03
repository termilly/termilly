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
/** Its next lines are indented by two spaces. */
const MORE_LINE = /^ {2}\S/;
/** How many of a step's lines in the output are read to match it. */
const MATCH_LINES = 3;
/** A reply is matched by this many characters of its start; a tool by this many of what it was used on. */
const REPLY_CHARS = 50;
const TOOL_CHARS = 30;
/** A shown line shorter than this can't stand for a reply that's longer (too many would match). */
const MIN_PARTIAL = 16;
/** A reply's row shows this many lines; a long one goes on in the terminal. */
const ROW_LINES = 8;

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
 * What a tool's line in the output would hold: what it was used on, a path by its file name (Claude Code shortens
 * paths), cut to its start.
 * @param {AgentStep} step
 */
function toolNeedle(step) {
  const subject = step.text.trim();
  const file = /[\\/]/.test(subject) && !/\s/.test(subject) ? subject.split(/[\\/]/).pop() ?? subject : subject;
  return norm(file).slice(0, TOOL_CHARS);
}

/**
 * Whether a shown line is this step.
 * @param {AgentStep} step
 * @param {string} shown
 */
function matches(step, shown) {
  if (step.kind === AGENT_STEP.tool) {
    const needle = toolNeedle(step);
    return !!needle && shown.includes(needle);
  }
  const want = plain(step.text).slice(0, REPLY_CHARS);
  return !!want && (shown.startsWith(want) || (shown.length >= MIN_PARTIAL && want.startsWith(shown)));
}

/**
 * Places the steps: which prompt each followed (by time), which reply was the last of its prompt, and where each is
 * in the output, matched newest first from the bottom up so a repeated line finds its own place.
 * @param {AgentStep[]} steps oldest first
 * @param {{ at: string | null }[]} prompts oldest first
 * @param {{ line: number, text: string }[]} shown
 * @returns {PlacedStep[]}
 */
export function placeSteps(steps, prompts, shown) {
  const times = prompts.map(p => (p.at ? Date.parse(p.at) : NaN));
  const placed = steps.map(step => {
    const at = Date.parse(step.at);
    let turn = -1;
    times.forEach((t, i) => { if (t <= at) turn = i; });
    return { step, line: -1, turn, last: false };
  });
  /** @type {Set<number>} */
  const seenTurns = new Set();
  let below = shown.length;
  for (let i = placed.length - 1; i >= 0; i--) {
    const p = placed[i];
    if (p.step.kind === AGENT_STEP.reply && !seenTurns.has(p.turn)) {
      p.last = true;
      seenTurns.add(p.turn);
    }
    for (let s = below - 1; s >= 0; s--) {
      if (matches(p.step, shown[s].text)) {
        p.line = shown[s].line;
        below = s;
        break;
      }
    }
  }
  return placed;
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
      role="option" tabindex="-1" data-s="${k}" title="${gone ? 'No longer in this terminal’s output' : 'Show it in the terminal'}">
      <span class="prompt-time">${nested ? '' : escapeHtml(when)}</span>
      <span class="step-mark"></span>
      <span class="step-text">${last && !nested ? '<span class="step-last">Last reply</span>' : ''}${body}</span>
      <button class="prompt-copy" data-copy-step="${k}" title="Copy" aria-label="Copy">${ICONS.copy}</button>
    </div>`;
}
