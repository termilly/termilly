// @ts-check
// What To do's lists are made of, with nothing of the page in it: text turned into tasks (typed, pasted, or a note's
// lines), and what a list counts. js/todo.js keeps the lists; js/todopanel.js shows them.

/** How many of a list's open tasks a hover shows. */
export const HOVER_TASKS = 5;
/** The longest tag: a `#` in a line of text isn't a tag past this. */
const MAX_TAG_LENGTH = 32;
const TAG_IN_TEXT = new RegExp(`(^|\\s)#([\\p{L}\\p{N}_-]{1,${MAX_TAG_LENGTH}})(?=\\s|$)`, 'gu');
/** A list mark at the start of a line: `- `, `* `, `1. `, each with an optional box. */
const LIST_MARK = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[( |x|X)\]\s+)?/;
const BOX_ONLY = /^\s*\[( |x|X)\]\s+/;
const HEADING = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/;
const LINE_BREAK = /\r?\n/;
const TICKED = 'xX';

/**
 * A heading as a tag: `## Deploy now` is `deploy-now`.
 * @param {string} heading
 */
export const tagOfHeading = heading => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, MAX_TAG_LENGTH);

/**
 * A line typed into the add field: its text, and the #tags in it taken out.
 * @param {string} line
 * @returns {{ text: string, tags: string[] }}
 */
export function parseTask(line) {
  /** @type {string[]} */
  const tags = [];
  const text = line.replace(TAG_IN_TEXT, (_, before, tag) => {
    const name = tag.toLowerCase();
    if (!tags.includes(name)) tags.push(name);
    return before;
  }).replace(/\s+/g, ' ').trim();
  return { text, tags };
}

/**
 * One line without its list mark, and whether its box was ticked.
 * @param {string} line
 */
function withoutMark(line) {
  const mark = line.match(LIST_MARK) ?? line.match(BOX_ONLY);
  return { text: mark ? line.slice(mark[0].length) : line, done: !!mark?.[1] && TICKED.includes(mark[1]), marked: !!mark };
}

/**
 * Lines pasted into the add field: a task for each, without list marks and boxes.
 * @param {string} text
 * @returns {{ text: string, tags: string[], done: boolean }[]}
 */
export function tasksFromLines(text) {
  return text.split(LINE_BREAK).map(withoutMark).map(line => ({ ...parseTask(line.text), done: line.done })).filter(task => task.text);
}

/**
 * A note's text as tasks. A list line is a task. Plain lines up to a blank line are one task: the first line, then the
 * rest as its details. A heading is no task: its tag goes on each task under it, until the next heading.
 * @param {string} text
 * @returns {{ text: string, tags: string[], done: boolean, details?: string }[]}
 */
export function tasksFromNote(text) {
  /** @type {{ text: string, tags: string[], done: boolean, details?: string }[]} */
  const tasks = [];
  /** @type {string | null} */
  let heading = null;
  let inParagraph = false;
  for (const raw of text.split(LINE_BREAK)) {
    const title = raw.match(HEADING);
    if (!raw.trim() || title) {
      inParagraph = false;
      if (title) heading = tagOfHeading(title[1]) || null;
      continue;
    }
    const line = withoutMark(raw);
    if (inParagraph && !line.marked) {
      const last = tasks[tasks.length - 1];
      last.details = last.details ? `${last.details}\n${line.text.trim()}` : line.text.trim();
      continue;
    }
    const { text: title_, tags } = parseTask(line.text);
    if (!title_) continue;
    tasks.push({ text: title_, tags: heading && !tags.includes(heading) ? [heading, ...tags] : tags, done: line.done });
    inParagraph = !line.marked;
  }
  return tasks;
}

/**
 * The whole lines a selection touches, so text turned into tasks is never cut mid-line: where they start and end.
 * With nothing selected, all the text.
 * @param {string} text
 * @param {number} start
 * @param {number} end
 */
export function selectedLines(text, start, end) {
  if (start === end) return { from: 0, to: text.length };
  const from = text.lastIndexOf('\n', start - 1) + 1;
  // A selection ending just after a line's end doesn't take the next line.
  const stop = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const next = text.indexOf('\n', stop);
  return { from, to: next < 0 ? text.length : next };
}

/**
 * The text without the lines taken out, with no blank lines left at the join or the ends.
 * @param {string} text
 * @param {number} from
 * @param {number} to
 */
export const withoutLines = (text, from, to) => `${text.slice(0, from)}\n${text.slice(to)}`.replace(/\n{3,}/g, '\n\n').trim();

/**
 * @param {TodoTask[] | null | undefined} tasks
 */
export const openCount = tasks => (tasks ?? []).filter(t => !t.done).length;

/**
 * Every tag in a list, in the order they first show, each with how many of its open tasks have it.
 * @param {TodoTask[]} tasks
 * @returns {[string, number][]}
 */
export function tagsIn(tasks) {
  /** @type {Map<string, number>} */
  const tags = new Map();
  for (const task of tasks) {
    if (task.done) continue;
    for (const tag of task.tags ?? []) tags.set(tag, (tags.get(tag) ?? 0) + 1);
  }
  return [...tags];
}

/**
 * The tasks a list shows with these tags picked: any of them, or all with none picked.
 * @param {TodoTask[]} tasks
 * @param {string[]} picked
 */
export const withTags = (tasks, picked) => (picked.length ? tasks.filter(t => (t.tags ?? []).some(tag => picked.includes(tag))) : tasks);

/**
 * Moves a task to where another is, in the list it's in: the reorder of a drag.
 * @param {TodoTask[]} tasks
 * @param {string} id
 * @param {string} beforeId
 */
export function moveBefore(tasks, id, beforeId) {
  const from = tasks.findIndex(t => t.id === id);
  if (from < 0 || id === beforeId) return;
  const [task] = tasks.splice(from, 1);
  const to = tasks.findIndex(t => t.id === beforeId);
  tasks.splice(to < 0 ? tasks.length : to, 0, task);
}

/**
 * The GitHub labels to tick for a task: those named as one of its tags, ignoring case.
 * @param {string[]} labels
 * @param {string[]} tags
 */
export const labelsForTags = (labels, tags) => labels.filter(label => tags.includes(label.toLowerCase()));

/**
 * What an issue made from a task says: its details, and nothing when it has none.
 * @param {TodoTask} task
 */
export const issueBody = task => task.details?.trim() ?? '';

/**
 * A hover's lines for a list: the first open tasks, and how many more there are.
 * @param {TodoTask[] | null | undefined} tasks
 */
export function hoverLines(tasks) {
  const open = (tasks ?? []).filter(t => !t.done);
  const more = open.length - HOVER_TASKS;
  return [...open.slice(0, HOVER_TASKS).map(t => `- ${t.text}`), ...(more > 0 ? [`${more} more`] : [])];
}
