// @ts-check
// A repository's snippets and tasks (RepoSnippets.cs): the snippets it keeps in .termilly/snippets.yml (shared through
// git, or kept out of it), the ones its .termilly.yml shares, and its VS Code tasks (.vscode/tasks.json). The
// repository is the one the focused terminal's folder is in, on this PC (a terminal on a server, in WSL or a container
// has none here). Read when asked and kept; the host watches the files and says when they change, so a git pull
// shows at once.

import { PAGE, HOST } from './protocol.js';
import { request, onHost } from './host.js';
import { state, emit, wsById, isRemote, EVENTS } from './store.js';
import { remoteGit } from './remotehost.js';

/** @typedef {import('./protocol.js').RepoSnippet} RepoSnippet */
/** @typedef {import('./protocol.js').RepoTask} RepoTask */
/** @typedef {import('./protocol.js').TaskInput} TaskInput */

/**
 * A snippet or task as the lists show it: where it comes from ('repo', 'shared', 'task', or 'global' for this
 * computer's), the repository's folder, and for a task, what tasks.json said.
 * @typedef {SnippetSetting & { scope: string, root?: string, task?: RepoTask, inputs?: TaskInput[] }} ListedSnippet
 */

/**
 * A repository as the lists use it.
 * @typedef {{ root: string, name: string, snippets: ListedSnippet[], shared: ListedSnippet[], tasks: ListedSnippet[],
 *   allTasks: RepoTask[], inputs: TaskInput[], onlyMe: boolean, warnings: string[] }} Repo
 */

/** Where a snippet comes from: the repository's file, its .termilly.yml, its tasks.json, or this computer. */
export const SOURCE = Object.freeze({ repo: 'repo', shared: 'shared', task: 'task', global: 'global' });
/** The repository's files, as the lists name them. */
export const REPO_FILE = '.termilly/snippets.yml';
export const LAYOUT_FILE = '.termilly.yml';
export const TASKS_FILE = '.vscode/tasks.json';

/** The repository each folder asked about is in (null: none), and each repository read. */
/** @type {Map<string, string | null>} */
const rootOf = new Map();
/** @type {Map<string, Repo>} */
const repos = new Map();
/** @type {Map<string, Promise<Repo | null>>} */
const loading = new Map();
/**
 * Saves on their way to the host (per repository), and how many have finished: a read that started before one
 * finished doesn't replace what was saved.
 * @type {{ pending: Map<string, number>, done: number }}
 */
const saves = { pending: new Map(), done: 0 };

/**
 * A folder whose repository can be read here: not on a network share (slow to walk up).
 * @param {string | null | undefined} folder
 * @returns {folder is string}
 */
const readable = folder => !!folder && !/^\\\\/.test(folder) && !/^\/\/[^/]/.test(folder);

/**
 * The folder a terminal works in, on this PC; null for a terminal on another machine.
 * @param {Tab | null | undefined} tab
 */
export function folderOfTab(tab) {
  if (!tab || isRemote(tab) || remoteGit(tab)) return null;
  const folder = tab.cwd ?? tab.startCwd ?? wsById(tab.wsId)?.cwd;
  return readable(folder) ? folder : null;
}

/**
 * A snippet's id in the lists: where it comes from and its name (names are unique in a file; a second of the same
 * name gets its place added).
 * @param {string} source
 * @param {string} root
 * @param {string} name
 * @param {Set<string>} seen
 */
function idOf(source, root, name, seen) {
  let id = `${source}:${root}|${name}`;
  if (seen.has(id)) id = `${id}#${seen.size}`;
  seen.add(id);
  return id;
}

/**
 * @param {string} source
 * @param {string} root
 * @param {RepoSnippet[]} list
 * @returns {ListedSnippet[]}
 */
function listed(source, root, list) {
  const seen = new Set();
  return list.map(s => ({
    id: idOf(source, root, s.name, seen), name: s.name, command: s.command, description: s.description ?? null,
    enter: s.enter !== false, scope: source, root,
  }));
}

/**
 * The tasks the lists show (not the hidden ones): the default build first, then the file's order.
 * @param {string} root
 * @param {RepoTask[]} tasks
 * @param {TaskInput[]} inputs
 * @returns {ListedSnippet[]}
 */
function listedTasks(root, tasks, inputs) {
  const seen = new Set();
  return tasks.filter(t => !t.hidden)
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
    .map(t => ({
      id: idOf(SOURCE.task, root, t.label, seen), name: t.label, command: t.command,
      description: t.isDefault && t.group ? `default ${t.group}` : t.group ?? null, enter: true, scope: SOURCE.task, root, task: t, inputs,
    }));
}

/** @param {import('./protocol.js').HostMessages['reposnippets:found']} m */
function toRepo(m) {
  const root = /** @type {string} */ (m.root);
  return /** @type {Repo} */ ({
    root, name: root.split(/[\\/]/).filter(Boolean).pop() ?? root,
    snippets: listed(SOURCE.repo, root, m.snippets), shared: listed(SOURCE.shared, root, m.shared),
    tasks: listedTasks(root, m.tasks, m.inputs), allTasks: m.tasks, inputs: m.inputs, onlyMe: m.onlyMe, warnings: m.warnings,
  });
}

/** What a repository's lists hold, to tell whether reading it again changed anything. */
const shape = (/** @type {Repo | null | undefined} */ r) => (r ? JSON.stringify([r.snippets, r.shared, r.tasks, r.onlyMe]) : '');

/**
 * Reads the repository a folder is in (again), and keeps it; the lists redraw when it changed.
 * @param {string | null | undefined} folder
 * @returns {Promise<Repo | null>}
 */
export function loadRepo(folder) {
  if (!readable(folder)) return Promise.resolve(null);
  const asked = loading.get(folder);
  if (asked) return asked;
  const asOf = saves.done;
  const answer = request(PAGE.reposnippetsGet, { folder }).then(m => {
    loading.delete(folder);
    let repo = m.root ? toRepo(m) : null;
    // Read before a save finished (or while one is on its way): what's kept, as saved, is newer. The save reads again.
    if (repo && (asOf !== saves.done || saves.pending.has(repo.root)) && repos.has(repo.root)) repo = /** @type {Repo} */ (repos.get(repo.root));
    const before = rootOf.has(folder) ? shape(rootOf.get(folder) ? repos.get(/** @type {string} */ (rootOf.get(folder))) : null) : null;
    rootOf.set(folder, repo?.root ?? null);
    if (repo) repos.set(repo.root, repo);
    if (before !== shape(repo)) emit(EVENTS.snippets);
    return repo;
  });
  loading.set(folder, answer);
  return answer;
}

/**
 * The repository a folder is in, as last read: null when it's in none, or until it's read (which this asks for).
 * @param {string | null | undefined} folder
 * @returns {Repo | null}
 */
export function repoAt(folder) {
  if (!readable(folder)) return null;
  if (!rootOf.has(folder)) {
    loadRepo(folder);
    return null;
  }
  const root = rootOf.get(folder);
  return root ? repos.get(root) ?? null : null;
}

/**
 * The repository a terminal works in (see repoAt).
 * @param {Tab | null | undefined} tab
 */
export const repoOfTab = tab => repoAt(folderOfTab(tab));

/**
 * The snippets a repository keeps or shares, for the API and the palette (not its tasks).
 * @param {Repo | null} repo
 */
export const repoSnippets = repo => (repo ? [...repo.snippets, ...repo.shared] : []);

/**
 * Writes a repository's snippets to its .termilly/snippets.yml (shown at once, before the host has written them).
 * Resolves the host's error, or null.
 * @param {string} root
 * @param {SnippetSetting[]} list
 * @param {boolean} onlyMe keep .termilly/ out of git
 * @returns {Promise<string | null>}
 */
export async function saveRepo(root, list, onlyMe) {
  const repo = repos.get(root);
  if (repo) {
    repo.snippets = listed(SOURCE.repo, root, list.map(s => ({ name: s.name, command: s.command, description: s.description ?? null, enter: s.enter })));
    repo.onlyMe = onlyMe;
    emit(EVENTS.snippets);
  }
  saves.pending.set(root, (saves.pending.get(root) ?? 0) + 1);
  const m = await request(PAGE.reposnippetsSave, {
    root, onlyMe,
    snippets: list.map(s => ({ name: s.name, command: s.command, description: s.description || null, enter: s.enter === false ? false : null })),
  });
  const left = /** @type {number} */ (saves.pending.get(root)) - 1;
  if (left) saves.pending.set(root, left);
  else saves.pending.delete(root);
  saves.done++;
  // The last save is written (or failed): read the file as it is now.
  if (!left) {
    for (const [folder, at] of rootOf) {
      if (at !== root) continue;
      loading.delete(folder); // a read already asked for began before the save, and keeps what was there
      loadRepo(folder);
    }
  }
  return m.error ?? null;
}

/** Every folder known to be in a repository, read again (the file changed). */
onHost(HOST.reposnippetsChanged, m => {
  for (const [folder, root] of rootOf) if (root === m.root) loadRepo(folder);
});

/** The workspaces' folders, read ahead so the first look at the list has them. */
export function readWorkspaceRepos() {
  for (const ws of state.workspaces) loadRepo(ws.cwd);
}

/**
 * A repository read, by its folder (null when it hasn't been).
 * @param {string | undefined} root
 */
export const repoByRoot = root => (root ? repos.get(root) ?? null : null);
