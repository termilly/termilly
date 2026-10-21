// @ts-check
// Snippets: saved commands with {{placeholders}}, run in one terminal, the broadcast's terminals or every terminal
// with a tag. They're global (Settings), or belong to a workspace, which a project's .termilly.yml can fill
// (`snippets:`) so a team shares them in git. Placeholders are asked for in a small form that remembers the last
// values; `{{namespace=default}}` has a default. Production terminals ask first (environments.js).

import { PAGE } from './protocol.js';
import { send } from './host.js';
import { state, emit, persist, wsById, GROUPS, EVENTS } from './store.js';
import { modal } from './dialogs.js';
import { escapeHtml } from './ui.js';
import { focusedTab } from './panes.js';
import { isBroadcasting, inputTargets } from './broadcast.js';
import { confirmProduction } from './environments.js';
import { fuzzyMatch } from './fuzzy.js';
import { updateSettings } from './preferences.js';
import { find, targetOf } from './dom.js';

/**
 * A snippet as the lists show it: a saved one, with where it's kept ('global', 'workspace', or what a project's
 * file says) and, for a workspace's, that workspace's id.
 * @typedef {SnippetSetting & { scope?: string, wsId?: string }} Snippet
 */

/** @typedef {{ name: string, def: string }} Placeholder */

const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w.-]*)\s*(?:=([^}]*))?\}\}/g;

/** Where a snippet is kept: in Settings for every workspace, or in a workspace (a project's file can name others). */
export const SNIPPET_SCOPE = Object.freeze({ global: 'global', workspace: 'workspace' });
/** Where the run form can send a snippet: the focused terminal, the broadcast, or "tag:" and a tag's name. */
const TARGET = Object.freeze({ focused: 'focused', broadcast: 'broadcast', tagPrefix: 'tag:' });
/** The editors' fields, by their name attribute (a saved snippet's properties). */
export const SNIPPET_FIELD = Object.freeze({
  name: 'name', command: 'command', description: 'description', enter: 'enter',
});
/** A snippet saved without a name is named after this many words of its command. */
export const NAME_WORDS = 3;
/** The button that runs a snippet (one that doesn't press Enter says "Type it"). */
export const RUN_LABEL = 'Run';

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
  String(command).replace(PLACEHOLDER, (_, name, def) => values?.[name] ?? def ?? '');

/**
 * Every snippet that applies here: the workspace's (and its project's), then the global ones.
 * @param {Workspace | undefined} [ws]
 */
export function allSnippets(ws = wsById(state.activeId)) {
  // A workspace's snippets are there only when the workspace is.
  const own = /** @type {Snippet[]} */ (ws?.snippets ?? [])
    .map(s => ({ ...s, scope: s.scope ?? SNIPPET_SCOPE.workspace, wsId: /** @type {Workspace} */ (ws).id }));
  return [...own, ...(state.settings.commands.snippets ?? []).map(s => ({ ...s, scope: SNIPPET_SCOPE.global }))];
}

/**
 * @param {string} name
 * @param {Workspace | undefined} [ws]
 */
export const findSnippet = (name, ws) => allSnippets(ws).find(s => s.name.toLowerCase() === String(name).toLowerCase());

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
 * @param {Snippet} snippet
 * @param {Record<string, string>} values
 * @param {Tab[]} targets
 */
export async function sendSnippet(snippet, values, targets) {
  const text = fill(snippet.command, values);
  const live = targets.filter(t => !t.exited);
  if (!live.length) return null;
  if (!(await confirmProduction(live, 'Run the snippet', text))) return null;
  for (const tab of live) send(PAGE.input, { id: tab.id, data: `${text}${snippet.enter === false ? '' : '\r'}` });
  return live;
}

/**
 * Runs a snippet from the UI: asks for its placeholders and where it goes (when there's a choice), then sends.
 * @param {Snippet} snippet
 * @param {{ tab?: Tab | null, where?: string }} [options]
 */
export async function runSnippet(snippet, { tab = focusedTab(), where } = {}) {
  const names = placeholders(snippet.command);
  const options = targetOptions();
  /** @type {Record<string, string>} */
  let values = {};
  if (names.length || (!where && options.length > 1)) {
    const answer = await askValues(snippet, names, options);
    if (!answer) return;
    values = answer.values;
    where = answer.where;
  }
  const sent = await sendSnippet(snippet, values, targetsFor(where ?? TARGET.focused, tab));
  if (sent?.length === 1) sent[0].view?.term.focus();
}

/**
 * Runs a snippet in one terminal (`snippet:name` at its prompt, snippetprompt.js), asking for its placeholders first.
 * @param {Snippet} snippet
 * @param {Tab} tab
 */
export const runSnippetIn = (snippet, tab) => runSnippet(snippet, { tab, where: TARGET.focused });

/**
 * Where a snippet is kept, as the lists say it.
 * @param {Snippet} snippet
 */
export const scopeLabel = snippet => (snippet.scope === SNIPPET_SCOPE.global ? 'all workspaces' : 'this workspace');

/**
 * The run form: a field per placeholder (last values remembered) and where it goes.
 * @param {Snippet} snippet
 * @param {Placeholder[]} names
 * @param {string[][]} options
 * @returns {Promise<{ values: Record<string, string>, where: string } | null>}
 */
function askValues(snippet, names, options) {
  /** @type {Record<string, string>} */
  const remembered = state.settings.data.snippetValues?.[snippet.id] ?? {};
  return modal('snippet-run', `
    <h3>${escapeHtml(snippet.name)}</h3>
    <pre class="snippet-preview" data-preview></pre>
    ${names.map((p, i) => `
      <label class="dialog-field">${escapeHtml(p.name)}
        <input class="field" data-var="${escapeHtml(p.name)}" value="${escapeHtml(remembered[p.name] ?? p.def)}" spellcheck="false" ${i === 0 ? 'autofocus' : ''}>
      </label>`).join('')}
    ${options.length > 1 ? `<label class="dialog-field">Run in
      <select class="field" data-where>${options.map(([v, l]) => `<option value="${escapeHtml(v)}">${escapeHtml(l)}</option>`).join('')}</select></label>` : ''}
    <div class="dialog-actions">
      <button class="btn" data-cancel>Cancel</button>
      <button class="btn primary" data-ok ${names.length ? '' : 'autofocus'}>${snippet.enter === false ? 'Type it' : RUN_LABEL}</button>
    </div>`, (dialog, close) => {
    const read = () => Object.fromEntries(/** @type {HTMLInputElement[]} */ ([...dialog.querySelectorAll('[data-var]')])
      .map(i => [/** @type {string} */ (i.dataset.var), i.value]));
    const preview = () => { find(dialog, '[data-preview]').textContent = fill(snippet.command, read()); };
    dialog.addEventListener('input', preview);
    preview();
    const submit = () => {
      const values = read();
      updateSettings(GROUPS.data, { snippetValues: { ...(state.settings.data.snippetValues ?? {}), [snippet.id]: values } });
      close({ values, where: /** @type {HTMLSelectElement | null} */ (dialog.querySelector('[data-where]'))?.value ?? TARGET.focused });
    };
    return { submit };
  });
}

// ---- Making and editing ----

const newSnippetId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * The editor: name, command, description, Enter, and whether it's global or this workspace's.
 * @param {Snippet | null} [snippet]
 * @param {{ command?: string }} [options]
 */
export function editSnippet(snippet = null, { command = '' } = {}) {
  /** @type {Snippet} */
  const s = snippet ?? { id: newSnippetId(), name: '', command, description: '', enter: true, scope: SNIPPET_SCOPE.global };
  const ws = wsById(s.wsId ?? state.activeId);
  return modal('snippet-edit', `
    <h3>${snippet ? 'Edit snippet' : 'New snippet'}</h3>
    <label class="dialog-field">Name<input class="field" name="name" value="${escapeHtml(s.name)}" placeholder="Tail pod logs" ${snippet ? '' : 'autofocus'}></label>
    <label class="dialog-field">Command<textarea class="field snippet-command" name="command" rows="3" spellcheck="false" placeholder="kubectl logs -f {{pod}} -n {{namespace=default}}">${escapeHtml(s.command)}</textarea></label>
    <p class="dialog-sub">Write <code>{{name}}</code> for a value to ask for when it runs, <code>{{name=default}}</code> with a default. Don’t put secrets in a snippet.</p>
    <label class="dialog-field">Description<input class="field" name="description" value="${escapeHtml(s.description ?? '')}" placeholder="optional"></label>
    <label class="dialog-field">Keep it in
      <select class="field" name="scope">
        <option value="${SNIPPET_SCOPE.global}"${s.scope === SNIPPET_SCOPE.global ? ' selected' : ''}>All workspaces</option>
        <option value="${SNIPPET_SCOPE.workspace}"${s.scope !== SNIPPET_SCOPE.global ? ' selected' : ''}>${escapeHtml(ws?.name ?? 'This workspace')} (saved in its layout file too)</option>
      </select></label>
    <label class="note-pin"><input type="checkbox" name="enter" ${s.enter === false ? '' : 'checked'}> Press Enter after it</label>
    <div class="dialog-actions">
      ${snippet ? '<button class="btn" data-delete>Delete</button>' : ''}
      <span class="spacer"></span>
      <button class="btn" data-cancel>Cancel</button>
      <button class="btn primary" data-ok>Save</button>
    </div>`, (dialog, close) => {
    /**
     * The form's field by its name; the inputs, textarea and select all have a value.
     * @param {string} name
     */
    const field = name => /** @type {HTMLInputElement} */ (dialog.querySelector(`[name="${name}"]`));
    if (snippet) setTimeout(() => field(SNIPPET_FIELD.command).focus());
    const save = () => {
      // Saved as it is: a description left empty isn't kept (undefined isn't written).
      const command = field(SNIPPET_FIELD.command).value.trim();
      const next = /** @type {SnippetSetting} */ ({
        id: s.id, name: field(SNIPPET_FIELD.name).value.trim() || command.split(/\s+/).slice(0, NAME_WORDS).join(' '),
        command, description: field(SNIPPET_FIELD.description).value.trim() || undefined, enter: field(SNIPPET_FIELD.enter).checked,
      });
      if (!next.command) return;
      store(s, next, field('scope').value);
      close(true);
    };
    dialog.querySelector('[data-delete]')?.addEventListener('click', () => { store(s, null, s.scope); close(true); });
    return { submit: save };
  });
}

/**
 * Saves (or with `next` null, deletes) a snippet where it belongs, taking it out of where it was.
 * @param {Snippet} old
 * @param {SnippetSetting | null} next
 * @param {string | undefined} scope
 */
function store(old, next, scope) {
  saveSnippet(old.id, next, scope === SNIPPET_SCOPE.global ? SNIPPET_SCOPE.global : old.wsId ?? state.activeId);
}

/**
 * Saves a snippet by id in `where` ('global' or a workspace's id), or deletes it when `next` is null. A snippet
 * that stays where it was keeps its place in the list; one that moves goes to the end of its new list.
 * @param {string} id
 * @param {SnippetSetting | null} next
 * @param {string | null} where
 */
export function saveSnippet(id, next, where) {
  /** @param {SnippetSetting[] | null | undefined} list */
  const put = list => {
    list = list ?? [];
    const at = list.findIndex(x => x.id === id);
    if (!next) return at < 0 ? list : list.filter(x => x.id !== id);
    return at < 0 ? [...list, next] : list.map(x => (x.id === id ? next : x));
  };
  /** @param {SnippetSetting[] | null | undefined} list */
  const take = list => (list ?? []).filter(x => x.id !== id);
  const global = where === SNIPPET_SCOPE.global ? put(state.settings.commands.snippets) : take(state.settings.commands.snippets);
  for (const ws of state.workspaces) {
    if (ws.id === where) ws.snippets = put(ws.snippets);
    else if (ws.snippets?.some(x => x.id === id)) ws.snippets = take(ws.snippets);
  }
  // In the state at once, for whoever draws the list next; settings.js saves it a moment later.
  state.settings.commands = { ...state.settings.commands, snippets: global };
  updateSettings(GROUPS.commands, { snippets: global });
  persist();
  emit(EVENTS.snippets);
}

export { newSnippetId };

/**
 * "Save as snippet" from a command that ran.
 * @param {string} command
 */
export const saveAsSnippet = command => editSnippet(null, { command });

// ---- The snippets list ----

/**
 * The snippets window (js/snippetswindow.js), where they're made and changed.
 * @param {{ create?: boolean, id?: string }} options
 */
const manage = options => setTimeout(() => emit(EVENTS.openSnippets, options));

/** Every snippet, searchable: Enter or Run runs it, Edit and New open the snippets window. */
export function openSnippets() {
  return modal('snippet-list', `
    <h3>Snippets</h3>
    <input class="field" data-search placeholder="Search snippets" spellcheck="false" autofocus>
    <div class="snippet-items" data-items></div>
    <div class="dialog-actions">
      <button class="btn" data-new>New snippet</button>
      <span class="spacer"></span>
      <button class="btn" data-cancel>Close</button>
    </div>`, (dialog, close) => {
    /** @type {Snippet[]} */
    let shown = [];
    let selected = 0;
    const render = () => {
      const q = /** @type {HTMLInputElement} */ (dialog.querySelector('[data-search]')).value.trim();
      shown = allSnippets().filter(s => !q || fuzzyMatch(q, `${s.name} ${s.command} ${s.description ?? ''}`));
      selected = Math.min(selected, Math.max(0, shown.length - 1));
      find(dialog, '[data-items]').innerHTML = shown.length ? shown.map((s, i) => `
        <div class="snippet-item${i === selected ? ' on' : ''}" data-i="${i}">
          <div class="snippet-text"><div class="snippet-name">${escapeHtml(s.name)}<span class="snippet-scope">${scopeLabel(s)}</span></div>
            <code class="snippet-cmd">${escapeHtml(s.command)}</code>${s.description ? `<div class="set-desc">${escapeHtml(s.description)}</div>` : ''}</div>
          <button class="btn small" data-edit="${i}">Edit</button>
          <button class="btn small primary" data-run="${i}">Run</button>
        </div>`).join('')
        : `<p class="set-desc snippet-empty">${q ? 'No snippet matches.' : 'No snippets yet. Make one, or use “Save as snippet” in a terminal’s menu.'}</p>`;
    };
    /** @param {number} i */
    const run = i => { const s = shown[i]; if (s) { close(true); setTimeout(() => runSnippet(s)); } };
    dialog.addEventListener('input', render);
    dialog.addEventListener('click', e => {
      const t = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-run], [data-edit], .snippet-item'));
      if (targetOf(e).closest('[data-new]')) { close(true); manage({ create: true }); return; }
      if (!t) return;
      if (t.dataset.edit) { const s = shown[Number(t.dataset.edit)]; close(true); manage({ id: s.id }); return; }
      run(Number(t.dataset.run ?? t.dataset.i));
    });
    dialog.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        selected = Math.max(0, Math.min(shown.length - 1, selected + (e.key === 'ArrowDown' ? 1 : -1)));
        render();
      }
    });
    render();
    return { submit: () => run(selected) };
  });
}

/** Palette entries: one per snippet, run in the focused terminal. */
export const snippetCommands = () => allSnippets().map(s => ({
  label: `Snippet: ${s.name}`, keywords: `run saved command ${s.command} ${s.description ?? ''}`, hint: s.scope === SNIPPET_SCOPE.global ? '' : SNIPPET_SCOPE.workspace,
  run: () => setTimeout(() => runSnippet(s)),
}));

// ---- From scripts and agents (api.js) ----

/** The snippets for `termilly snippet list` and the MCP server. */
export const listForApi = () => allSnippets().map(s => ({ name: s.name, command: s.command, description: s.description ?? null, variables: placeholders(s.command), scope: s.scope }));

/**
 * Runs a snippet by name in a terminal for the API; every placeholder needs a value or a default.
 * @param {{ name: string, tab: Tab, vars?: Record<string, string> | null }} request
 */
export async function runForApi({ name, tab, vars }) {
  const snippet = findSnippet(name, wsById(tab.wsId));
  if (!snippet) throw new Error(`No snippet named ${name}.`);
  const missing = placeholders(snippet.command).filter(p => !p.def && !(vars && p.name in vars)).map(p => p.name);
  if (missing.length) throw new Error(`The snippet needs values for: ${missing.join(', ')}.`);
  const sent = await sendSnippet(snippet, vars ?? {}, [tab]);
  if (!sent) throw new Error(`Terminal ${tab.id} is on production, and the user said no.`);
  return { id: tab.id, command: fill(snippet.command, vars ?? {}) };
}
