// @ts-check
// Other Termilly computers, under Remote › Termilly computers (Features/RemotePcs.cs): each paired computer, its
// workspaces and their terminals, as a tree. A terminal opened from it is a pane here that shows the one there live
// (what it shows, then what it prints) and types into it, with the computer's name in its title. Pairing takes the
// other computer's address and the code its Settings › Remote › Pair a computer shows; what may be typed is up to it.

import { PAGE, HOST } from './protocol.js';
import { send, request, onHost } from './host.js';
import { state, on, EVENTS, ACTIVITY, WORKSPACE_COLORS, tabsOf, activityChanged } from './store.js';
import { newTab, focusTab, closeTab, switchWorkspace, renderWorkspace, renderAll } from './panes.js';
import { setVirtualInput } from './terminals.js';
import { escapeHtml, ICONS, activityHtml, MINI_ACTIVITY, badgeHtml } from './ui.js';
import { modal, FORM_DIALOG, DIALOG_ERROR, confirmDialog } from './dialogs.js';
import { showMenu, SEPARATOR } from './popups.js';
import { byId, targetOf } from './dom.js';
import { renderRemote, setRemoteExtra, REMOTE_ID, REMOTE_GROUP, groupHead, isGroupFolded } from './remote.js';
import { showToast, TOAST } from './toasts.js';
import { FOLDER_PATH, SETTING_VALUES } from './constants.js';
import { showAtSize } from './phone.js';

/** @typedef {import('./protocol.js').PcView} Pc */
/** @typedef {import('./popups.js').MenuEntry} MenuEntry */
/** A computer's state, as its phone app gets it (js/phone.js snapshot): what the tree shows of it. */
/** Where a terminal's files are there: an SSH host it reaches (by name) or its own disk, and its shell's folder. */
/** @typedef {{ ssh: boolean, place: string | null, cwd: string }} PcFiles */
/** @typedef {{ opening?: boolean, closing?: boolean, places?: { id: string, name: string }[], os?: string, workspaces: { id: string, name: string, color: string }[], terminals: { id: string, ws: string, title: string, badge?: string, icon?: string, prompts?: boolean, sizedBy?: { label: string, computer: boolean } | null, cols?: number | null, rows?: number | null, activity?: string | null, hint?: string | null, files?: PcFiles | null }[] }} PcState */

/** A virtual terminal's kind (tab.virtual): another computer's. */
export const PC_KIND = 'pc';
/** A computer, on the 16px grid: a screen on a stand. */
const COMPUTER_ICON = '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="9" rx="1.5"/><path d="M5.5 14.5h5M8.5 11.5v3"/></svg>';
/** What the tree's rows do (data-pc-*). */
const ROW = Object.freeze({ computer: 'pcComputer', workspace: 'pcWorkspace', terminal: 'pcTerminal', add: 'pcAdd' });
/** What's asked of a computer (js/phonemanage.js there). */
const MANAGE = Object.freeze({ open: 'open', close: 'close', newWorkspace: 'newWorkspace', closeWorkspace: 'closeWorkspace' });
/** A terminal's size before it's been fitted. */
const START_SIZE = Object.freeze({ cols: 120, rows: 30 });

/** @type {Pc[]} */
let pcs = [];
/** Folded computers and workspaces (all open to start). */
const folded = new Set();

/** @param {Pc} pc @returns {PcState} */
function stateOf(pc) {
  try {
    return pc.state ? JSON.parse(pc.state) : { workspaces: [], terminals: [] };
  } catch {
    return { workspaces: [], terminals: [] };
  }
}

/** Copy to's stand-ins for the computers' terminals (js/copyto.js), by their ids, so a choice stays the same one. */
/** @type {Map<string, Tab>} */
const standIns = new Map();

/** The system a computer says it runs (its state's os), whose folders start at drives. */
const WINDOWS_OS = 'windows';

/**
 * A computer's terminal as Copy to lists it: an id the host routes to that computer, its name, and where its files
 * are (Tab.pcFiles).
 * @param {Pc} pc
 * @param {PcState} s
 * @param {PcState['terminals'][number]} t
 * @param {PcFiles} files
 * @returns {Tab}
 */
function standIn(pc, s, t, files) {
  const id = `pc:${pc.id}:${t.id}`;
  const windows = s.os === WINDOWS_OS;
  const tab = standIns.get(id) ?? /** @type {Tab} */ (/** @type {unknown} */ ({ id, wsId: null, profile: '', tags: [] }));
  tab.name = t.title;
  tab.pcFiles = {
    pcId: pc.id, pc: pc.name, machine: `${pc.id}:${files.ssh ? files.place : ''}`,
    place: files.ssh ? `${files.place} on ${pc.name}` : pc.name,
    root: files.ssh || !windows ? '/' : FOLDER_PATH.drives, caseless: !files.ssh && windows, cwd: files.cwd,
  };
  standIns.set(id, tab);
  return tab;
}

/**
 * The paired computers' terminals Copy to can copy into, by workspace (named with the computer): the ones whose
 * files they share, while they're reachable.
 * @returns {{ name: string, tabs: Tab[] }[]}
 */
export function fileTargets() {
  return pcs.filter(pc => pc.online).flatMap(pc => {
    const s = stateOf(pc);
    return s.workspaces.map(ws => ({
      name: `${ws.name} · ${pc.name}`,
      tabs: s.terminals.filter(t => t.ws === ws.id && t.files).map(t => standIn(pc, s, t, /** @type {PcFiles} */ (t.files))),
    })).filter(g => g.tabs.length);
  });
}

/** A computer's terminal Copy to listed, by its id. @param {string} id */
export const fileTarget = id => standIns.get(id);

/** Its terminals open here, each watching its terminal there: tab id to the workspace it's in. */
/** @type {Map<string, string>} */
const watching = new Map();
/** This PC's workspace to come back to when a computer's last terminal here closes. */
/** @type {string | null} */
let lastLocal = null;

/**
 * A computer's own workspace here, where its terminals open: not listed with this PC's (the tree lists them).
 * @param {Pc} pc
 * @returns {Workspace}
 */
function spaceOf(pc) {
  let ws = state.remoteSpaces.find(w => w.remote === pc.id);
  if (!ws) {
    ws = { id: `pc-${pc.id}`, name: pc.name, color: WORKSPACE_COLORS[0], cwd: null, focusId: null, root: null, remote: pc.id };
    state.remoteSpaces.push(ws);
    renderWorkspace(ws);
  }
  return ws;
}

/** Shows a computer's workspace here, remembering this PC's one to come back to. @param {Workspace} ws */
function showSpace(ws) {
  if (state.workspaces.some(w => w.id === state.activeId)) lastLocal = state.activeId;
  switchWorkspace(ws.id);
}

/**
 * The computer's terminal shown here now (its workspace in front, it in focus): its row is the selected one.
 * @param {Pc} pc
 * @param {string} pane
 */
function inFront(pc, pane) {
  const ws = state.remoteSpaces.find(w => w.remote === pc.id);
  return !!ws && state.activeId === ws.id && state.tabs.get(ws.focusId ?? '')?.virtual?.pane === pane;
}

/** A terminal's activity there (busy, waiting), as this PC's sidebar shows its own. @param {PcState['terminals'][number]} t */
const activityOfRemote = t => (t.activity && Object.values(ACTIVITY).includes(/** @type {any} */ (t.activity))
  ? activityHtml({ kind: /** @type {any} */ (t.activity === ACTIVITY.percent ? ACTIVITY.spin : t.activity), title: t.hint ?? '' }, MINI_ACTIVITY) : '');

/** @param {string} key @param {string} html */
const chev = (key, html) => `<span class="pc-chev${folded.has(key) ? '' : ' open'}">${ICONS.chevronRight}</span>${html}`;

/** @param {Pc} pc */
function computerHtml(pc) {
  const s = stateOf(pc);
  const head = `<button class="rm-row pc-row" data-pc-computer="${escapeHtml(pc.id)}" title="${escapeHtml(`${pc.name} · ${pc.address}${pc.online ? '' : ` · ${pc.error ?? 'offline'}`}`)}">
    ${chev(pc.id, `<span class="pc-icon">${COMPUTER_ICON}</span>`)}<span class="rm-name">${escapeHtml(pc.name)}</span>
    <span class="rm-chips"><span class="pc-dot${pc.online ? ' on' : ''}"></span></span></button>`;
  if (folded.has(pc.id) || !pc.online) return head;
  return head + s.workspaces.map(w => {
    const key = `${pc.id}/${w.id}`;
    const terms = s.terminals.filter(t => t.ws === w.id);
    return `<button class="rm-row pc-ws" data-pc-workspace="${escapeHtml(key)}">${chev(key, `<span class="pc-wsdot" style="background:${escapeHtml(w.color)}"></span>`)}
      <span class="rm-name">${escapeHtml(w.name)}</span><span class="rm-chips"><span class="rm-count">${terms.length}</span></span></button>`
      + (folded.has(key) ? '' : terms.map(t => `<button class="rm-row pc-term${inFront(pc, t.id) ? ' on' : ''}" data-pc-terminal="${escapeHtml(pc.id)}" data-pane="${escapeHtml(t.id)}" title="Open ${escapeHtml(t.title)} from ${escapeHtml(pc.name)} here">
        ${badgeHtml({ icon: t.icon ?? '' })}<span class="rm-name">${escapeHtml(t.title)}</span><span class="rm-chips">${activityOfRemote(t)}</span></button>`).join(''));
  }).join('');
}

/** The group in Remote: each computer's tree, and adding one. */
const groupHtml = () => groupHead(REMOTE_GROUP.computers, 'Termilly computers', pcs.length) + (isGroupFolded(REMOTE_GROUP.computers) ? ''
  : `<div class="rm-sub">${pcs.map(computerHtml).join('')}
  <button class="rm-row pc-add" data-pc-add>${ICONS.plus}<span class="rm-name">Add a computer</span></button></div>`);

setRemoteExtra(groupHtml);

/** Pairs with another computer: its address and the code it shows. */
function addComputer() {
  modal(FORM_DIALOG, `
    <h3>Add a Termilly computer</h3>
    <p class="dialog-sub">On the other computer, turn on Settings › Remote › Remote access. Pair a computer there shows what to type here.</p>
    <label class="dialog-field">Address<input class="field" data-pc-address placeholder="192.168.0.20 or desktop.local" spellcheck="false" autocomplete="off" autofocus></label>
    <label class="dialog-field">Code<input class="field mono" data-pc-code placeholder="ABCD-1234" spellcheck="false" autocomplete="off"></label>
    <p class="dialog-error" hidden></p>
    <div class="dialog-actions"><button class="btn" data-cancel>Cancel</button><button class="btn primary" data-ok>Pair</button></div>`, (dialog, close) => {
    const error = /** @type {HTMLElement} */ (dialog.querySelector(DIALOG_ERROR));
    const value = (/** @type {string} */ sel) => /** @type {HTMLInputElement} */ (dialog.querySelector(sel)).value.trim();
    return {
      submit: async () => {
        error.hidden = true;
        const answer = await request(PAGE.pcAdd, { address: value('[data-pc-address]'), code: value('[data-pc-code]') });
        if (answer?.error) {
          error.textContent = answer.error;
          error.hidden = false;
        } else close(true);
      },
    };
  });
}

/**
 * Opens another computer's terminal in a pane here (the one already open, if there is one).
 * @param {Pc} pc
 * @param {string} pane
 */
function openTerminal(pc, pane) {
  const ws = spaceOf(pc);
  showSpace(ws);
  const open = [...state.tabs.values()].find(t => t.virtual?.kind === PC_KIND && t.virtual.client === pc.id && t.virtual.pane === pane);
  if (open) return focusTab(open);
  const t = stateOf(pc).terminals.find(x => x.id === pane);
  newTab({ wsId: ws.id, name: `${t?.title ?? 'Terminal'} · ${pc.name}`, virtual: { kind: PC_KIND, client: pc.id, pane, cols: t?.cols ?? START_SIZE.cols, rows: t?.rows ?? START_SIZE.rows, icon: t?.icon ?? null, prompts: !!t?.prompts } });
}

/**
 * Its terminals open here take what runs in them there (Claude Code starting or exiting changes their badge) and
 * whether their Prompt history may be opened, as each computer's new state comes.
 */
function followTerminals() {
  for (const tab of state.tabs.values()) {
    const v = tab.virtual;
    const pc = v?.kind === PC_KIND ? pcs.find(p => p.id === v.client) : null;
    const t = pc ? stateOf(pc).terminals.find(x => x.id === v?.pane) : null;
    if (!v || !t) continue;
    // Drawn at the size it has there: that size changed there.
    if (tab.phoneSize && (keepsTheirs() || paused.has(tab.id))) drawAtTheirSize(tab);
    const icon = t.icon || v.icon, prompts = !!t.prompts;
    if (icon === v.icon && prompts === !!v.prompts) continue;
    Object.assign(v, { icon, prompts });
    activityChanged(tab, true);
  }
}

// ---- Whose size: this computer's, or the other's ----
//
// Settings › Remote › Size of remote terminals says how they're drawn here. Fit local window: the one there takes this
// one's size while it's on screen here (its tab in front, the window not minimized), and its own again when it isn't.
// Keep remote size (the default): it's drawn here at the size it has there, smaller to fit. When that computer takes it back
// (its Take back), it's drawn at its own size here under Paused, until Resume.

/** Its terminals here the other computer took back: paused until Resume. */
/** @type {Set<string>} */
const paused = new Set();
/** The size each last told the other computer ("cols x rows", "0 x 0" for none), so it isn't told twice. */
/** @type {Map<string, string>} */
const told = new Map();
/** How long after it's drawn at another size its screen is asked for again (the program there has redrawn by then). */
const REDRAWN_MS = 250;
/** The paused screen over a terminal. */
const PAUSED_CLASS = 'pc-paused';

/** Settings › Remote keeps the other computer's size for its terminals here. */
const keepsTheirs = () => state.settings.phone?.pcSize === SETTING_VALUES.pcSize.keep;

/**
 * The size its terminal here gives the one there: this one's, while it fits this computer, isn't paused and is on
 * screen; none otherwise.
 * @param {Tab} tab
 */
function sizeToGive(tab) {
  const term = tab.view?.term;
  const gives = !!term && !keepsTheirs() && !paused.has(tab.id) && onScreen(tab) && !document.hidden;
  return gives && term ? { cols: term.cols, rows: term.rows } : { cols: 0, rows: 0 };
}

/**
 * Draws its terminal here as it should be now (at this pane's size, or at the size it has there), and tells the other
 * computer the size it gives, if that changed.
 * @param {Tab} tab
 */
function settleSize(tab) {
  const v = tab.virtual;
  if (v?.kind !== PC_KIND || !tab.view?.term) return;
  if (keepsTheirs() && paused.has(tab.id)) resume(tab); // it never gives its size: nothing to resume
  if (keepsTheirs() || paused.has(tab.id)) drawAtTheirSize(tab);
  else if (tab.phoneSize) showAtSize(tab, null);
  const size = sizeToGive(tab), key = `${size.cols} x ${size.rows}`;
  if (told.get(tab.id) === key) return;
  told.set(tab.id, key);
  send(PAGE.pcSize, { tab: tab.id, ...size });
}

/** Its terminal here at the size it has there, as that computer last said. @param {Tab} tab */
function drawAtTheirSize(tab) {
  const v = tab.virtual, pc = pcs.find(p => p.id === v?.client);
  const t = pc ? stateOf(pc).terminals.find(x => x.id === v?.pane) : null;
  if (!pc || !t?.cols || !t.rows) return;
  // A phone (or another computer) has it there: drawn here as it's drawn there, in its phone, with who has it.
  const who = t.sizedBy ?? { label: '', computer: true }; // its own size there: nothing to say
  if (tab.phoneSize?.cols === t.cols && tab.phoneSize.rows === t.rows && tab.sizedBy?.label === who.label) return;
  showAtSize(tab, { cols: t.cols, rows: t.rows }, { ...who, takeBack: false }); // taken back there, not here
  // What it printed for that size came before it was drawn at it here: what it shows, again, once drawn.
  setTimeout(() => send(PAGE.pcRefresh, { tab: tab.id }), REDRAWN_MS);
}

/**
 * Whether its terminal here is on screen: its tab in front in its pane, its workspace the one shown (the others are
 * hidden, not taken out).
 * @param {Tab} tab
 */
function onScreen(tab) {
  const body = tab.view?.body;
  if (!body?.isConnected) return false;
  return typeof body.checkVisibility === 'function' ? body.checkVisibility({ visibilityProperty: true }) : body.getClientRects().length > 0;
}

/** Tabs by the pane body they're drawn in, for the observer below. */
/** @type {WeakMap<Element, Tab>} */
const bodies = new WeakMap();
// A terminal here comes on screen or goes off it (another tab in its pane in front, its pane resized away).
const seen = new IntersectionObserver(entries => {
  for (const e of entries) {
    const tab = bodies.get(e.target);
    if (tab) settleSize(tab);
  }
});
/** Each of its terminals here, settled again (the window came or went, Settings changed). */
const settleAll = () => { for (const id of watching.keys()) { const tab = state.tabs.get(id); if (tab) settleSize(tab); } };
document.addEventListener('visibilitychange', settleAll);
for (const event of [EVENTS.settings, EVENTS.workspaces, EVENTS.focus]) on(event, () => requestAnimationFrame(settleAll)); // once drawn

/**
 * Its terminal there has another size now (that computer took it back, or another phone or computer has it): paused
 * here (drawn at the size it has there) until Resume, which gives it this computer's size again.
 * @param {Tab} tab
 * @param {string | null | undefined} by who has it now (none: that computer)
 */
function pause(tab, by) {
  const body = tab.view?.body;
  if (!body) return;
  paused.add(tab.id);
  told.delete(tab.id); // it has no size from here now
  body.querySelector(`:scope > .${PAUSED_CLASS}`)?.remove();
  const name = pcs.find(p => p.id === tab.virtual?.client)?.name ?? 'That computer';
  const why = by ? `${escapeHtml(by)} now sets the size of this remote terminal.` : `${escapeHtml(name)} took back its local terminal.`;
  body.insertAdjacentHTML('beforeend', `<div class="${PAUSED_CLASS}"><p><b>Paused.</b> ${why}</p><button class="btn small primary" title="The remote terminal follows this window again">Resume</button></div>`);
  body.querySelector(`:scope > .${PAUSED_CLASS} button`)?.addEventListener('click', () => resume(tab));
  settleSize(tab);
}

/** @param {Tab} tab */
function resume(tab) {
  paused.delete(tab.id);
  tab.view?.body.querySelector(`:scope > .${PAUSED_CLASS}`)?.remove();
  told.delete(tab.id);
  settleSize(tab);
}

/** The cover over a remote terminal whose connection is gone. */
const LOST_CLASS = 'pc-lost';

/**
 * A remote terminal lost its connection to its local terminal (or never had it): a message over it, with only Close
 * terminal, so it doesn't look alive.
 * @param {Tab} tab
 * @param {string} error
 */
function lost(tab, error) {
  const body = tab.view?.body;
  if (!body) return;
  for (const cover of body.querySelectorAll(`:scope > .${PAUSED_CLASS}, :scope > .${LOST_CLASS}`)) cover.remove();
  paused.delete(tab.id);
  body.insertAdjacentHTML('beforeend', `<div class="${LOST_CLASS}"><p>${escapeHtml(error)}</p><button class="btn small primary">Close terminal</button></div>`);
  body.querySelector(`:scope > .${LOST_CLASS} button`)?.addEventListener('click', () => closeTab(tab));
}

onHost(HOST.pcLost, m => {
  const tab = state.tabs.get(m.tab);
  if (tab) lost(tab, m.error);
});

onHost(HOST.pcPaused, m => {
  const tab = state.tabs.get(m.tab);
  if (tab) pause(tab, m.by);
});

// Its terminal here is opened: it starts watching there (at no size yet: it gives its own once it's on screen), and
// tells its size as it changes.
on(EVENTS.terminalOpened, (/** @type {Tab} */ tab) => {
  const v = tab.virtual;
  const term = tab.view?.term;
  if (v?.kind !== PC_KIND || !term || !tab.view) return;
  tab.noHistory = true;
  watching.set(tab.id, tab.wsId);
  told.set(tab.id, '0 x 0');
  send(PAGE.pcWatch, { id: v.client, tab: tab.id, pane: v.pane, cols: 0, rows: 0 });
  bodies.set(tab.view.body, tab);
  seen.observe(tab.view.body);
  term.onResize(() => settleSize(tab));
  settleSize(tab);
});
/**
 * Its terminals closed here since: the other computer stops showing them at this one's size, and a computer whose
 * last terminal here closed loses its workspace, this PC's coming back. (Closing a terminal sends the workspaces
 * event, not one of its own.)
 */
function closedHere() {
  /** @type {Set<string>} */
  const left = new Set();
  for (const [id, wsId] of [...watching].filter(([id]) => !state.tabs.has(id))) {
    watching.delete(id);
    for (const kept of [paused, told]) kept.delete(id);
    left.add(wsId);
    send(PAGE.pcUnwatch, { tab: id });
  }
  const empty = state.remoteSpaces.filter(w => left.has(w.id) && !tabsOf(w).length);
  if (!empty.length) return;
  for (const ws of empty) state.remoteSpaces.splice(state.remoteSpaces.indexOf(ws), 1);
  renderAll();
  if (empty.some(w => w.id === state.activeId)) switchWorkspace(lastLocal && state.workspaces.some(w => w.id === lastLocal) ? lastLocal : state.workspaces[0]?.id ?? '');
}
on(EVENTS.workspaces, () => { closedHere(); renderRemote(); });
// Which of its terminals is in front here: the tree marks it.
on(EVENTS.focus, () => renderRemote());

/**
 * What a terminal sends by itself, not typed: answers to the shell's questions (where the cursor is, what terminal it
 * is, what colours) and reports (focus, the mouse). The other computer's terminal answers those already; from here
 * they'd reach its shell as junk ("3R[1;25R" typed at the prompt), so only typing goes through (as phone/terminal.js).
 */
const AUTOMATIC = /^\x1b(?:\[\??[\d;]*[cnRIO]|\[[<M]|\][\s\S]*(?:\x07|\x1b\\)$|P[\s\S]*\x1b\\$)/;
setVirtualInput(PC_KIND, (tab, data) => { if (!AUTOMATIC.test(data)) send(PAGE.pcInput, { tab: tab.id, data }); });

onHost(HOST.pcOutput, m => {
  const term = state.tabs.get(m.tab)?.view?.term;
  if (!term) return;
  term.write(m.screen ? `\x1b[H\x1b[2J\x1b[3J${m.data}` : m.data);
});
onHost(HOST.pcRefused, m => showToast({ text: m.error, state: TOAST.failed }));
onHost(HOST.pcList, m => {
  pcs = m.items;
  followTerminals();
  renderRemote();
});
onHost(HOST.pcAdded, () => {});

/**
 * Asks a computer to do something there; what it answers shows only when it refused.
 * @param {Pc} pc
 * @param {Record<string, unknown>} args
 */
async function manage(pc, args) {
  const answer = await request(PAGE.pcManage, { id: pc.id, args });
  if (answer?.error) showToast({ text: answer.error, state: TOAST.failed });
}

/**
 * Why a computer won't: it's too old to say, or its Settings › Remote doesn't allow it. Asked anew each time, and its
 * state follows its settings live, so this needs no reconnecting.
 * @param {Pc} pc
 * @param {boolean | undefined} allowed
 */
const refusal = (pc, allowed) => (allowed ? undefined : allowed === undefined
  ? `Update ${pc.name} to do this from here.` : `${pc.name} doesn’t allow this: Settings › Remote there.`);

/**
 * Asks for a new workspace's name, then opens it there.
 * @param {Pc} pc
 */
function newWorkspaceThere(pc) {
  return modal(FORM_DIALOG, `
    <h3>New workspace on ${escapeHtml(pc.name)}</h3>
    <label class="dialog-field">Name<input class="field" data-pc-ws-name spellcheck="false" autocomplete="off"></label>
    <div class="dialog-actions"><button class="btn" data-cancel>Cancel</button><button class="btn primary" data-ok>Create</button></div>`, (dialog, close) => ({
    submit: () => {
      manage(pc, { action: MANAGE.newWorkspace, name: /** @type {HTMLInputElement} */ (dialog.querySelector('[data-pc-ws-name]')).value });
      close(true);
    },
  }));
}

/**
 * Closes a workspace or a terminal there, first saying what still runs in it.
 * @param {Pc} pc
 * @param {string} name
 * @param {PcState['terminals']} terminals what closes with it
 * @param {Record<string, unknown>} args
 */
async function closeThere(pc, name, terminals, args) {
  const running = terminals.filter(t => t.activity).map(t => t.title);
  const body = `${running.length ? `Still running: ${running.join(', ')}. ` : ''}${pc.name} keeps it in Recently closed, with its output.`;
  if (await confirmDialog({ title: `Close ${name} on ${pc.name}?`, body, confirm: `Close on ${pc.name}` })) manage(pc, args);
}

/**
 * New terminal on a computer (in a workspace there, else the one in front there) and New workspace: greyed, saying
 * why, when it doesn't allow them.
 * @param {Pc} pc
 * @param {string} [wsId]
 * @returns {MenuEntry[]}
 */
function createItems(pc, wsId) {
  const s = stateOf(pc);
  const why = refusal(pc, s.opening);
  return [
    { label: `New terminal on ${pc.name}`, icon: ICONS.plus, disabled: !!why, title: why,
      submenu: why ? undefined : () => (s.places ?? []).map(p => ({ label: p.name, action: () => { manage(pc, { action: MANAGE.open, profile: p.id, ws: wsId }); } })) },
    { label: `New workspace on ${pc.name}`, icon: ICONS.workspaces, disabled: !!why, title: why, action: () => { newWorkspaceThere(pc); } },
  ];
}

/**
 * Close on a computer: greyed, saying why, when it doesn't allow it.
 * @param {Pc} pc
 * @param {string} what
 * @param {() => void} action
 * @returns {MenuEntry}
 */
function closeItem(pc, what, action) {
  const why = refusal(pc, stateOf(pc).closing);
  return { label: `Close ${what} on ${pc.name}`, icon: ICONS.trash, danger: true, disabled: !!why, title: why, action };
}

/** @param {Pc} pc @param {MouseEvent} e */
function computerMenu(pc, e) {
  showMenu([
    ...(pc.online ? /** @type {MenuEntry[]} */ ([...createItems(pc), SEPARATOR]) : []),
    { label: 'Forget this computer', icon: ICONS.trash, danger: true, action: async () => {
      if (await confirmDialog({ title: `Forget ${pc.name}?`, body: 'Its terminals open here close. Pair it again with a new code.', confirm: 'Forget' })) send(PAGE.pcRemove, { id: pc.id });
    } },
  ], { x: e.clientX, y: e.clientY });
}

const section = byId(REMOTE_ID);
section.addEventListener('click', e => {
  const el = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-pc-computer], [data-pc-workspace], [data-pc-terminal], [data-pc-add]'));
  if (!el) return;
  e.stopPropagation();
  const { pcComputer, pcWorkspace, pcTerminal, pane } = el.dataset;
  const key = pcComputer ?? pcWorkspace;
  if (el.dataset[ROW.add] !== undefined) addComputer();
  else if (key) {
    if (!folded.delete(key)) folded.add(key);
    renderRemote();
  } else if (pcTerminal && pane) {
    const pc = pcs.find(p => p.id === pcTerminal);
    if (pc) openTerminal(pc, pane);
  }
}, true);
section.addEventListener('contextmenu', e => {
  const el = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-pc-computer], [data-pc-workspace], [data-pc-terminal]'));
  if (!el) return;
  const { pcComputer, pcWorkspace, pcTerminal, pane } = el.dataset;
  const pc = pcs.find(p => p.id === (pcComputer ?? pcTerminal ?? pcWorkspace?.split('/')[0]));
  if (!pc) return;
  e.preventDefault();
  e.stopPropagation();
  const at = { x: e.clientX, y: e.clientY };
  const s = stateOf(pc);
  if (pcComputer) computerMenu(pc, e);
  else if (pcWorkspace) {
    const id = pcWorkspace.slice(pc.id.length + 1);
    const ws = s.workspaces.find(w => w.id === id);
    if (ws) showMenu([...createItems(pc, id), SEPARATOR, closeItem(pc, 'workspace', () => closeThere(pc, ws.name, s.terminals.filter(t => t.ws === id), { action: MANAGE.closeWorkspace, ws: id }))], at);
  } else {
    const t = s.terminals.find(x => x.id === pane);
    if (t) showMenu([closeItem(pc, 'terminal', () => closeThere(pc, t.title, [t], { action: MANAGE.close, pane: t.id }))], at);
  }
}, true);

send(PAGE.pcList);
