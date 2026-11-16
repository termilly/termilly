// @ts-check
// Running a repository's VS Code task (reposnippets.js), or any snippet, in a new terminal. A task runs what it
// depends on first, in order (each once; a loop is broken), with its ${input:…} asked for in the snippets' run form.
// As VS Code does, it runs in a new terminal named after it, in its folder (options.cwd) with its variables
// (options.env); it can also be typed into the focused terminal.

import { state } from './store.js';
import { focusedTab, newTab } from './panes.js';
import { askValues, placeholders, fill, markUsed, sendSnippet, runSnippet } from './snippets.js';
import { repoByRoot, folderOfTab } from './reposnippets.js';

/** @typedef {import('./reposnippets.js').ListedSnippet} ListedSnippet */
/** @typedef {import('./reposnippets.js').RepoTask} RepoTask */

/** How a snippet or task runs: in a new terminal, in the focused one, or typed there without Enter. */
export const RUN_MODE = Object.freeze({ newTerminal: 'new', focused: 'focused', typeOnly: 'type' });

/**
 * The tasks to run for one, in order: what it depends on first (by label, in its own file), each once.
 * @param {RepoTask} task
 * @param {RepoTask[]} tasks
 * @param {Set<string>} [seen]
 * @returns {RepoTask[]}
 */
export function taskChain(task, tasks, seen = new Set()) {
  if (seen.has(task.label)) return [];
  seen.add(task.label);
  const own = tasks.filter(t => t.file === task.file);
  return [...task.dependsOn.flatMap(d => {
    const next = own.find(t => t.label === d);
    return next ? taskChain(next, own, seen) : [];
  }), task];
}

/**
 * A folder relative to the repository's (as options.cwd may be), made whole.
 * @param {string | null | undefined} cwd
 * @param {string | undefined} root
 */
const inRepo = (cwd, root) => (!cwd ? root ?? null : /^[A-Za-z]:|^[\\/]/.test(cwd) || !root ? cwd : `${root}/${cwd}`);

/**
 * Asks for a command's placeholders (none: nothing to ask). Resolves the values, or null when cancelled.
 * @param {SnippetSetting} snippet
 * @param {import('./reposnippets.js').TaskInput[]} [inputs]
 * @returns {Promise<Record<string, string> | null>}
 */
async function valuesFor(snippet, inputs) {
  const names = placeholders(snippet.command);
  if (!names.length) return {};
  const answer = await askValues(snippet, names, [], inputs);
  return answer?.values ?? null;
}

/**
 * Opens a terminal named after a snippet or task, beside the focused one, and types its lines at the first prompt.
 * @param {SnippetSetting} snippet
 * @param {Record<string, string>} values
 * @param {{ cwd?: string | null, env?: Record<string, string> | null }} where
 */
function openWith(snippet, values, { cwd, env }) {
  const tab = focusedTab();
  markUsed(snippet.id);
  return newTab({
    wsId: tab?.wsId ?? state.activeId, name: snippet.name, cwd: cwd ?? null, env: env ?? null,
    command: fill(snippet.command, values).replace(/\r?\n/g, '\r'),
  });
}

/**
 * Runs a task: in a new terminal (by default), or in the focused one (typed only, without Enter, for typeOnly).
 * @param {ListedSnippet} snippet a task from the lists
 * @param {string} [mode]
 */
export async function runTask(snippet, mode = RUN_MODE.newTerminal) {
  const task = /** @type {RepoTask} */ (snippet.task);
  const chain = taskChain(task, repoByRoot(snippet.root)?.allTasks ?? [task]);
  const tab = focusedTab();
  const fresh = mode === RUN_MODE.newTerminal || !tab;
  const start = fresh ? inRepo(task.cwd, snippet.root) : folderOfTab(tab);
  const run = { ...snippet, command: chainLines(chain, start, snippet.root).join('\n') };
  const values = await valuesFor(run, snippet.inputs);
  if (!values) return null;
  // Each task's variables, the one asked for last (it wins over what it depends on).
  if (fresh) return openWith(run, values, { cwd: start, env: Object.assign({}, ...chain.map(t => t.env ?? {})) });
  markUsed(snippet.id);
  return sendSnippet({ ...run, enter: mode !== RUN_MODE.typeOnly }, values, [/** @type {Tab} */ (tab)]);
}

/**
 * The lines a chain of tasks types: each task's command, after a cd to its own folder when it isn't where the one
 * before it ran (a dependency can have a folder of its own).
 * @param {RepoTask[]} chain
 * @param {string | null} start the folder the terminal is in
 * @param {string | undefined} root
 */
export function chainLines(chain, start, root) {
  const lines = [];
  let here = start;
  for (const t of chain) {
    const dir = inRepo(t.cwd, root);
    if (dir && dir !== here) {
      lines.push(`cd "${dir}"`);
      here = dir;
    }
    if (t.command) lines.push(t.command);
  }
  return lines;
}

/**
 * Runs a snippet: in the focused terminal (typed only, for typeOnly), or a new terminal in its folder.
 * @param {ListedSnippet} snippet
 * @param {string} [mode]
 */
export async function runAny(snippet, mode = RUN_MODE.focused) {
  if (snippet.task) return runTask(snippet, mode === RUN_MODE.focused ? RUN_MODE.newTerminal : mode);
  const tab = focusedTab();
  if (mode !== RUN_MODE.newTerminal && tab) return runSnippet(snippet, { tab, enter: mode !== RUN_MODE.typeOnly });
  const values = await valuesFor(snippet);
  return values && openWith(snippet, values, { cwd: folderOfTab(tab) ?? snippet.root });
}
