// @ts-check
// Snippets: saved commands with {{placeholders}}, run in one terminal, the broadcast's terminals or every terminal
// with a tag. They're this computer's (Settings), or a repository's: kept in its .termilly/snippets.yml so the team
// shares them in git (or kept out of git, only for this user), or listed in its .termilly.yml (reposnippets.js).
// Placeholders are asked for in a small form that remembers the last values; `{{namespace=default}}` has a default.
// Production terminals ask first (environments.js).

import { PAGE } from './protocol.js';
import { send } from './host.js';
import { state, emit, persist, GROUPS, EVENTS } from './store.js';
import { modal } from './dialogs.js';
import { escapeHtml } from './ui.js';
import { focusedTab } from './panes.js';
import { isBroadcasting, inputTargets } from './broadcast.js';
import { confirmProduction } from './environments.js';
import { updateSettings } from './preferences.js';
import { find } from './dom.js';
import { showToast } from './toasts.js';
import {
  SOURCE, REPO_FILE, LAYOUT_FILE, repoAt, repoOfTab, repoSnippets, loadRepo, saveRepo, folderOfTab,
} from './reposnippets.js';

/** @typedef {import('./reposnippets.js').ListedSnippet} Snippet */
/** @typedef {import('./reposnippets.js').Repo} Repo */
/** @typedef {import('./reposnippets.js').TaskInput} TaskInput */
/** @typedef {{ name: string, def: string }} Placeholder */

const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w.-]*)\s*(?:=([^}]*))?\}\}/g;

/** Where a snippet comes from: this computer, the repository's file, its .termilly.yml, or its tasks.json. */
export const SNIPPET_SCOPE = SOURCE;
/** Where a snippet is saved, in the editors: 'global', or this prefix and a repository's folder. */
export const IN_REPO = 'repo:';
/** Where the run form can send a snippet: the focused terminal, the broadcast, or "tag:" and a tag's name. */
const TARGET = Object.freeze({ focused: 'focused', broadcast: 'broadcast', tagPrefix: 'tag:' });
/** The editors' fields, by their name attribute (a saved snippet's properties, where it's kept, and git). */
export const SNIPPET_FIELD = Object.freeze({
  name: 'name', command: 'command', description: 'description', enter: 'enter', where: 'where', onlyMe: 'onlyMe',
});
/** A snippet saved without a name is named after this many words of its command. */
export const NAME_WORDS = 3;
/** The button that runs a snippet (one that doesn't press Enter says "Type it"). */
export const RUN_LABEL = 'Run';
/** What "Keep it in" calls this computer's snippets. */
export const THIS_COMPUTER = 'This computer';

/**
 * A snippet's placeholders in order, each once: [{ name, def }].
 * @param {string} command
 */
export function placeholders(command) {
  /** @type {Map<string, Placeholder>} */
  const seen = new Map();
  for (const m of String(command).matchAll(PLACEHOLDER)) if (!seen.has(m[1])) seen.set(m[1], { name: m[1], def: m[2] ?? '' });
  return [...seen.values()];
}

/**
 * The command with its placeholders filled in (a missing value falls back to the default).
 * @param {string} command
 * @param {Record<string, string> | null | undefined} values
 */
export const fill = (command, values) =>
  String(command).replace(PLACEHOLDER, (_, name, def) => (hasValue(values, name) ? values[name] : def) ?? '');

/**
 * Whether values has one of its own for a placeholder: a name such as constructor isn't one an object brings along.
 * @param {Record<string, string> | null | undefined} values
 * @param {string} name
 * @returns {values is Record<string, string>}
 */
const hasValue = (values, name) => !!values && Object.hasOwn(values, name);

/**
 * A placeholder's own value in values; undefined when it has none.
 * @param {Record<string, string> | null | undefined} values
 * @param {string} name
 */
export const ownValue = (values, name) => (hasValue(values, name) ? values[name] : undefined);

/**
 * The placeholders that have neither a value nor a default, by name.
 * @param {string} command
 * @param {Record<string, string> | null | undefined} values
 */
export const missingValues = (command, values) => placeholders(command).filter(p => !p.def && !hasValue(values, p.name)).map(p => p.name);

/**
 * The placeholders without a value of their own, defaults or not: a schedule runs with nobody there to check what a
 * default would make of it.
 * @param {string} command
 * @param {Record<string, string> | null | undefined} values
 */
export const unfilled = (command, values) => placeholders(command).filter(p => !ownValue(values, p.name)?.trim()).map(p => p.name);

/**
 * The values that say something: an empty field is no value, so its default (or nothing) counts.
 * @param {Record<string, string>} values
 */
export const filled = values => Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()));

/**
 * How the run form asks for a schedule (js/scheduleswindow.js): from the schedule's own values, with its own button,
 * and only once each placeholder has one typed in (a default doesn't count, nor is it filled in).
 * @typedef {{ given?: Record<string, string>, ok?: string, required?: boolean }} ValuesForm
 */

/** This computer's snippets, as the lists show them. */
export const globalSnippets = () => /** @type {Snippet[]} */ ((state.settings.commands.snippets ?? []).map(s => ({ ...s, scope: SOURCE.global })));

/**
 * The repository a terminal or workspace works in (the focused terminal's when neither is given).
 * @param {Tab | Workspace | undefined} [where]
 */
export const repoHere = where => (!where ? repoOfTab(focusedTab()) : 'wsId' in where ? repoOfTab(where) : repoAt(where.cwd));

/**
 * Every snippet that applies here: the repository's (its file's, then its .termilly.yml's), then this computer's.
 * @param {Tab | Workspace | undefined} [where] a terminal or a workspace; the focused terminal when not given
 */
export const allSnippets = where => [...repoSnippets(repoHere(where)), ...globalSnippets()];

/**
 * @param {string} name
 * @param {Tab | Workspace | undefined} [where]
 */
export const findSnippet = (name, where) => allSnippets(where).find(s => s.name.toLowerCase() === String(name).toLowerCase());

/** Where a snippet can go, for the run form: the focused terminal, the broadcast, or a tag. */
function targetOptions() {
  const tags = state.tags.filter(t => [...state.tabs.values()].some(x => x.tags.includes(t.name)));
  return [
    [TARGET.focused, 'This terminal'],
    ...(isBroadcasting() ? [[TARGET.broadcast, 'The broadcast’s terminals']] : []),
    ...tags.map(t => [`${TARGET.tagPrefix}${t.name}`, `Every terminal tagged ${t.name}`]),
  ];
}

/**
 * @param {string} where
 * @param {Tab | null} [tab]
 */
function targetsFor(where, tab = focusedTab()) {
  if (where === TARGET.broadcast && tab) return inputTargets(tab);
  if (where?.startsWith(TARGET.tagPrefix)) return [...state.tabs.values()].filter(t => t.tags.includes(where.slice(TARGET.tagPrefix.length)));
  return tab ? [tab] : [];
}

/**
 * Types a snippet into its targets (with Enter if the snippet says so). Production terminals ask first; returns
 * the terminals it went to, or null when nothing was sent.
 * @param {SnippetSetting} snippet
 * @param {Record<string, string>} values
 * @param {Tab[]} targets
 * @param {(tab: Tab) => void} [beforeSend] called for each terminal just before its text goes in
 */
export async function sendSnippet(snippet, values, targets, beforeSend) {
  const text = fill(snippet.command, values);
  const live = targets.filter(t => !t.exited);
  if (!live.length) return null;
  if (!(await confirmProduction(live, 'Run the snippet', text))) return null;
  // Each line ends with Enter, as typed: a bare \n is Ctrl+Enter to PSReadLine, which opens a line above, so the
  // lines would run in reverse.
  const data = `${text.replace(/\r?\n/g, '\r')}${snippet.enter === false ? '' : '\r'}`;
  for (const tab of live) {
    beforeSend?.(tab);
    send(PAGE.input, { id: tab.id, data });
  }
  return live;
}

/**
 * Notes that a snippet or task was run now, for the list's order (the most recent first).
 * @param {string} id
 */
export function markUsed(id) {
  updateSettings(GROUPS.data, { snippetUsed: { ...(state.settings.data.snippetUsed ?? {}), [id]: Date.now() } });
}

/**
 * Runs a snippet from the UI: asks for its placeholders and where it goes (when there's a choice), then sends.
 * `enter: false` types it without pressing Enter. Returns the terminals it went to, or null when it was cancelled.
 * @param {SnippetSetting} snippet
 * @param {{ tab?: Tab | null, where?: string, enter?: boolean }} [options]
 */
export async function runSnippet(snippet, { tab = focusedTab(), where, enter } = {}) {
  if (enter === false) snippet = { ...snippet, enter: false };
  const names = placeholders(snippet.command);
  const options = targetOptions();
  /** @type {Record<string, string>} */
  let values = {};
  if (names.length || (!where && options.length > 1)) {
    const answer = await askValues(snippet, names, options);
    if (!answer) return null;
    values = answer.values;
    where = answer.where;
  }
  markUsed(snippet.id);
  const sent = await sendSnippet(snippet, values, targetsFor(where ?? TARGET.focused, tab));
  if (sent?.length === 1) sent[0].view?.term.focus();
  return sent;
}

/**
 * Runs a snippet in one terminal (`snippet:name` at its prompt, snippetprompt.js), asking for its placeholders first.
 * @param {SnippetSetting} snippet
 * @param {Tab} tab
 */
export const runSnippetIn = (snippet, tab) => runSnippet(snippet, { tab, where: TARGET.focused });

/**
 * Where a snippet comes from, as the lists say it.
 * @param {Snippet} snippet
 */
export function scopeLabel(snippet) {
  if (snippet.scope === SOURCE.global) return 'this computer';
  if (snippet.scope === SOURCE.task) return 'VS Code task';
  if (snippet.scope === SOURCE.shared) return LAYOUT_FILE;
  return snippet.root?.split(/[\\/]/).filter(Boolean).pop() ?? 'this repo';
}

/**
 * A field of the run form: a placeholder's value, or a task input's (a list to pick from, a password, what it asks).
 * @param {Placeholder} p
 * @param {string | undefined} remembered
 * @param {TaskInput | undefined} input
 * @param {boolean} first
 * @param {boolean} [defaults] filled in with the default when there's no value (a schedule's aren't)
 */
function valueField(p, remembered, input, first, defaults = true) {
  const label = escapeHtml(input?.description || p.name);
  const value = remembered ?? (defaults ? input?.default ?? p.def : '');
  if (input?.options?.length) {
    return `<label class="dialog-field">${label}<select class="field" data-var="${escapeHtml(p.name)}">${input.options
      .map(o => `<option${o === value ? ' selected' : ''}>${escapeHtml(o)}</option>`).join('')}</select></label>`;
  }
  return `<label class="dialog-field">${label}
    <input class="field" data-var="${escapeHtml(p.name)}" type="${input?.password ? 'password' : 'text'}" value="${escapeHtml(value)}" spellcheck="false" ${first ? 'autofocus' : ''}></label>`;
}

/**
 * The run form: a field per placeholder (last values remembered, a password never) and where it goes.
 * @param {SnippetSetting} snippet
 * @param {Placeholder[]} names
 * @param {string[][]} options
 * @param {TaskInput[]} [inputs] a task's inputs, by their id
 * @param {ValuesForm} [form] how a schedule asks instead of a run
 * @returns {Promise<{ values: Record<string, string>, where: string } | null>}
 */
export function askValues(snippet, names, options, inputs = [], { given, ok, required = false } = {}) {
  /** @type {Record<string, string>} */
  const remembered = given ?? state.settings.data.snippetValues?.[snippet.id] ?? {};
  const inputOf = (/** @type {string} */ name) => inputs.find(i => i.id === name);
  const okLabel = ok ?? (snippet.enter === false ? 'Type it' : RUN_LABEL);
  return modal('snippet-run', `
    <h3>${escapeHtml(snippet.name)}</h3>
    <pre class="snippet-preview" data-preview></pre>
    ${names.map((p, i) => valueField(p, ownValue(remembered, p.name), inputOf(p.name), i === 0, !required)).join('')}
    ${options.length > 1 ? `<label class="dialog-field">Run in
      <select class="field" data-where>${options.map(([v, l]) => `<option value="${escapeHtml(v)}">${escapeHtml(l)}</option>`).join('')}</select></label>` : ''}
    <div class="dialog-actions">
      <button class="btn" data-cancel>Cancel</button>
      <button class="btn primary" data-ok ${names.length ? '' : 'autofocus'}>${escapeHtml(okLabel)}</button>
    </div>`, (dialog, close) => {
    const read = () => Object.fromEntries(/** @type {HTMLInputElement[]} */ ([...dialog.querySelectorAll('[data-var]')])
      .map(i => [/** @type {string} */ (i.dataset.var), i.value]));
    const okButton = /** @type {HTMLButtonElement} */ (find(dialog, '[data-ok]'));
    const blocked = () => required && unfilled(snippet.command, read()).length > 0;
    const preview = () => {
      find(dialog, '[data-preview]').textContent = fill(snippet.command, read());
      okButton.disabled = blocked();
    };
    dialog.addEventListener('input', preview);
    dialog.addEventListener('change', preview);
    preview();
    const submit = () => {
      if (blocked()) return;
      const values = read();
      // A schedule keeps its own values; a run remembers them for next time.
      if (!given) {
        const kept = Object.fromEntries(Object.entries(values).filter(([name]) => !inputOf(name)?.password));
        updateSettings(GROUPS.data, { snippetValues: { ...(state.settings.data.snippetValues ?? {}), [snippet.id]: kept } });
      }
      close({ values, where: /** @type {HTMLSelectElement | null} */ (dialog.querySelector('[data-where]'))?.value ?? TARGET.focused });
    };
    return { submit };
  });
}

// ---- Making and editing ----

const newSnippetId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Where a snippet can be kept: the repository the focused terminal is in (when it's in one), and this computer.
 * @param {Repo | null} repo
 * @returns {string[][]}
 */
export const whereOptions = repo => [
  ...(repo ? [[`${IN_REPO}${repo.root}`, `This repo (${repo.name}), ${REPO_FILE}`]] : []),
  [SOURCE.global, `${THIS_COMPUTER}, in every folder`],
];

/**
 * Where a snippet is kept now, as "Keep it in" says it.
 * @param {Snippet} s
 */
export const whereOf = s => (s.scope === SOURCE.repo && s.root ? `${IN_REPO}${s.root}` : SOURCE.global);

/**
 * "Keep it in" and "Only for me", for both editors.
 * @param {string} where
 * @param {Repo | null} repo
 */
export function whereHtml(where, repo) {
  return `<label class="dialog-field">Keep it in
      <select class="field" name="${SNIPPET_FIELD.where}">${whereOptions(repo).map(([v, l]) => `<option value="${escapeHtml(v)}"${v === where ? ' selected' : ''}>${escapeHtml(l)}</option>`).join('')}</select></label>
    ${repo ? `<label class="note-pin" data-only-me><input type="checkbox" name="${SNIPPET_FIELD.onlyMe}" ${repo.onlyMe ? 'checked' : ''}> Only for me (keep ${REPO_FILE} out of git)</label>` : ''}`;
}

/**
 * The editor for a new snippet ("Save as snippet", a search with no match): name, command, description, Enter, and
 * where it's kept (this repository first, when the focused terminal is in one).
 * @param {{ command?: string, where?: Tab }} [options] where: the terminal it came from; the focused one when not given
 */
export function editSnippet({ command = '', where } = {}) {
  const repo = repoHere(where);
  return modal('snippet-edit', `
    <h3>New snippet</h3>
    <label class="dialog-field">Name<input class="field" name="name" placeholder="Tail pod logs" autofocus></label>
    <label class="dialog-field">Command<textarea class="field snippet-command" name="command" rows="3" spellcheck="false" placeholder="kubectl logs -f {{pod}} -n {{namespace=default}}">${escapeHtml(command)}</textarea></label>
    <p class="dialog-sub">Write <code>{{name}}</code> for a value to ask for when it runs, <code>{{name=default}}</code> with a default. Don’t put secrets in a snippet.</p>
    <label class="dialog-field">Description<input class="field" name="description" placeholder="optional"></label>
    ${whereHtml(repo ? `${IN_REPO}${repo.root}` : SOURCE.global, repo)}
    <label class="note-pin"><input type="checkbox" name="enter" checked> Press Enter after it</label>
    <div class="dialog-actions">
      <span class="spacer"></span>
      <button class="btn" data-cancel>Cancel</button>
      <button class="btn primary" data-ok>Save</button>
    </div>`, (dialog, close) => {
    const field = (/** @type {string} */ name) => /** @type {HTMLInputElement} */ (dialog.querySelector(`[name="${name}"]`));
    const onlyMe = dialog.querySelector('[data-only-me]');
    const showOnlyMe = () => onlyMe?.toggleAttribute('hidden', !field(SNIPPET_FIELD.where).value.startsWith(IN_REPO));
    dialog.addEventListener('change', showOnlyMe);
    showOnlyMe();
    const save = () => {
      const next = readEditor(field, newSnippetId());
      if (!next) return;
      saveSnippet(next.id, next, field(SNIPPET_FIELD.where).value, { onlyMe: field(SNIPPET_FIELD.onlyMe)?.checked });
      close(true);
    };
    return { submit: save };
  });
}

/**
 * A snippet from an editor's fields (null without a command); the name falls back to the command's first words, and a
 * description left empty isn't kept.
 * @param {(name: string) => HTMLInputElement} field
 * @param {string} id
 * @returns {SnippetSetting | null}
 */
export function readEditor(field, id) {
  const command = field(SNIPPET_FIELD.command).value.trim();
  if (!command) return null;
  return /** @type {SnippetSetting} */ ({
    id, name: field(SNIPPET_FIELD.name).value.trim() || command.split(/\s+/).slice(0, NAME_WORDS).join(' '),
    command, description: field(SNIPPET_FIELD.description).value.trim() || undefined, enter: field(SNIPPET_FIELD.enter).checked,
  });
}

/**
 * The repository a saved snippet's id says it's in, or null for this computer's.
 * @param {string} id
 */
const rootOfId = id => (id.startsWith(`${SOURCE.repo}:`) ? id.slice(SOURCE.repo.length + 1).split('|')[0] : null);

/**
 * A list with a snippet put in its place (or at the end), or taken out when `next` is null.
 * @param {SnippetSetting[]} list
 * @param {string} id
 * @param {SnippetSetting | null} next
 */
function put(list, id, next) {
  const at = list.findIndex(x => x.id === id);
  if (!next) return list.filter(x => x.id !== id);
  return at < 0 ? [...list, next] : list.map(x => (x.id === id ? next : x));
}

/**
 * What a save did: the snippet's id now (a repository's snippet is known by its name), and whether it was written.
 * @typedef {{ id: string | null, ok: boolean }} Saved
 */

/**
 * Puts a snippet into this computer's (or takes it out, `next` null): in the state at once, for whoever draws the list
 * next; settings.js saves it a moment later.
 * @param {string} id
 * @param {SnippetSetting | null} next
 * @returns {Saved}
 */
function inComputer(id, next) {
  const snippets = put(state.settings.commands.snippets ?? [], id, next);
  state.settings.commands = { ...state.settings.commands, snippets };
  updateSettings(GROUPS.commands, { snippets });
  return { id: next?.id ?? null, ok: true };
}

/**
 * Puts a snippet into a repository's file (or takes it out, `next` null), and waits until it's written.
 * @param {string} root
 * @param {string} id
 * @param {SnippetSetting | null} next
 * @param {boolean} [onlyMe] keep the file out of git (as it was, when not given)
 * @returns {Promise<Saved>}
 */
async function inRepository(root, id, next, onlyMe) {
  const repo = repoAt(root) ?? await loadRepo(root);
  if (!repo) return { id: null, ok: false };
  const list = put(repo.snippets, id, next);
  const at = next ? list.indexOf(next) : -1;
  const error = await saveRepo(root, list, onlyMe ?? repo.onlyMe);
  if (error) {
    showToast({ text: `Couldn’t save ${REPO_FILE}: ${error}` });
    return { id: null, ok: false };
  }
  return { id: at >= 0 ? repo.snippets[at]?.id ?? null : null, ok: true };
}

/**
 * Saves a snippet by id where it's to be kept ('global', or IN_REPO and a repository's folder), taking it out of where
 * it was; deletes it when `next` is null. One that stays keeps its place in its list; one that moves goes to the end.
 * A move writes where it goes first, and takes it out of where it was only once that's written: a file that can't be
 * written leaves the snippet where it was, never nowhere.
 * @param {string} id
 * @param {SnippetSetting | null} next
 * @param {string} where
 * @param {{ onlyMe?: boolean }} [options] keep the repository's file out of git (as it was, when not given)
 * @returns {Promise<Saved>}
 */
export async function saveSnippet(id, next, where, { onlyMe } = {}) {
  const fromRoot = rootOfId(id);
  const toRoot = where.startsWith(IN_REPO) ? where.slice(IN_REPO.length) : null;
  // A repository's snippet moved to this computer gets an id of its own (a repository's is its name).
  if (next && !toRoot && fromRoot) next = { ...next, id: newSnippetId() };
  let saved = /** @type {Saved} */ ({ id: null, ok: true });
  if (next) saved = toRoot ? await inRepository(toRoot, id, next, onlyMe) : inComputer(id, next);
  // Out of where it was: deleted, or moved and now written where it went.
  if (saved.ok && (!next || fromRoot !== toRoot)) {
    if (fromRoot) await inRepository(fromRoot, id, null);
    else if ((state.settings.commands.snippets ?? []).some(x => x.id === id)) inComputer(id, null);
  }
  persist();
  emit(EVENTS.snippets);
  return saved;
}

export { newSnippetId };

/**
 * "Save as snippet" from a command that ran, or text selected in a terminal.
 * @param {string} command
 * @param {Tab} [where] the terminal it came from; the focused one when not given
 */
export const saveAsSnippet = (command, where) => editSnippet({ command, where });

/**
 * Snippets that belonged to a workspace (before repositories kept them) go to the repository its folder is in, or to
 * this computer's when it's in none; one of the same name already there isn't copied (a .termilly.yml's were copied
 * into its workspace, and are read from the file now). One that couldn't be written stays with its workspace, for the
 * next start.
 */
export async function moveWorkspaceSnippets() {
  for (const ws of state.workspaces.filter(w => w.snippets?.length)) {
    const old = /** @type {SnippetSetting[]} */ (ws.snippets);
    const repo = await loadRepo(ws.cwd);
    const have = new Set((repo ? repoSnippets(repo) : globalSnippets()).map(s => s.name.toLowerCase()));
    const where = repo ? `${IN_REPO}${repo.root}` : SOURCE.global;
    /** @type {SnippetSetting[]} */
    const left = [];
    for (const s of old.filter(x => !have.has(x.name.toLowerCase()))) {
      const copy = { ...s, id: newSnippetId() };
      if (!(await saveSnippet(copy.id, copy, where)).ok) left.push(s);
    }
    if (left.length) ws.snippets = left;
    else delete ws.snippets;
    persist();
  }
}

// ---- The palette, scripts and agents ----

/** Palette entries: one per snippet and task here, run in the focused terminal (a task in a new one). */
export const snippetCommands = () => allSnippets().map(s => ({
  label: `Snippet: ${s.name}`, keywords: `run saved command ${s.command} ${s.description ?? ''}`, hint: scopeLabel(s),
  run: () => setTimeout(() => runSnippet(s)),
}));

/** The snippets for `termilly snippet list` and the MCP server. */
export const listForApi = () => allSnippets().map(s => ({ name: s.name, command: s.command, description: s.description ?? null, variables: placeholders(s.command), scope: s.scope }));

/**
 * Runs a snippet by name in a terminal for the API; every placeholder needs a value or a default.
 * @param {{ name: string, tab: Tab, vars?: Record<string, string> | null, beforeSend?: (tab: Tab) => void }} request
 */
export async function runForApi({ name, tab, vars, beforeSend }) {
  await loadRepo(folderOfTab(tab));
  const snippet = findSnippet(name, tab);
  if (!snippet) throw new Error(`No snippet named ${name}.`);
  const missing = missingValues(snippet.command, vars);
  if (missing.length) throw new Error(`The snippet needs values for: ${missing.join(', ')}.`);
  const sent = await sendSnippet(snippet, vars ?? {}, [tab], beforeSend);
  if (!sent) throw new Error(`Terminal ${tab.id} is on production, and the user said no.`);
  return { id: tab.id, command: fill(snippet.command, vars ?? {}) };
}
