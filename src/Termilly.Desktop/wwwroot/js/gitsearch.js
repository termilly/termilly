// @ts-check
// The Git window's search (js/gitwindow.js; Ctrl+F there): one text looked for across the repository, as the master
// search looks across terminals. The files Claude changed in the terminal (by path and by what's in them now),
// changed files, commits by hash, message and author, the lines commits added or removed, branches and tags, in
// groups, with what matched marked and a filter for one kind. The host searches (ChangeSearch.cs, GitSearch.cs);
// this keeps what it found and draws its rows. Code in commits comes after the rest, a batch of history at a time,
// as it takes longer. Outside a repository only Claude's changes are searched.

import { PAGE } from './protocol.js';
import { request } from './host.js';
import { escapeHtml, highlight, snippet } from './ui.js';
import { timeAgo } from './util.js';
import { DIFF_ROW, DIFF_LINE, DIFF_TARGET } from './diffrows.js';
import { GIT_MATCH } from './constants.js';

// What GitView.cs and GitSearch.cs answer with.
/**
 * A commit in a log.
 * @typedef {{ hash: string, short: string, subject: string, author: string, date: string,
 *   refs?: string[] | null }} Commit
 */
/**
 * A branch, local or remote, with its last commit.
 * @typedef {{ name: string, ref: string, short: string, subject: string, date: string, current?: boolean,
 *   remote?: boolean, upstream?: string | null, ahead?: number, behind?: number, gone?: boolean }} Branch
 */
/**
 * A changed file found by its path (line 0), or a line in it.
 * @typedef {{ path: string, side: string, status: string, conflict: boolean, line: number, text?: string | null }} FileHit
 */
/** @typedef {{ path: string, added: boolean, text: string }} CodeLine */
/**
 * A commit found, why (GIT_MATCH), and for its code the lines.
 * @typedef {{ commit: Commit, on: string, lines: CodeLine[] }} CommitHit
 */
/** @typedef {{ ref: string, name: string, hash: string, short: string, date: string, subject: string }} TagInfo */
/**
 * @typedef {{ files: FileHit[], commits: CommitHit[], branches: Branch[],
 *   tags: TagInfo[] }} SearchResult
 */
/** @typedef {{ commits: CommitHit[], searched: number, more: boolean }} CodeResult */
/**
 * A file Claude changed in the terminal, found by its path (line 0) or a line in it (ChangeSearch.cs).
 * @typedef {{ path: string, display: string, outside: boolean, line: number, text?: string | null }} AgentHit
 */
/**
 * A row of the search's list (with the window's sections and branches).
 * @typedef {{ kind: 'file-hit', hit: FileHit } | { kind: 'commit-hit', hit: CommitHit } | { kind: 'tag', tag: TagInfo }
 *   | { kind: 'agent-hit', hit: AgentHit } | { kind: 'show-all', view: string, count: number }
 *   | { kind: 'more-code', searched: number } | { kind: 'status', text: string }} SearchItem
 */
/**
 * Where a search looks: the repository's root (none outside one) and the terminal whose changes count too.
 * @typedef {{ root: string | null, agentId: string | null }} SearchScope
 */
/**
 * How the window asks the host (its own ask, which knows the server).
 * @typedef {(type: any, payload: any) => Promise<any>} Ask
 */

/** The side list's row kinds (ListItem.kind): the window's own, and the search's. */
export const ITEM = Object.freeze({
  section: 'section', file: 'file', commit: 'commit', branch: 'branch', more: 'more',
  fileHit: 'file-hit', commitHit: 'commit-hit', tag: 'tag', agentHit: 'agent-hit', showAll: 'show-all', moreCode: 'more-code', status: 'status',
});
/** A conflicted file's status, as its row's data-s (app.css colours it). */
export const CONFLICT = 'conflict';
/** What the search shows: everything, or one kind. */
export const SEARCH_VIEW = Object.freeze({
  all: 'all', agent: 'agent', files: 'files', commits: 'commits', code: 'code', branches: 'branches', tags: 'tags',
});
/** The kinds only a repository has (outside one, only Claude's changes are searched). */
/** @type {Set<string>} */
const GIT_VIEWS = new Set([SEARCH_VIEW.files, SEARCH_VIEW.commits, SEARCH_VIEW.code, SEARCH_VIEW.branches, SEARCH_VIEW.tags]);
/** @type {Array<[string, string]>} */
const VIEWS = [
  [SEARCH_VIEW.all, 'All'], [SEARCH_VIEW.agent, 'Agent changes'], [SEARCH_VIEW.files, 'Changed files'],
  [SEARCH_VIEW.commits, 'Commits'], [SEARCH_VIEW.code, 'Code'], [SEARCH_VIEW.branches, 'Branches'], [SEARCH_VIEW.tags, 'Tags'],
];
/** @type {Record<string, string>} */
const GROUP_TITLE = {
  agent: 'Agent changes', files: 'Changed files', commits: 'Commits', code: 'Code in commits', branches: 'Branches', tags: 'Tags',
};
/** Rows each kind shows under All; the rest are a click (or its filter) away. */
const GROUP_ROWS = 8;
/** Characters of a line a row shows. */
const ROW_SNIPPET = 70;
/** The shortest text searched (one letter would find everything). */
export const MIN_SEARCH = 2;

/** What's searched for, and what was found. */
export const found = {
  text: '', // as typed, trimmed; empty when there's no search
  /** @type {string} */
  view: SEARCH_VIEW.all,
  /** @type {SearchResult | null} */
  result: null, // null while it's searching
  /** @type {SearchScope} */
  scope: { root: null, agentId: null },
  /** @type {AgentHit[]} */
  agent: [],
  /** @type {CommitHit[]} */
  code: [],
  codeBatch: 0, // the next batch of history to search for code
  codeSearched: 0, // commits searched for code so far
  codeMore: false,
  codeBusy: false,
  /** @type {string | null} */
  error: null,
};
let run = 0; // goes up with each search, so an older one's answers are dropped

export const searching = () => !!found.text;

/** Forgets the search. */
export function clearSearch() {
  run++;
  Object.assign(found, {
    text: '', view: SEARCH_VIEW.all, result: null, scope: { root: null, agentId: null }, agent: [], code: [],
    codeBatch: 0, codeSearched: 0, codeMore: false, codeBusy: false, error: null,
  });
}

/** @returns {SearchResult} */
const nothingFound = () => ({ files: [], commits: [], branches: [], tags: [] });

/**
 * Whether a kind can be shown: Agent changes with a terminal, the rest in a repository.
 * @param {string} view
 */
const available = view => view === SEARCH_VIEW.all
  || (view === SEARCH_VIEW.agent ? !!found.scope.agentId : !!found.scope.root && GIT_VIEWS.has(view));

/**
 * Searches for `text`: the terminal's changed files and the repository (everything but code), then the newest
 * commits' code. `changed` redraws after each answer.
 * @param {string} text
 * @param {SearchScope} scope
 * @param {Ask} ask
 * @param {() => void} changed
 */
export async function runSearch(text, scope, ask, changed) {
  const view = found.view;
  clearSearch();
  const mine = run;
  found.text = text;
  found.scope = scope;
  found.view = available(view) ? view : SEARCH_VIEW.all;
  changed();
  if (text.length < MIN_SEARCH) return;
  const [agent, git] = await Promise.all([searchAgent(text, scope.agentId), searchGit(text, scope.root, ask)]);
  if (mine !== run) return;
  found.agent = agent.hits;
  found.result = git.result;
  found.error = git.error ?? agent.error;
  if (scope.root) await searchCode(scope.root, ask, changed);
  else changed();
}

/**
 * The terminal's changed files with the text in their path or lines (always this PC's: see Agents.cs).
 * @param {string} text
 * @param {string | null} agentId
 * @returns {Promise<{ hits: AgentHit[], error: string | null }>}
 */
async function searchAgent(text, agentId) {
  if (!agentId) return { hits: [], error: null };
  const m = await request(PAGE.changesSearch, { id: agentId, query: text });
  return { hits: m.hits ?? [], error: m.error ?? null };
}

/**
 * The repository's changed files, commits, branches and tags with the text; nothing outside a repository.
 * @param {string} text
 * @param {string | null} root
 * @param {Ask} ask
 * @returns {Promise<{ result: SearchResult, error: string | null }>}
 */
async function searchGit(text, root, ask) {
  if (!root) return { result: nothingFound(), error: null };
  try {
    return { result: await ask(PAGE.gitviewSearch, { root, query: text }), error: null };
  } catch (e) {
    return { result: nothingFound(), error: /** @type {Error} */ (e).message };
  }
}

/**
 * The next batch of history's code.
 * @param {string} root
 * @param {Ask} ask
 * @param {() => void} changed
 */
export async function searchCode(root, ask, changed) {
  if (found.codeBusy || !found.result) return;
  const mine = run;
  found.codeBusy = true;
  changed();
  try {
    /** @type {CodeResult} */
    const r = await ask(PAGE.gitviewSearchcode, { root, query: found.text, batch: found.codeBatch });
    if (mine !== run) return;
    found.code.push(...r.commits);
    found.codeSearched = r.searched;
    found.codeMore = r.more;
    found.codeBatch++;
  } catch (e) {
    if (mine !== run) return;
    found.codeMore = false;
    found.error ??= /** @type {Error} */ (e).message;
  }
  found.codeBusy = false;
  changed();
}

// ---- The list ----

/** @param {number} by */
export function stepView(by) {
  const views = VIEWS.filter(([id]) => available(id));
  const at = views.findIndex(([id]) => id === found.view);
  found.view = views[(at + by + views.length) % views.length][0];
}

/** @param {string} view */
export function setView(view) {
  found.view = view;
}

/** Code's last rows: that it's searching, or that older commits can be. */
function codeTail() {
  if (found.codeBusy) return [{ kind: ITEM.status, text: found.codeSearched ? 'Searching older commits' : 'Searching code in commits' }];
  return found.codeMore ? [{ kind: ITEM.moreCode, searched: found.codeSearched }] : [];
}

/**
 * The side list's rows for what was found, by kind, each kind under its heading.
 * @returns {Array<SearchItem | { kind: 'section', key: string, label: string, count: number, fixed: true }
 *   | { kind: 'branch', branch: Branch }>}
 */
export function searchItems() {
  const r = found.result;
  if (!r) return [];
  /** @type {Record<string, any[]>} */
  const groups = {
    [SEARCH_VIEW.agent]: found.agent.map(hit => ({ kind: ITEM.agentHit, hit })),
    [SEARCH_VIEW.files]: r.files.map(hit => ({ kind: ITEM.fileHit, hit })),
    [SEARCH_VIEW.commits]: r.commits.map(hit => ({ kind: ITEM.commitHit, hit })),
    [SEARCH_VIEW.code]: found.code.map(hit => ({ kind: ITEM.commitHit, hit })),
    [SEARCH_VIEW.branches]: r.branches.map(branch => ({ kind: ITEM.branch, branch })),
    [SEARCH_VIEW.tags]: r.tags.map(tag => ({ kind: ITEM.tag, tag })),
  };
  const out = [];
  for (const [kind, rows] of Object.entries(groups)) {
    if (found.view !== SEARCH_VIEW.all && found.view !== kind) continue;
    const tail = kind === SEARCH_VIEW.code ? codeTail() : [];
    if (!rows.length && !tail.length) continue;
    out.push({ kind: ITEM.section, key: `s-${kind}`, label: GROUP_TITLE[kind], count: rows.length, fixed: true });
    const shown = found.view === SEARCH_VIEW.all ? rows.slice(0, GROUP_ROWS) : rows;
    out.push(...shown);
    if (shown.length < rows.length) out.push({ kind: ITEM.showAll, view: kind, count: rows.length });
    out.push(...tail);
  }
  return out;
}

/** What the list says when the search has no rows. */
export function searchEmptyText() {
  if (found.text.length < MIN_SEARCH) return `Type at least ${MIN_SEARCH} characters.`;
  if (!found.result) return 'Searching';
  if (found.error) return escapeHtml(found.error);
  return `Nothing matches “${escapeHtml(found.text)}”${found.view === SEARCH_VIEW.all ? '' : ' here'}.`;
}

/** The filter chips: each kind, with how many it found. */
export function filtersHtml() {
  const r = found.result;
  /** @type {Record<string, number>} */
  const counts = {
    [SEARCH_VIEW.agent]: found.agent.length,
    [SEARCH_VIEW.files]: r?.files.length ?? 0, [SEARCH_VIEW.commits]: r?.commits.length ?? 0, [SEARCH_VIEW.code]: found.code.length,
    [SEARCH_VIEW.branches]: r?.branches.length ?? 0, [SEARCH_VIEW.tags]: r?.tags.length ?? 0,
  };
  counts[SEARCH_VIEW.all] = Object.values(counts).reduce((a, b) => a + b, 0);
  return VIEWS.filter(([id]) => available(id)).map(([id, label]) => {
    const more = id === SEARCH_VIEW.code && found.codeMore ? '+' : '';
    const count = counts[id] || id === found.view ? ` <span>${counts[id]}${more}</span>` : '';
    return `<button class="fchip${id === found.view ? ' on' : ''}" data-search-view="${id}">${label}${count}</button>`;
  }).join('');
}

/**
 * Which row was opened, to mark it: a file hit by its file and line, a commit by its hash and why.
 * @param {SearchItem} item
 */
export function hitKey(item) {
  if (item.kind === ITEM.fileHit) return `${item.kind}:${item.hit.side}:${item.hit.path}:${item.hit.line}`;
  if (item.kind === ITEM.agentHit) return `${item.kind}:${item.hit.path}:${item.hit.line}`;
  if (item.kind === ITEM.commitHit) return `${item.kind}:${item.hit.on}:${item.hit.commit.hash}`;
  if (item.kind === ITEM.tag) return `${item.kind}:${item.tag.ref}`;
  return null;
}

/**
 * "3 min ago", "yesterday", "12 Mar"; nothing for a time that doesn't read.
 * @param {string} iso
 */
export function ago(iso) {
  const at = Date.parse(iso);
  return at ? timeAgo(at) : '';
}

/**
 * A search row's HTML; null for the rows js/gitwindow.js draws (sections, branches).
 * @param {SearchItem | { kind: string }} item
 * @param {number} i
 * @param {boolean} selected
 */
export function searchRowHtml(item, i, selected) {
  const needle = found.text.toLowerCase();
  const sel = selected ? ' selected' : '';
  const it = /** @type {SearchItem} */ (item);
  switch (it.kind) {
    case ITEM.fileHit: return fileHitHtml(it.hit, i, sel, needle);
    case ITEM.agentHit: return agentHitHtml(it.hit, i, sel, needle);
    case ITEM.commitHit: return commitHitHtml(it.hit, i, sel, needle);
    case ITEM.tag:
      return `<div class="cw-row gw-commit gw-hit${sel}" data-i="${i}" role="option">`
        + `<span class="gw-commit-main"><span class="gw-ref is-tag">${highlight(it.tag.name, needle)}</span></span>`
        + `<span class="gw-commit-meta"><span class="gw-hash">${escapeHtml(it.tag.short)}</span><span>${escapeHtml(it.tag.subject)}</span><span>${ago(it.tag.date)}</span></span></div>`;
    case ITEM.showAll: return `<div class="cw-row gw-more" data-i="${i}">Show all ${it.count}</div>`;
    case ITEM.moreCode:
      return `<div class="cw-row gw-more" data-i="${i}" title="Searched the latest ${it.searched} commits">Search older commits</div>`;
    case ITEM.status: return `<div class="cw-row gw-search-status" data-i="${i}">${escapeHtml(it.text)}</div>`;
    default: return null;
  }
}

/**
 * @param {FileHit} hit
 * @param {number} i
 * @param {string} sel
 * @param {string} needle
 */
function fileHitHtml(hit, i, sel, needle) {
  const status = `<span class="gw-status" data-s="${hit.conflict ? CONFLICT : escapeHtml(hit.status)}">${escapeHtml(hit.conflict ? '!' : hit.status)}</span>`;
  return pathHitHtml({ shown: hit.path, title: hit.path, status, line: hit.line, text: hit.text }, i, sel, needle);
}

/**
 * A file Claude changed, found by its path or a line in it: shown by its path relative to Claude's folder.
 * @param {AgentHit} hit
 * @param {number} i
 * @param {string} sel
 * @param {string} needle
 */
function agentHitHtml(hit, i, sel, needle) {
  return pathHitHtml({ shown: hit.outside ? hit.path : hit.display, title: hit.path, status: '', line: hit.line, text: hit.text }, i, sel, needle);
}

/**
 * A found file's row: its name and folder with what matched marked, and the line found below them.
 * @param {{ shown: string, title: string, status: string, line: number, text?: string | null }} hit
 * @param {number} i
 * @param {string} sel
 * @param {string} needle
 */
function pathHitHtml({ shown, title, status, line, text }, i, sel, needle) {
  const slash = Math.max(shown.lastIndexOf('/'), shown.lastIndexOf('\\'));
  const lineHtml = line
    ? `<span class="gw-hit-line"><span class="gw-line-no">${line}</span><span class="gw-hit-text">${snippet(text ?? '', needle, ROW_SNIPPET)}</span></span>` : '';
  return `<div class="cw-row gw-commit gw-hit${sel}" data-i="${i}" role="option" title="${escapeHtml(title)}">`
    + `<span class="gw-commit-main">${status}<span class="gw-subject">${highlight(shown.slice(slash + 1), needle)}</span>`
    + `<span class="gw-dir">${highlight(slash > 0 ? shown.slice(0, slash) : '', needle)}</span></span>${lineHtml}</div>`;
}

/**
 * A commit found: what matched is marked (its subject, hash or author), and the code's lines below it.
 * @param {CommitHit} hit
 * @param {number} i
 * @param {string} sel
 * @param {string} needle
 */
function commitHitHtml(hit, i, sel, needle) {
  const c = hit.commit;
  /** @param {string} on */
  const mark = on => (hit.on === on ? needle : '');
  const inBody = hit.on === GIT_MATCH.message && !c.subject.toLowerCase().includes(needle);
  const lines = hit.lines.map(l => `<span class="gw-hit-line ${l.added ? DIFF_ROW.add : DIFF_ROW.del}" title="${escapeHtml(l.path)}">`
    + `<span class="gw-line-no">${l.added ? '+' : '−'}</span><span class="gw-hit-text">${snippet(l.text, needle, ROW_SNIPPET)}</span></span>`).join('');
  return `<div class="cw-row gw-commit gw-hit${sel}" data-i="${i}" role="option">`
    + `<span class="gw-commit-main"><span class="gw-subject">${c.subject ? highlight(c.subject, mark(GIT_MATCH.message)) : '(no message)'}</span>`
    + `${inBody ? '<span class="gw-why">in its message</span>' : ''}</span>`
    + `<span class="gw-commit-meta"><span class="gw-hash">${highlight(c.short, mark(GIT_MATCH.hash))}</span>`
    + `<span>${highlight(c.author, mark(GIT_MATCH.author))}</span><span>${ago(c.date)}</span></span>${lines}</div>`;
}

// ---- In a diff ----

/**
 * Marks every place the search's text is in a diff's lines. Its result is where to scroll: the row of `line` (the
 * file's line number) when given, else the first mark.
 * @param {Element} container
 * @param {number} [line]
 * @returns {Element | null}
 */
export function markInDiff(container, line = 0) {
  const needle = found.text.toLowerCase();
  if (!needle) return null;
  /** @type {Element[]} */
  const marks = [];
  for (const code of container.querySelectorAll('.pv-code')) {
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    /** @type {Text[]} */
    const nodes = [];
    while (walker.nextNode()) nodes.push(/** @type {Text} */ (walker.currentNode));
    for (const node of nodes) marks.push(...markText(node, needle));
  }
  if (line) {
    const row = [...container.querySelectorAll(DIFF_LINE)].find(r => r.querySelector('.pv-no')?.textContent === String(line));
    if (row) {
      row.classList.add(DIFF_TARGET);
      return row;
    }
  }
  return marks[0] ?? null;
}

/**
 * Wraps each place `needle` is in a text node in <mark>.
 * @param {Text} node
 * @param {string} needle lower-case
 */
function markText(node, needle) {
  const marks = [];
  let rest = node;
  for (let at = rest.data.toLowerCase().indexOf(needle); at >= 0; at = rest.data.toLowerCase().indexOf(needle)) {
    const hit = rest.splitText(at);
    rest = hit.splitText(needle.length);
    const mark = document.createElement('mark');
    hit.replaceWith(mark);
    mark.append(hit);
    marks.push(mark);
  }
  return marks;
}
