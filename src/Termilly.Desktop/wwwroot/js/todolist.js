// @ts-check
// What To do's lists are made of, with nothing of the page in it: text turned into tasks (typed, pasted, or a note's
// lines), and what a list counts. js/todo.js keeps the lists; js/todopanel.js shows them.

/** A task's statuses. */
export const TASK_STATUS = Object.freeze({ open: 'open', progress: 'progress', review: 'review', done: 'done' });

/** How many of a list's open tasks a hover shows. */
export const HOVER_TASKS = 5;
/** The longest tag: a `#` in a line of text isn't a tag past this. */
const MAX_TAG_LENGTH = 32;
const TAG_NAME = `([\\p{L}\\p{N}_-]{1,${MAX_TAG_LENGTH}})`;
/** A tag in a line of text, a word of its own: `#tag` or `:tag:`. */
const TAG_IN_TEXT = new RegExp(`(^|\\s)(?:#${TAG_NAME}|:${TAG_NAME}:)(?=\\s|$)`, 'gu');
/** A list mark at the start of a line: `- `, `* `, `1. `, each with an optional box. */
const LIST_MARK = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[( |x|X)\]\s+)?/;
const BOX_ONLY = /^\s*\[( |x|X)\]\s+/;
const HEADING = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/;
const LINE_BREAK = /\r?\n/;
const TICKED = 'xX';
/** A line of a task's details that's a sub-item: `[] text`, `[ ] text`, `[x] text`, with a list mark or without. */
const SUB_ITEM = /^\s*(?:[-*+]\s+)?\[( |x|X)?\]\s*(.*)$/;
/** The issue a sub-item became: its address, at the end of its line. */
const SUB_ISSUE = /\s+(https:\/\/\S+\/issues\/(\d+))\s*$/;
const TAG_HASH_BASE = 31;
const TAG_HASH_LIMIT = 1000003;

/**
 * A heading as a tag: `## Deploy now` is `deploy-now`.
 * @param {string} heading
 */
export const tagOfHeading = heading => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, MAX_TAG_LENGTH);

/**
 * A line typed into the add field: its text, and the tags in it (`#tag` or `:tag:`) taken out.
 * @param {string} line
 * @returns {{ text: string, tags: string[] }}
 */
export function parseTask(line) {
  /** @type {string[]} */
  const tags = [];
  const text = line.replace(TAG_IN_TEXT, (_, before, hashed, colons) => {
    const name = (hashed ?? colons).toLowerCase();
    if (!tags.includes(name)) tags.push(name);
    return before;
  }).replace(/\s+/g, ' ').trim();
  return { text, tags };
}

/**
 * A line typed into the add field with one of its tags taken out, wherever it's written (`#tag` or `:tag:`).
 * @param {string} line
 * @param {string} tag
 */
export const withoutTag = (line, tag) => line
  .replace(TAG_IN_TEXT, (match, before, hashed, colons) => ((hashed ?? colons).toLowerCase() === tag ? before : match))
  .replace(/\s{2,}/g, ' ').replace(/^\s+/, '');

/** A `:tag` being typed: a colon starting a word, and what's typed of the name, right before the caret. */
const TAG_TYPED = new RegExp(`(^|\\s):([\\p{L}\\p{N}_-]{0,${MAX_TAG_LENGTH}})$`, 'u');
/** How many tags the suggestions under a `:` show. */
export const TAG_SUGGESTIONS = 8;

/**
 * The `:tag` typed right before the caret, if one is: where its colon is, and its name so far (lower case).
 * @param {string} text
 * @param {number} caret
 * @returns {{ start: number, query: string } | null}
 */
export function tagTypedAt(text, caret) {
  const match = text.slice(0, caret).match(TAG_TYPED);
  if (!match || match.index === undefined) return null;
  return { start: match.index + match[1].length, query: match[2].toLowerCase() };
}

/**
 * The tags to suggest for what's typed: those starting with it first, then those with it inside; the most used first
 * within each, and none already taken.
 * @param {[string, number][]} known every tag and how many tasks have it
 * @param {string} query
 * @param {string[]} taken
 */
export function tagSuggestions(known, query, taken) {
  const free = known.filter(([tag]) => !taken.includes(tag) && tag.includes(query));
  const rank = (/** @type {string} */ tag) => (tag.startsWith(query) ? 0 : 1);
  return free.sort((a, b) => rank(a[0]) - rank(b[0]) || b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TAG_SUGGESTIONS);
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
 * Every tag in these lists, done tasks' too, most used first and then by name: what a task's tags are picked from.
 * @param {(TodoTask[] | null | undefined)[]} lists
 * @param {string[]} [kept] tags that stay with no task on them
 * @returns {[string, number][]}
 */
export function allTags(lists, kept = []) {
  /** @type {Map<string, number>} */
  const tags = new Map(kept.map(tag => [tag, 0]));
  for (const task of lists.flatMap(list => list ?? [])) {
    for (const tag of task.tags ?? []) tags.set(tag, (tags.get(tag) ?? 0) + 1);
  }
  return [...tags].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * The selected lines of a note, or all of it, as tasks, and the note without them.
 * @param {string} text
 * @param {number} start
 * @param {number} end
 */
export function splitNote(text, start, end) {
  const { from, to } = selectedLines(text, start, end);
  return { tasks: tasksFromNote(text.slice(from, to)), rest: withoutLines(text, from, to) };
}

/**
 * A task's tags with one renamed (to one it has already: they become one), or taken off (to is null).
 * @param {string[]} tags
 * @param {string} from
 * @param {string | null} to
 */
export function retag(tags, from, to) {
  return [...new Set(tags.flatMap(tag => (tag === from ? to ?? [] : tag)))];
}

/**
 * A number from a tag's name: a tag nobody coloured looks the same in every list.
 * @param {string} tag
 */
export function tagHash(tag) {
  let hash = 0;
  for (const c of tag) hash = (hash * TAG_HASH_BASE + /** @type {number} */ (c.codePointAt(0))) % TAG_HASH_LIMIT;
  return hash;
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
 * A line of a task's details: plain text, or a sub-item with its tick and the issue made from it.
 * @typedef {{ at: number, text: string, sub: boolean, done: boolean, issue?: { url: string, number: number } }} DetailLine
 */

/**
 * The lines of a task's details, sub-items marked. A `[]` with nothing after it is only text.
 * @param {string | undefined} details
 * @returns {DetailLine[]}
 */
export function detailLines(details) {
  return (details ?? '').split(LINE_BREAK).map((line, at) => {
    const match = line.match(SUB_ITEM);
    if (!match?.[2].trim()) return { at, text: line, sub: false, done: false };
    const issue = match[2].match(SUB_ISSUE);
    return {
      at, sub: true, done: !!match[1] && TICKED.includes(match[1]), text: issue ? match[2].slice(0, issue.index).trim() : match[2].trim(),
      ...(issue ? { issue: { url: issue[1], number: Number(issue[2]) } } : {}),
    };
  });
}

/** @param {TodoTask} task */
export const statusOf = task => (task.done ? TASK_STATUS.done : task.status ?? TASK_STATUS.open);

/**
 * The details with a sub-item ticked, by its number among the sub-items, from 1. Unchanged when there's no such one.
 * @param {string} details
 * @param {number} number
 */
export function tickByNumber(details, number) {
  const line = detailLines(details).filter(l => l.sub)[number - 1];
  return line ? tickSub(details, line.at, true) : details;
}

/**
 * The details with one sub-item ticked or not.
 * @param {string} details
 * @param {number} at its line
 * @param {boolean} done
 */
export function tickSub(details, at, done) {
  const lines = details.split(LINE_BREAK);
  lines[at] = lines[at].replace(/\[( |x|X)?\]/, done ? '[x]' : '[ ]');
  return lines.join('\n');
}

/**
 * The details with an issue's address at the end of a sub-item.
 * @param {string} details
 * @param {number} at its line
 * @param {string} url
 */
export function linkSub(details, at, url) {
  const lines = details.split(LINE_BREAK);
  lines[at] = `${lines[at].trimEnd()} ${url}`;
  return lines.join('\n');
}

/**
 * How many of a task's sub-items are done, and how many it has.
 * @param {string | undefined} details
 * @returns {[number, number]}
 */
export function subProgress(details) {
  const subs = detailLines(details).filter(line => line.sub);
  return [subs.filter(line => line.done).length, subs.length];
}

/** @param {string} text */
const oneLine = text => text.replace(/\s+/g, ' ').trim();

/**
 * What Implement asks an agent: a task, with what its details say and the sub-items still to do, or one sub-item of it.
 * @param {TodoTask} task
 * @param {DetailLine} [sub]
 */
export function implementPrompt(task, sub) {
  const lines = detailLines(task.details);
  if (sub) {
    const step = lines.filter(line => line.sub).findIndex(line => line.at === sub.at) + 1;
    return `Work on this step from my Termilly To do list: '${oneLine(sub.text)}'. It is step ${step} of task ${task.id}, '${oneLine(task.text)}'. When you finish, call the termilly MCP tool finish_task with that task, step ${step} and a one-line summary, or run: termilly tasks done ${task.id} --step ${step} --summary 'what you did'`;
  }
  const notes = oneLine(lines.filter(line => !line.sub).map(line => line.text).join(' '));
  const steps = lines.filter(line => line.sub && !line.done).map((line, i) => `${i + 1}) ${oneLine(line.text)}`);
  return `Work on this task from my Termilly To do list: '${oneLine(task.text)}'.${notes ? ` Details: ${notes}` : ''}${steps.length ? ` Steps: ${steps.join(' ')}. Tick each with the termilly MCP tool tick_task, or run: termilly tasks tick ${task.id} N` : ''} This is task ${task.id}. When you finish, call the termilly MCP tool finish_task with a one-line summary, or run: termilly tasks done ${task.id} --summary 'what you did'`;
}

/**
 * What Implement asks an agent working silently (Silent): the same task or step, with no tools to call back. Its reply is what
 * Review shows, so it's asked to say what it did.
 * @param {TodoTask} task
 * @param {DetailLine} [sub]
 */
export function silentPrompt(task, sub) {
  const lines = detailLines(task.details);
  const ask = ' Nobody is watching, so do not wait for answers. When you finish, reply with a short summary of what you did and what is left, first line first.';
  if (sub) return `Work on this step of my task '${oneLine(task.text)}': '${oneLine(sub.text)}'.${ask}`;
  const notes = oneLine(lines.filter(line => !line.sub).map(line => line.text).join(' '));
  const steps = lines.filter(line => line.sub && !line.done).map((line, i) => `${i + 1}) ${oneLine(line.text)}`);
  return `Work on this task from my To do list: '${oneLine(task.text)}'.${notes ? ` Details: ${notes}` : ''}${steps.length ? ` Steps: ${steps.join(' ')}.` : ''}${ask}`;
}

/**
 * What a status is called.
 * @type {Readonly<Record<string, string>>}
 */
export const STATUS_NAME = Object.freeze({
  [TASK_STATUS.open]: 'Open', [TASK_STATUS.progress]: 'In progress', [TASK_STATUS.review]: 'Review', [TASK_STATUS.done]: 'Done',
});

/**
 * Whether a task is found by what's typed: in its text, details, tags (with or without #), its issue's number, or its status.
 * Every word typed has to be found.
 * @param {TodoTask} task
 * @param {string} query
 */
export function taskMatches(task, query) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const issues = [task.issue?.number, ...detailLines(task.details).map(line => line.issue?.number)].filter(Boolean).map(n => `#${n}`);
  const text = [task.text, task.details ?? '', ...(task.tags ?? []).map(tag => `#${tag}`), ...issues, STATUS_NAME[statusOf(task)], task.review?.summary ?? ''].join('\n').toLowerCase();
  return words.every(word => text.includes(word));
}

/**
 * A list in the order it shows: tasks where they are, done ones in their own part at the end, except those done while it was
 * shown (`settled`), which stay in place until it's shown again.
 * @param {TodoTask[]} tasks
 * @param {Set<string>} settled
 */
export function inPlace(tasks, settled) {
  const stays = (/** @type {TodoTask} */ task) => !task.done || settled.has(task.id);
  return { main: tasks.filter(stays), done: tasks.filter(task => !stays(task)) };
}

/**
 * A list as the picker's tree sees it.
 * @typedef {{ ref: { kind: string, id: string }, name: string, tasks: TodoTask[], note: string }} TreeList
 */
/**
 * A workspace in the picker's tree: its own list, and its terminals.
 * @typedef {{ list: TreeList, color: string, terms: { list: TreeList, badge: string }[] }} TreeGroup
 */
/**
 * A row of the picker's tree. A workspace (depth 0) counts its terminals' tasks too.
 * @typedef {{ list: TreeList, depth: number, count: number, color?: string, badge?: string, open?: boolean, foldable?: boolean }} TreeRow
 */

/** @param {TreeList | null} list */
const filled = list => !!list && (!!list.note || openCount(list.tasks) > 0);

/**
 * Whether a list is found by what's typed: by its name, or the text of an open task.
 * @param {TreeList | null} list
 * @param {string} query in lower case
 */
export const found = (list, query) => !!list && (list.name.toLowerCase().includes(query)
  || list.tasks.some(task => !task.done && task.text.toLowerCase().includes(query)));

/**
 * Whether a row stays with these choices.
 * @param {TreeList | null} list
 * @param {{ query: string, only: boolean, isCurrent: (list: TreeList) => boolean }} choices
 */
const stays = (list, { query, only, isCurrent }) => !!list
  && (query ? found(list, query) : !only || filled(list) || isCurrent(list));

/**
 * The picker's rows: workspaces with their terminals under them. Typing finds lists
 * and opens what it finds; a workspace found by name keeps all its terminals. With `only`, what has nothing in it goes,
 * but never the list shown.
 * @param {TreeGroup[]} groups
 * @param {{ query?: string, only?: boolean, isOpen: (group: TreeGroup) => boolean, isCurrent: (list: TreeList) => boolean }} options
 * @returns {TreeRow[]}
 */
export function treeRows(groups, { query = '', only = false, isOpen, isCurrent }) {
  const q = query.trim().toLowerCase();
  const choices = { query: q, only, isCurrent };
  /** @type {TreeRow[]} */
  const rows = [];
  for (const group of groups) {
    const named = !!q && group.list.name.toLowerCase().includes(q);
    const kept = group.terms.filter(t => named || stays(t.list, choices));
    if (!stays(group.list, choices) && !kept.length && !named) continue;
    const open = q ? true : isOpen(group);
    const count = openCount(group.list.tasks) + group.terms.reduce((sum, t) => sum + openCount(t.list.tasks), 0);
    rows.push({ list: group.list, depth: 0, count, color: group.color, open, foldable: !q && group.terms.length > 0 });
    if (!open) continue;
    for (const t of kept) rows.push({ list: t.list, depth: 1, count: openCount(t.list.tasks), badge: t.badge });
  }
  return rows;
}

/**
 * A hover's lines for a list: the first open tasks and how many more there are, or that all of them are done.
 * @param {TodoTask[] | null | undefined} tasks
 */
export function hoverLines(tasks) {
  const open = (tasks ?? []).filter(t => !t.done);
  const more = open.length - HOVER_TASKS;
  if (!open.length && tasks?.length) return ['All done'];
  return [...open.slice(0, HOVER_TASKS).map(t => `- ${t.text}`), ...(more > 0 ? [`${more} more`] : [])];
}
