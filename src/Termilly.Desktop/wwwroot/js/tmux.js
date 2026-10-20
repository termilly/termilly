// @ts-check
// A server's tmux (or WSL's) as Termilly terminals, like iTerm2's tmux -CC integration: "Attach tmux" runs tmux in
// control mode on the host (TmuxClient.cs) and each tmux window becomes a workspace laid out as tmux lays it out,
// each pane a Termilly terminal with Termilly's search, history and triggers. Typing goes back with send-keys, the
// size with refresh-client, and closing the workspace detaches: tmux keeps running on the server.

import { PAGE, HOST } from './protocol.js';
import { send, onHost, platform, PLATFORM } from './host.js';
import {
  state, emit, persist, newId, tabsOf, wsById, defaultProfile, isSshProfile, EVENTS, on, NODE, SPLIT,
} from './store.js';
import { createWorkspace, closeWorkspace, START_WITH } from './workspaces.js';
import { createTab, renderWorkspace, switchWorkspace, closeTab } from './panes.js';
import { setVirtualInput } from './terminals.js';
import { modal, confirmDialog } from './dialogs.js';
import { escapeHtml } from './ui.js';
import { debounce } from './util.js';
import { ControlParser, parseLayout, panesOf, sendKeysCommands, NOTIFICATION } from './tmuxcontrol.js';
import { PROFILE_SOURCE } from './constants.js';
import { find, field, WORKSPACE_ID } from './dom.js';

/** @typedef {import('./tmuxcontrol.js').TmuxLayout} TmuxLayout */
/** @typedef {import('./tmuxcontrol.js').AnswerCallback} AnswerCallback */

/**
 * A tmux window shown as a workspace: the workspace, tmux's layout of it, and its name.
 * @typedef {{ wsId: string, layout?: TmuxLayout, name?: string }} TmuxWindow
 */

/**
 * tmux:exit, with or without its error.
 * @typedef {{ id: string, code: number, error?: string }} TmuxExit
 */

/**
 * A pane terminal's view: its fit add-on is swapped for one that does nothing once (fitHeld), as tmux sizes it.
 * @typedef {TabView & { fitHeld?: boolean }} HeldView
 */

/** A new pane's terminal is filled with tmux's screen once it has had a moment to open. */
const FILL_AFTER_MS = 50;
/** How long after starting the client its windows are read (tmux's first answers have come by then). */
const SYNC_AFTER_MS = 600;
/** How long after tmux adds a window the windows are read again. */
const RESYNC_AFTER_MS = 50;
/** How long after detach-client the host stops the client (tmux has detached by then). */
const STOP_AFTER_MS = 1500;
/** The smallest client size tmux is given, in cells. */
const MIN_COLS = 20;
const MIN_ROWS = 5;
/** What the workspace's area loses to its edges before it's cells, in pixels. */
const AREA_MARGIN_PX = 40;
/** A cell's size before a terminal has measured one, in pixels. */
const FALLBACK_CELL_WIDTH_PX = 8.4;
const FALLBACK_CELL_HEIGHT_PX = 17;
/** A virtual terminal's kind (tab.virtual), and the name a tmux client, window or pane goes by without its own. */
const TMUX = 'tmux';
/** The session attached when none is given. */
const DEFAULT_SESSION = 'main';
/** The Attach dialog's "Where" choice for a command typed in. */
const CUSTOM_CHOICE = 'custom';
/** Why a client ended when the host's tmux process exits. */
const DETACHED_REASON = 'detached';

/**
 * The attached tmux clients, by id.
 * @type {Map<string, TmuxSession>}
 */
const clients = new Map();

class TmuxSession {
  /**
   * @param {string} command
   * @param {string} label
   */
  constructor(command, label) {
    this.id = newId('x');
    this.commandLine = command;
    this.label = label;
    /** @type {Map<string, TmuxWindow>} */
    this.windows = new Map(); // @id → { wsId, layout, name }
    /** @type {Map<string, Tab>} */
    this.panes = new Map(); // %id → tab
    this.parser = new ControlParser({ onNotification: (name, args, line) => this.notify(name, args, line) });
    this.started = false;
  }

  start() {
    clients.set(this.id, this);
    send(PAGE.tmuxStart, { id: this.id, command: this.commandLine });
    // The first answers: the session's windows and their layouts.
    setTimeout(() => this.sync(), SYNC_AFTER_MS);
  }

  /**
   * Sends a tmux command; `then(lines, error)` gets its answer.
   * @param {string} text
   * @param {AnswerCallback} [then]
   */
  command(text, then = () => {}) {
    this.parser.expect(then);
    send(PAGE.tmuxWrite, { id: this.id, text });
  }

  /** Reads every window and its layout, and lays them out. */
  sync() {
    this.command('list-windows -F "#{window_id} #{window_name} #{window_layout}"', (lines, error) => {
      if (error) return;
      this.started = true;
      this.resizeClient();
      for (const line of lines) {
        const [id, name, layout] = line.split(' ');
        if (id?.startsWith('@')) this.layoutWindow(id, name, layout);
      }
    });
  }

  /**
   * A tmux window as a workspace: its panes as terminals, split as tmux has them.
   * @param {string} windowId
   * @param {string | undefined} name
   * @param {string} layoutText
   */
  layoutWindow(windowId, name, layoutText) {
    const tree = parseLayout(layoutText);
    const win = this.windowFor(windowId, name);
    win.layout = tree;
    if (name) win.name = name;
    const ws = wsById(win.wsId);
    if (!ws) return;
    this.closeGonePanes(ws, new Set(panesOf(tree).map(n => `%${n}`)));
    ws.root = this.paneTree(ws, win, tree);
    if (!ws.focusId || !tabsOf(ws).some(t => t.id === ws.focusId)) ws.focusId = tabsOf(ws)[0]?.id ?? null;
    renderWorkspace(ws);
    if (ws.id !== state.activeId) switchWorkspace(ws.id);
    for (const tab of this.panes.values()) if (tab.wsId === ws.id) sizePane(tab);
    emit(EVENTS.workspaces);
    persist();
  }

  /**
   * The window's entry, with a workspace made for it the first time.
   * @param {string} windowId
   * @param {string | undefined} name
   */
  windowFor(windowId, name) {
    let win = this.windows.get(windowId);
    if (!win) {
      const ws = createWorkspace({ name: `tmux · ${name ?? windowId}`, startWith: START_WITH.empty });
      ws.tmux = { client: this.id, window: windowId };
      win = { wsId: ws.id };
      this.windows.set(windowId, win);
    }
    return win;
  }

  /**
   * Panes gone from tmux close here too.
   * @param {Workspace} ws
   * @param {Set<string>} wanted
   */
  closeGonePanes(ws, wanted) {
    for (const [paneId, tab] of this.panes) {
      if (tab.wsId === ws.id && !wanted.has(paneId)) {
        this.panes.delete(paneId);
        tab.virtual = null;
        queueMicrotask(() => closeTab(tab)); // once the new layout is in place
      }
    }
  }

  /**
   * The workspace's layout for a tmux layout node; tmux splits into any number of parts, Termilly in two, nested.
   * @param {Workspace} ws
   * @param {TmuxWindow} win
   * @param {TmuxLayout} node
   * @returns {LayoutNode}
   */
  paneTree(ws, win, node) {
    if (!node.children) return { kind: NODE.leaf, tabId: this.paneTab(ws, win, node).id };
    /**
     * @param {TmuxLayout[]} parts
     * @returns {LayoutNode}
     */
    const nest = parts => {
      if (parts.length === 1) return this.paneTree(ws, win, parts[0]);
      const [first, ...rest] = parts;
      const total = parts.reduce((sum, p) => sum + (node.dir === SPLIT.row ? p.w : p.h), 0);
      const ratio = (node.dir === SPLIT.row ? first.w : first.h) / total;
      // A node with children is a split, so it has a dir.
      return { kind: NODE.split, dir: /** @type {'row' | 'column'} */ (node.dir), ratio, a: this.paneTree(ws, win, first), b: nest(rest) };
    };
    return nest(node.children);
  }

  /**
   * A tmux pane's terminal (made the first time it's seen, filled with what tmux shows), at the pane's size.
   * @param {Workspace} ws
   * @param {TmuxWindow} win
   * @param {TmuxLayout} node
   */
  paneTab(ws, win, node) {
    const paneId = `%${node.pane}`;
    let tab = this.panes.get(paneId);
    if (!tab) {
      tab = createTab({ wsId: ws.id, profile: defaultProfile(), name: `${win.name ?? TMUX} ${paneId}` });
      tab.noHistory = true;
      tab.virtual = { kind: TMUX, client: this.id, pane: paneId, cols: node.w, rows: node.h };
      this.panes.set(paneId, tab);
      setTimeout(() => this.fill(/** @type {Tab} */ (tab), paneId), FILL_AFTER_MS);
    }
    /** @type {NonNullable<Tab['virtual']>} */ (tab.virtual).cols = node.w;
    /** @type {NonNullable<Tab['virtual']>} */ (tab.virtual).rows = node.h;
    return tab;
  }

  /**
   * A new pane's terminal starts with what tmux has on its screen, and the cursor where it is.
   * @param {Tab} tab
   * @param {string} paneId
   */
  fill(tab, paneId) {
    this.command(`capture-pane -p -e -t ${paneId}`, (lines, error) => {
      if (error || !tab.view?.term) return;
      while (lines.length && !lines[lines.length - 1]) lines.pop();
      tab.view.term.write(`\x1b[H\x1b[2J${lines.join('\r\n')}`);
      this.command(`display-message -p -t ${paneId} "#{cursor_x} #{cursor_y}"`, (pos) => {
        const [x, y] = (pos[0] ?? '0 0').split(' ').map(Number);
        tab.view?.term.write(`\x1b[${y + 1};${x + 1}H`);
      });
    });
  }

  /**
   * A notification from tmux (%output, %layout-change...); the parser also passes its whole line, unused here.
   * @type {(name: string, args: string[], line?: string) => void}
   */
  notify(name, args) {
    if (name === NOTIFICATION.output) {
      const tab = this.panes.get(args[0]);
      tab?.view?.term?.write(args[1]);
    } else if (name === NOTIFICATION.layoutChange) {
      const [windowId, layout] = args;
      if (this.windows.has(windowId) || this.started) this.layoutWindow(windowId, this.windows.get(windowId)?.name, layout);
    } else if (name === NOTIFICATION.windowAdd) {
      if (this.started) setTimeout(() => this.sync(), RESYNC_AFTER_MS);
    } else if (name === NOTIFICATION.windowClose || name === NOTIFICATION.unlinkedWindowClose) {
      this.closeWindow(args[0]);
    } else if (name === NOTIFICATION.windowRenamed) {
      const win = this.windows.get(args[0]);
      const ws = win && wsById(win.wsId);
      if (ws) { win.name = args.slice(1).join(' '); ws.name = `tmux · ${win.name}`; emit(EVENTS.workspaces); }
    } else if (name === NOTIFICATION.exit) {
      this.ended(args.join(' ') || 'tmux ended');
    }
  }

  /** @param {string} windowId */
  closeWindow(windowId) {
    const win = this.windows.get(windowId);
    if (!win) return;
    this.windows.delete(windowId);
    const ws = wsById(win.wsId);
    if (ws) queueMicrotask(() => closeWorkspace(ws)); // after tmux's notification is handled
  }

  /** The client's size: the workspace's area in cells, measured with a pane's character size. */
  resizeClient() {
    const tab = [...this.panes.values()][0];
    const term = tab?.view?.term;
    const area = document.getElementById(WORKSPACE_ID)?.getBoundingClientRect();
    if (!area) return;
    const cell = term?._core?._renderService?.dimensions?.css?.cell;
    const cols = Math.max(MIN_COLS, Math.floor((area.width - AREA_MARGIN_PX) / (cell?.width || FALLBACK_CELL_WIDTH_PX)));
    const rows = Math.max(MIN_ROWS, Math.floor((area.height - AREA_MARGIN_PX) / (cell?.height || FALLBACK_CELL_HEIGHT_PX)) - 1);
    if (this.size === `${cols}x${rows}`) return;
    this.size = `${cols}x${rows}`;
    this.command(`refresh-client -C ${cols}x${rows}`);
  }

  /**
   * @param {Tab} tab A pane terminal of this client (so it has its virtual pane).
   * @param {string} data
   */
  input(tab, data) {
    for (const text of sendKeysCommands(/** @type {NonNullable<Tab['virtual']>} */ (tab.virtual).pane, data)) this.command(text);
  }

  /** @param {string} reason */
  ended(reason) {
    clients.delete(this.id);
    for (const tab of this.panes.values()) {
      tab.virtual = null;
      tab.exited = true;
      tab.view?.term?.write(`\r\n\x1b[90m[tmux: ${reason.replace(/[\x00-\x1f]/g, '')}. It keeps running there; attach again to come back.]\x1b[0m\r\n`);
    }
    this.panes.clear();
  }

  /** Detaches: tmux keeps running on the server. */
  detach() {
    this.command('detach-client');
    setTimeout(() => send(PAGE.tmuxStop, { id: this.id }), STOP_AFTER_MS);
  }
}

/**
 * A pane terminal keeps tmux's size (tmux lays the panes out, not Termilly).
 * @param {Tab} tab
 */
function sizePane(tab) {
  const term = tab.view?.term;
  const v = tab.virtual;
  if (!term || !v) return;
  // It has a terminal, so it has its view.
  if (/** @type {HeldView} */ (tab.view).fit && !(/** @type {HeldView} */ (tab.view).fitHeld)) {
    /** @type {HeldView} */ (tab.view).fitHeld = true;
    /** @type {HeldView} */ (tab.view).fit = { fit() {} };
  }
  if (term.cols !== v.cols || term.rows !== v.rows) term.resize(v.cols, v.rows);
}

onHost(HOST.tmuxData, m => clients.get(m.id)?.parser.feed(m.data));
onHost(HOST.tmuxExit, m => {
  const client = clients.get(m.id);
  if (!client) return;
  if (/** @type {TmuxExit} */ (m).error || !client.started) {
    confirmDialog({ title: 'tmux didn’t start', body: /** @type {TmuxExit} */ (m).error ?? `“${client.commandLine}” ended (code ${m.code}). Is tmux 3.2 or newer installed there?` });
  }
  client.ended(DETACHED_REASON);
});

/**
 * Typing in a pane terminal (terminals.js): to tmux.
 * @param {Tab} tab
 * @param {string} data
 */
export function tmuxInput(tab, data) {
  clients.get(/** @type {string} */ (tab.virtual?.client))?.input(tab, data);
}

/** Closing a tmux workspace detaches; the panes stay in tmux. */
on(EVENTS.workspaceClosed, ws => { if (ws.tmux) detachWorkspace(ws); });

/** @param {Workspace | null | undefined} ws */
export function detachWorkspace(ws) {
  const client = ws?.tmux && clients.get(ws.tmux.client);
  if (client) client.detach();
}

/** How long the window's resizing settles before tmux is told its new size. */
const RESIZE_DELAY = 300;
addEventListener('resize', debounce(() => { for (const c of clients.values()) c.resizeClient(); }, RESIZE_DELAY));

/** "Attach tmux": what to run (this computer's tmux on Linux, WSL's, or an SSH host's), and the session name. */
export function openAttach() {
  const hosts = state.profiles.filter(p => isSshProfile(p));
  const wsl = state.profiles.filter(p => p.source === PROFILE_SOURCE.wsl);
  const linux = platform === PLATFORM.linux;
  const choices = [
    ...(linux ? [['tmux -C new-session -A -s {session}', 'This computer']] : []),
    ...wsl.map(p => [`wsl.exe -d ${p.name} -e tmux -C new-session -A -s {session}`, `${p.name} (WSL)`]),
    ...hosts.map(p => [`${linux ? 'ssh' : 'ssh.exe'} -T ${p.name} tmux -C new-session -A -s {session}`, p.name]),
  ];
  return modal('tmux-attach', `
    <h3>Attach tmux</h3>
    <p class="dialog-sub">tmux’s windows become workspaces and its panes terminals here. Closing them detaches; tmux keeps running there. Needs tmux 3.2 or newer.</p>
    <label class="dialog-field">Where<select class="field" data-where>
      ${choices.map(([cmd, label]) => `<option value="${escapeHtml(cmd)}">${escapeHtml(label)}</option>`).join('')}
      <option value="${CUSTOM_CHOICE}">Command</option></select></label>
    <label class="dialog-field">Session<input class="field" data-session value="${DEFAULT_SESSION}" spellcheck="false"></label>
    <label class="dialog-field" data-custom hidden>Command<input class="field" data-command placeholder="ssh -T host tmux -C new-session -A -s main" spellcheck="false"></label>
    <div class="dialog-actions"><button class="btn" data-cancel>Cancel</button><button class="btn primary" data-ok>Attach</button></div>`, (dialog, close) => {
    const where = /** @type {HTMLSelectElement} */ (dialog.querySelector('[data-where]'));
    where.addEventListener('change', () => { find(dialog, '[data-custom]').hidden = where.value !== CUSTOM_CHOICE; });
    find(dialog, '[data-custom]').hidden = where.value !== CUSTOM_CHOICE;
    const go = () => {
      const session = field(dialog, '[data-session]').value.trim().replace(/[^\w.-]/g, '') || DEFAULT_SESSION;
      const command = where.value === CUSTOM_CHOICE ? field(dialog, '[data-command]').value.trim() : where.value.replace('{session}', session);
      if (!command) return;
      close(true);
      attachTmux(command, where.selectedOptions[0]?.textContent ?? TMUX);
    };
    return { submit: go };
  });
}

/**
 * @param {string} command
 * @param {string} [label]
 */
export function attachTmux(command, label = TMUX) {
  const client = new TmuxSession(command, label);
  client.start();
  return client;
}

export const tmuxClients = () => [...clients.values()];

setVirtualInput(tmuxInput);
