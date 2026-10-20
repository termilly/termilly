// @ts-check
// Workspaces as files (WorkspaceLayout.cs on the host): export a workspace's terminals, splits, names, tags,
// shells, folders, start commands and variables to YAML; import one as a new workspace; and offer a project's own
// .termilly.yml when a workspace opens in its folder.

import { PAGE, HOST } from './protocol.js';
import { send, onHost, request, platform, PLATFORM } from './host.js';
import { state, emit, persist, tabsOf, defaultProfile, withoutPreview, EVENTS, NODE, SPLIT_EVEN } from './store.js';
import { createWorkspace, freeName, DEFAULT_WORKSPACE_NAME, START_WITH } from './workspaces.js';
import { createTab, closeTab, renderWorkspace, focusTab, switchWorkspace } from './panes.js';
import { modal, CONFIRM_DIALOG } from './dialogs.js';
import { escapeHtml } from './ui.js';

/** A split's ratio in a layout file is rounded to this fraction (three decimals). */
const RATIO_STEPS = 1000;


/**
 * A terminal in a layout file.
 * @typedef {{ name?: string, profile?: string, tags?: string[], note?: string, cwd?: string, command?: string,
 *   env?: Record<string, string> }} LayoutTerminal
 */
/**
 * A part of a layout file's tree: a terminal, tabs (`active`: the index shown) or a split of two panes.
 * @typedef {{ terminal?: LayoutTerminal, tabs?: LayoutPane[], active?: number, split?: 'row' | 'column',
 *   ratio?: number, panes?: LayoutPane[] }} LayoutPane
 */
/**
 * A layout file (WorkspaceLayout.cs): the workspace and its tree.
 * @typedef {{ version?: number, name?: string, color?: string, cwd?: string, notes?: string,
 *   snippets?: { name: string, command: string, description: string | null, enter?: boolean }[],
 *   layout: LayoutPane | null }} LayoutFile
 */
/**
 * A folder's .termilly.yml, as the host found it.
 * @typedef {{ layout: LayoutFile, warnings?: string[], path?: string | null }} FoundLayout
 */

/**
 * The layout of a workspace, in the file's shape (see WorkspaceLayout.cs).
 * @param {Workspace} ws
 * @returns {LayoutFile}
 */
export function layoutOf(ws) {
  /**
   * @param {LayoutNode | null} n
   * @returns {LayoutPane | null}
   */
  const node = n => {
    if (!n) return null;
    if (n.kind === NODE.leaf) {
      const tab = /** @type {Tab} */ (state.tabs.get(n.tabId));
      /** @type {LayoutTerminal} */
      const terminal = { name: tab.name || undefined, profile: tab.profile, tags: tab.tags.length ? tab.tags : undefined, note: tab.note?.text || undefined };
      const cwd = tab.startCwd ?? tab.cwd;
      if (cwd && cwd !== ws.cwd) terminal.cwd = relativeTo(ws.cwd, cwd);
      if (tab.startCommand) terminal.command = tab.startCommand;
      if (tab.env && Object.keys(tab.env).length) terminal.env = tab.env;
      return { terminal };
    }
    if (n.kind === NODE.tabs) return { tabs: /** @type {LayoutPane[]} */ (n.items.map(node)), active: Math.max(0, n.items.findIndex(i => i.tabId === n.active)) };
    // A split (the preview was taken out by withoutPreview), whose two sides are always there.
    return { split: /** @type {SplitNode} */ (n).dir, ratio: Math.round(/** @type {SplitNode} */ (n).ratio * RATIO_STEPS) / RATIO_STEPS,
      panes: /** @type {LayoutPane[]} */ ([node(/** @type {SplitNode} */ (n).a), node(/** @type {SplitNode} */ (n).b)]) };
  };
  return { version: 1, name: ws.name, color: ws.color, cwd: ws.cwd ?? undefined, notes: ws.note?.text || undefined,
    snippets: ws.snippets?.length ? ws.snippets.map(({ name, command, description, enter }) => ({ name, command, description, enter: enter === false ? false : undefined })) : undefined,
    layout: node(withoutPreview(ws.root)) };
}

/**
 * A folder inside the workspace's as "./sub" (so the file works in another checkout), anything else as is. Windows
 * paths compare without case; Linux paths with it.
 * @param {string | null} base
 * @param {string} dir
 */
function relativeTo(base, dir) {
  if (!base) return dir;
  const prefix = base.replace(/[\\/]+$/, '') + (platform === PLATFORM.linux ? '/' : '\\');
  const inside = platform === PLATFORM.linux ? dir.startsWith(prefix) : dir.toLowerCase().startsWith(prefix.toLowerCase());
  return inside ? `./${dir.slice(prefix.length).replace(/\\/g, '/')}` : dir;
}

/** @param {Workspace | null | undefined} ws */
export function exportLayout(ws) {
  if (!ws?.root) return;
  send(PAGE.layoutExport, { name: ws.name, layout: JSON.parse(JSON.stringify(layoutOf(ws))) });
}

export const importLayout = () => send(PAGE.layoutImport);

/**
 * A profile by id or name (as a layout file may say "pwsh" or "PowerShell"), else the default shell.
 * @param {string | undefined} wanted
 */
function profileFor(wanted) {
  if (!wanted) return defaultProfile();
  const key = String(wanted).toLowerCase();
  return state.profiles.find(p => p.id.toLowerCase() === key || p.name.toLowerCase() === key)?.id ?? defaultProfile();
}

/**
 * Opens a layout: as a new workspace, or into `into` (whose terminals it replaces). Each terminal starts in its
 * folder with its variables, and its command is typed at its first prompt.
 * @param {LayoutFile} layout
 * @param {{ into?: Workspace | null, warnings?: string[] }} [options]
 */
export function applyLayout(layout, { into = null, warnings = [] } = {}) {
  const ws = /** @type {Workspace} */ (into ?? createWorkspace({ name: freeName(layout.name ?? DEFAULT_WORKSPACE_NAME), color: layout.color, cwd: layout.cwd, startWith: START_WITH.empty }));
  if (into) {
    for (const tab of tabsOf(ws)) {
      tab.noHistory = true; // replaced at once: not worth a "recently closed" entry
      closeTab(tab);
    }
    if (layout.cwd) ws.cwd = layout.cwd;
  }
  // A team's notes on the project (.termilly.yml notes:), pinned so everyone sees them.
  if (layout.notes) ws.note = { text: layout.notes, pinned: true };
  // The project's snippets (.termilly.yml snippets:) belong to the workspace.
  if (layout.snippets?.length) ws.snippets = /** @type {SnippetSetting[]} */ (layout.snippets.map((s, i) => ({ id: `y${i}${Date.now().toString(36)}`, ...s })));
  /** @type {Tab[]} */
  const tabs = [];
  /**
   * @param {LayoutPane} node
   * @returns {LayoutNode}
   */
  const build = node => {
    if (node.terminal) {
      const t = node.terminal;
      const tab = createTab({
        wsId: ws.id, profile: profileFor(t.profile), name: t.name ?? null, tags: t.tags ?? [],
        cwd: t.cwd ?? null, env: t.env ?? null, command: t.command ?? null, note: t.note ? { text: t.note, pinned: false } : null,
      });
      tabs.push(tab);
      return { kind: NODE.leaf, tabId: tab.id };
    }
    if (node.tabs) {
      const items = /** @type {LeafNode[]} */ (node.tabs.map(build)); // a file's tabs are terminals
      return { kind: NODE.tabs, items, active: (items[/** @type {number} */ (node.active)] ?? items[0]).tabId };
    }
    return { kind: NODE.split, dir: /** @type {'row' | 'column'} */ (node.split), ratio: node.ratio ?? SPLIT_EVEN,
      a: build(/** @type {LayoutPane[]} */ (node.panes)[0]), b: build(/** @type {LayoutPane[]} */ (node.panes)[1]) };
  };
  ws.root = build(/** @type {LayoutPane} */ (layout.layout));
  ws.focusId = tabs[0]?.id ?? null;
  if (ws.id !== state.activeId) switchWorkspace(ws.id);
  renderWorkspace(ws);
  if (tabs[0]) focusTab(tabs[0]);
  emit(EVENTS.workspaces);
  persist();
  if (warnings.length) showWarnings('Opened with a few things skipped', warnings);
  return ws;
}

/**
 * @param {string} title
 * @param {string[]} warnings
 */
function showWarnings(title, warnings) {
  modal('layout-warnings', `
    <h3>${escapeHtml(title)}</h3>
    <ul class="layout-warnings">${warnings.slice(0, 12).map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
    <div class="dialog-actions"><button class="btn primary" data-ok autofocus>OK</button></div>`, (dialog, close) => {
    return { submit: () => close(true) };
  });
}

/**
 * @param {LayoutPane | null | undefined} node
 * @returns {number}
 */
const countTerminals = node => (node?.terminal ? 1 : (node?.panes ?? []).reduce((n, p) => n + countTerminals(p), 0));

/**
 * Asks whether to open a folder's .termilly.yml; resolves true to use it.
 * @param {FoundLayout} found
 */
export function offerLayout(found) {
  const n = countTerminals(found.layout.layout);
  return modal(CONFIRM_DIALOG, `
    <h3>Open the project layout?</h3>
    <p class="dialog-sub">This folder has a ${escapeHtml(found.path?.split(/[\\/]/).pop() ?? '.termilly.yml')} with ${n} terminal${n === 1 ? '' : 's'}${found.layout.name ? ` (“${escapeHtml(found.layout.name)}”)` : ''}. Their start commands run when they open.</p>
    <div class="dialog-actions">
      <button class="btn" data-cancel>Just one terminal</button>
      <button class="btn primary" data-ok autofocus>Open layout</button>
    </div>`, (dialog, close) => {
    return { submit: () => close(true) };
  }).then(answer => answer === true);
}

/**
 * Looks for .termilly.yml in a folder: resolves { layout, warnings, path }, or null when there's none.
 * @param {string | null | undefined} dir
 * @returns {Promise<FoundLayout | null>}
 */
export function probeFolder(dir) {
  if (!dir) return Promise.resolve(null);
  return request(PAGE.layoutProbe, { dir }).then(m => (m.layout ? m : null));
}

// "Import a workspace layout" picked a file.
onHost(HOST.layout, m => {
  if (m.layout) applyLayout(m.layout, { warnings: m.warnings ?? [] });
  else showWarnings('That file couldn’t be opened as a layout', m.warnings?.length ? m.warnings : ['It has no terminals in it.']);
});
onHost(HOST.layoutError, m => showWarnings('The layout wasn’t saved', [m.message]));
