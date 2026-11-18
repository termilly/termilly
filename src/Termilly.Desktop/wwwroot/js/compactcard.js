// @ts-check
// The question an agent waits on, read off its screen for the compact view's card (js/compact.js): Claude Code's
// permission prompts, its questions (AskUserQuestion) and plan approval, and Codex's approvals all draw a question
// and numbered choices, and a choice's number picks it. The card shows the question, what it's about (the command,
// the plan) and a button per choice that presses that number, and Preview shows all the prompt says. Pure: screen
// lines in, a menu out; a menu in, HTML out.

import { escapeHtml } from './ui.js';

/**
 * A choice: "  2. Yes, and don't ask again", with the pointer on the one picked now ("> 1. Yes", "› 1. Yes"), or an
 * arrow where a long list scrolls ("↓ 2. Spaces").
 */
const CHOICE = /^\s*(?:[>❯›↑↓]\s*)*(\d)\.\s+(.+?)\s*$/;
/** The pointer on the choice picked now. */
const POINTER = /^\s*(?:[↑↓]\s*)?[>❯›]/;
/** A rule across the screen: the top of the agent's prompt area. */
const RULE = /^[─━]{8,}$/;
/** A dashed rule inside the prompt (around a command): left out of the card. */
const DASHES = /^[╌┄┈-]{8,}$/;
/** Lines that only say how to use the menu, after its choices. */
const HINT = /^(?:Esc to |Press enter|Enter to |\(?esc\)?|Tab to )/i;
/**
 * Box sides some prompts are drawn in (Claude Code puts one before each line of a command), indented or not. Not "|":
 * a command's line can end in one.
 */
const BOX = /^\s*[│┃]\s?|\s?[│┃]$/g;
/** This many blank lines in a row end the prompt's area. */
const GAP = 2;
/** At most this many lines say what the question is about (a long plan is cut; the terminal has it all). */
const MAX_CONTEXT = 12;
/** A menu's key is a 32-bit FNV-1a hash of what it says (and its length), written in base 36. */
const HASH_SEED = 0x811c9dc5;
const HASH_PRIME = 0x01000193;
const HASH_BASE = 36;
/** Indented at least this much under a choice, a line belongs to it (a description, or its wrapped words). */
const UNDER_CHOICE = 3;

/**
 * @typedef {{ key: string, label: string, detail: string, picked: boolean }} MenuChoice
 * @typedef {{ title: string, context: string[], choices: MenuChoice[], whole?: string | null, start?: number, prompt?: string[], cut?: boolean, asked?: number }} Menu
 *   whole: everything the prompt says, from where it starts (not cut for showing), which tells it from another; null
 *   when its start is off the lines read (keyedByWhatShows gives it one); start: the row of the screen the prompt
 *   starts on, -1 when that's off the screen; prompt: its lines above the choices as drawn, uncut, for its preview;
 *   cut: its start is lost, so prompt has only what shows; asked: which of the agent's questions it is, when known
 */

/** What starts a prompt above its choices: Claude Code's rule, Codex's gap of blank lines, or either (a rule first). */
export const PROMPT_START = Object.freeze({ either: 'either', rule: 'rule', gap: 'gap' });

/**
 * A line as text, without the box it may be drawn in.
 * @param {string} line
 */
const clean = line => line.replace(BOX, '').trimEnd();

/**
 * The menu at the bottom of a screen, or null when there's none: the last run of choices numbered from 1 with the
 * agent's pointer on one of them, what they say (a choice's own wrapped words and description under it), and the
 * question above them. The lines may start above the screen (the terminal's scrollback), so a prompt taller than
 * the screen is read whole; its choices are looked for on the screen only. Up there, the agent's own kind of start
 * is looked for (an earlier rule in the conversation isn't a Codex prompt's start).
 * @param {string[]} lines the lines, top to bottom: the screen's, or some above it and then the screen's
 * @param {{ screenTop?: number, startsAt?: string }} [where] screenTop: the first line that is on the screen;
 *   startsAt: a PROMPT_START
 * @returns {Menu | null}
 */
export function readMenu(lines, { screenTop = 0, startsAt = PROMPT_START.either } = {}) {
  const rows = lines.map(clean);
  const first = lastFirstChoice(rows);
  if (first < screenTop) return null;
  const choices = choicesFrom(rows, first);
  // A menu the agent waits on has its pointer on one choice; a numbered list in its words has none.
  if (choices.length < 2 || !choices.some(c => c.picked)) return null;
  const { title, context } = questionAbove(rows, first);
  const start = promptStart(rows, first, startsAt);
  const whole = start < 0 ? null : JSON.stringify([rows.slice(start, first).map(r => r.trim()), choices.map(c => [c.key, c.label, c.detail])]);
  return { title, context, choices, whole, start: start < screenTop ? -1 : start - screenTop, prompt: dedent(rows.slice(Math.max(start, 0), first)) };
}

/**
 * Lines without the blank ones at either end, and without the indent they all share.
 * @param {string[]} lines
 */
function dedent(lines) {
  const from = lines.findIndex(line => line.trim());
  if (from < 0) return [];
  const kept = lines.slice(from, lines.findLastIndex(line => line.trim()) + 1);
  const indent = Math.min(...kept.filter(line => line.trim()).map(line => line.length - line.trimStart().length));
  return kept.map(line => line.slice(indent));
}

/**
 * A menu whose start is off the lines read, keyed by what shows of it and by what the agent said it asks about (its
 * hook's tool and target), so a prompt taller than the screen still gets its buttons; which question it is (asked)
 * keeps a card left over from an earlier one off the next one that looks the same.
 * @param {Menu} menu
 * @param {Array<string | null | undefined>} about
 * @returns {Menu}
 */
export function keyedByWhatShows(menu, about) {
  if (menu.whole !== null) return menu;
  return { ...menu, cut: true, whole: JSON.stringify([about, menu.prompt ?? menu.context, menu.choices.map(c => [c.key, c.label, c.detail])]) };
}

/** The preview's first line for a prompt whose start is lost. */
const CUT_NOTE = '(The start of this prompt is no longer in the terminal.)';

/**
 * All the menu says, for its preview: the prompt as drawn (the command, the diff), else its question and what it's
 * about (a plan, from its file).
 * @param {Menu} menu
 */
export function previewLines(menu) {
  const lines = menu.prompt?.length ? menu.prompt : [menu.title, ...(menu.context.length ? ['', ...menu.context] : [])];
  return menu.cut ? [CUT_NOTE, '', ...lines] : lines;
}

/**
 * Where the prompt above a menu starts: the line after its rule (Claude Code draws one; blank lines inside the
 * prompt, in a command, don't end it), or else after its gap of blank lines (Codex draws no rule), or only the kind
 * asked for; -1 when there's none in the lines.
 * @param {string[]} rows
 * @param {number} first
 * @param {string} startsAt a PROMPT_START
 */
function promptStart(rows, first, startsAt) {
  for (let i = first - 1; i >= 0 && startsAt !== PROMPT_START.gap; i--) {
    if (RULE.test(rows[i].trim())) return i + 1;
  }
  if (startsAt === PROMPT_START.rule) return -1;
  let blanks = 0;
  for (let i = first - 1; i >= 0; i--) {
    blanks = rows[i].trim() ? 0 : blanks + 1;
    if (blanks === GAP) return i + 1;
  }
  return -1;
}

/**
 * Where the last "1." that starts a menu is.
 * @param {string[]} rows
 */
function lastFirstChoice(rows) {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (CHOICE.exec(rows[i])?.[1] === '1') return i;
  }
  return -1;
}

/**
 * The choices from the first one down: each with a higher number (a long list scrolled out of sight leaves a gap),
 * and under each the lines indented beneath it. Blank lines and rules between choices are passed over (Claude Code
 * draws "Chat about this" under a rule); the menu ends at a hint, or at anything that isn't a choice after them.
 * @param {string[]} rows
 * @param {number} first
 * @returns {MenuChoice[]}
 */
function choicesFrom(rows, first) {
  /** @type {MenuChoice[]} */
  const choices = [];
  for (let i = first; i < rows.length; i++) {
    const row = rows[i];
    const text = row.trim();
    const found = CHOICE.exec(row);
    const last = choices[choices.length - 1];
    if (found && (!last || Number(found[1]) > Number(last.key))) {
      choices.push({ key: found[1], label: found[2], detail: '', picked: POINTER.test(row) });
    } else if (!text || RULE.test(text)) {
      if (!nextIsChoice(rows, i + 1, last)) break;
    } else if (HINT.test(text) || !last || row.length - row.trimStart().length < UNDER_CHOICE) {
      break;
    } else {
      last.detail = last.detail ? `${last.detail} ${text}` : text;
    }
  }
  return choices;
}

/**
 * Whether the next line that isn't blank or a rule is a choice after this one.
 * @param {string[]} rows
 * @param {number} from
 * @param {MenuChoice | undefined} last
 */
function nextIsChoice(rows, from, last) {
  for (let i = from; i < rows.length; i++) {
    const text = rows[i].trim();
    if (!text || RULE.test(text)) continue;
    const found = CHOICE.exec(rows[i]);
    return !!found && !!last && Number(found[1]) > Number(last.key);
  }
  return false;
}

/**
 * The question above the choices, and what it's about: the prompt's paragraphs up to the rule or gap that starts
 * it. The question is the first that asks one ("Do you want to proceed?", "Would you like to run the following
 * command?"), else the one right above the choices; the rest, line by line, is what it's about.
 * @param {string[]} rows
 * @param {number} first
 */
function questionAbove(rows, first) {
  const near = paragraphsAbove(rows, first);
  // Nothing between the choices and the prompt's start (a prompt drawn in a way this doesn't know): the nearest
  // paragraph above that start, so a card never shows choices with nothing to say what they answer.
  const all = near.all.length ? near.all : paragraphsAbove(rows, skipBlank(rows, near.stop)).all.slice(-1);
  const question = all.find(p => p[p.length - 1].endsWith('?')) ?? all[all.length - 1] ?? [];
  return { title: question.join(' '), context: all.filter(p => p !== question).flat().slice(-MAX_CONTEXT) };
}

/**
 * The paragraphs above a row, up to the prompt's start: the rule (Claude Code) or gap of blank lines (Codex) that
 * starts it, where what's above is the conversation; and the row it stopped at.
 * @param {string[]} rows
 * @param {number} first
 */
function paragraphsAbove(rows, first) {
  /** @type {string[][]} */
  const paragraphs = [[]];
  let blanks = 0;
  let count = 0;
  let i = first - 1;
  for (; i >= 0 && count < MAX_CONTEXT + 1; i--) {
    const row = rows[i].trim();
    blanks = row ? 0 : blanks + 1;
    if (RULE.test(row) || blanks === GAP) break;
    // A blank line or a dashed rule (around a command) ends a paragraph.
    if (!row || DASHES.test(row)) {
      if (paragraphs[0].length) paragraphs.unshift([]);
    } else {
      paragraphs[0].unshift(row);
      count++;
    }
  }
  return { all: paragraphs.filter(p => p.length), stop: Math.max(0, i) };
}

/**
 * The row just below the first line above `from` with words in it (blank lines and rules skipped), for reading on.
 * @param {string[]} rows
 * @param {number} from
 */
function skipBlank(rows, from) {
  let i = from;
  while (i > 0 && (!rows[i - 1].trim() || RULE.test(rows[i - 1].trim()))) i--;
  return i;
}

/**
 * One of Claude Code's questions (AskUserQuestion) as a menu: its choices are numbered from 1 in the order it asked
 * them, as its screen numbers them.
 * @param {import('./protocol.js').CompactQuestion} question
 * @returns {Menu}
 */
export function questionMenu(question) {
  return {
    title: question.question,
    context: [],
    choices: question.options.map((o, i) => ({ key: String(i + 1), label: o.label, detail: o.description ?? '', picked: false })),
  };
}

/**
 * The card for a question: the question, what it's about, a button per choice that carries its key and words (to
 * check them again before pressing it), Preview for all the prompt says, and the terminal for what the card can't show.
 * @param {Menu | null} menu
 * @param {string} name the agent's short name, escaped
 * @param {{ open: string, preview: string }} classes the classes of the buttons that show the terminal and the preview
 */
export function cardHtml(menu, name, classes) {
  if (menu) return menuCardHtml(menu, name, classes);
  return `<div class="cv-card"><div class="cv-question">${name} needs you</div><div class="cv-choices"><button class="${classes.open}">Open terminal</button></div></div>`;
}

/**
 * A choice's button: its number and words, and what it says under them.
 * @param {MenuChoice} choice
 */
export const choiceHtml = choice => `<button class="cv-choice${choice.picked ? ' picked' : ''}" data-choice="${choice.key}" title="${escapeHtml(choice.detail || choice.label)}">`
  + `<kbd>${choice.key}</kbd>${escapeHtml(choice.label)}${choice.detail ? `<small>${escapeHtml(choice.detail)}</small>` : ''}</button>`;

/**
 * What tells one menu from another: all its prompt says and its choices (not which one the pointer is on, which the
 * user moves with the keys); empty for one whose start is off the screen. A card's buttons press only while the
 * screen shows the menu with its key.
 * @param {Menu} menu
 */
export function menuKey(menu) {
  if (menu.whole === null) return '';
  const said = menu.whole ?? JSON.stringify([menu.title, menu.context, menu.choices.map(c => [c.key, c.label, c.detail])]);
  // Which question it is, where that's known: the next one may say the same, and a card left over mustn't answer it.
  const text = menu.asked === undefined ? said : `${menu.asked}#${said}`;
  let hash = HASH_SEED;
  for (let i = 0; i < text.length; i++) hash = (Math.imul(hash, HASH_PRIME) ^ text.charCodeAt(i)) >>> 0;
  return `${hash.toString(HASH_BASE)}:${text.length}`;
}

/**
 * @param {Menu} menu
 * @param {string} name the agent's short name, escaped
 * @param {{ open: string, preview: string }} classes
 */
function menuCardHtml(menu, name, classes) {
  // A plan's blank lines keep its paragraphs apart.
  const context = menu.context.map(line => (line ? `<div>${escapeHtml(line)}</div>` : '<br>')).join('');
  // A menu that can't be told from another gets no buttons, nor a preview (it opens only on a card it can check):
  // the terminal answers it.
  const key = menuKey(menu);
  const choices = key ? menu.choices.map(choiceHtml).join('') : '';
  const preview = key ? `<button class="${classes.preview}" title="All the prompt says">Preview</button>` : '';
  const tools = `${preview}<button class="${classes.open}">Open terminal</button>`;
  return `<div class="cv-card" data-menu="${key}"><div class="cv-question">${menu.title ? escapeHtml(menu.title) : `${name} asks`}</div>`
    + `${context ? `<div class="cv-context">${context}</div>` : ''}<div class="cv-choices">${choices}${tools}</div></div>`;
}
