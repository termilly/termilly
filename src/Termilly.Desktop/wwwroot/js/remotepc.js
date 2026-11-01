// @ts-check
// Other Termilly computers, under Remote › Termilly computers (Features/RemotePcs.cs): each paired computer, its
// workspaces and their terminals, as a tree. A terminal opened from it is a pane here that shows the one there live
// (what it shows, then what it prints) and types into it, with the computer's name in its title. Pairing takes the
// other computer's address and the code its Settings › Phone › Set up a phone shows; what may be typed is up to it.

import { PAGE, HOST } from './protocol.js';
import { send, request, onHost } from './host.js';
import { state, on, EVENTS } from './store.js';
import { newTab, focusTab } from './panes.js';
import { setVirtualInput } from './terminals.js';
import { escapeHtml, ICONS } from './ui.js';
import { modal, FORM_DIALOG, DIALOG_ERROR, confirmDialog } from './dialogs.js';
import { showMenu } from './popups.js';
import { byId, targetOf } from './dom.js';
import { renderRemote, setRemoteExtra, REMOTE_ID } from './remote.js';
import { showToast, TOAST } from './toasts.js';

/** @typedef {import('./protocol.js').PcView} Pc */
/** A computer's state, as its phone app gets it (js/phone.js snapshot): what the tree shows of it. */
/** @typedef {{ workspaces: { id: string, name: string, color: string }[], terminals: { id: string, ws: string, title: string, badge?: string, icon?: string, cols?: number | null, rows?: number | null }[] }} PcState */

/** A virtual terminal's kind (tab.virtual): another computer's. */
export const PC_KIND = 'pc';
/** A computer, on the 16px grid: a screen on a stand. */
const COMPUTER_ICON = '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="9" rx="1.5"/><path d="M5.5 14.5h5M8.5 11.5v3"/></svg>';
/** What the tree's rows do (data-pc-*). */
const ROW = Object.freeze({ computer: 'pcComputer', workspace: 'pcWorkspace', terminal: 'pcTerminal', add: 'pcAdd' });
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
      + (folded.has(key) ? '' : terms.map(t => `<button class="rm-row pc-term" data-pc-terminal="${escapeHtml(pc.id)}" data-pane="${escapeHtml(t.id)}" title="Open ${escapeHtml(t.title)} from ${escapeHtml(pc.name)} here">
        <span class="badge pc-badge">${escapeHtml(t.badge ?? '')}</span><span class="rm-name">${escapeHtml(t.title)}</span></button>`).join(''));
  }).join('');
}

/** The group in Remote: each computer's tree, and adding one. */
const groupHtml = () => `<div class="rm-group">Termilly computers</div>${pcs.map(computerHtml).join('')}
  <button class="rm-row pc-add" data-pc-add>${ICONS.plus}<span class="rm-name">Add a computer</span></button>`;

setRemoteExtra(groupHtml);

/** Pairs with another computer: its address and the code it shows. */
function addComputer() {
  modal(FORM_DIALOG, `
    <h3>Add a Termilly computer</h3>
    <p class="dialog-sub">On the other computer, turn on Termilly on the phone and open Settings › Phone › Set up a phone. Type its address and the code it shows.</p>
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
  const open = [...state.tabs.values()].find(t => t.virtual?.kind === PC_KIND && t.virtual.client === pc.id && t.virtual.pane === pane);
  if (open) return focusTab(open);
  const t = stateOf(pc).terminals.find(x => x.id === pane);
  newTab({ name: `${t?.title ?? 'Terminal'} · ${pc.name}`, virtual: { kind: PC_KIND, client: pc.id, pane, cols: t?.cols ?? START_SIZE.cols, rows: t?.rows ?? START_SIZE.rows } });
}

// Its terminal here is on screen: it starts watching there at its size, and tells its size as it changes.
on(EVENTS.terminalOpened, (/** @type {Tab} */ tab) => {
  const v = tab.virtual;
  const term = tab.view?.term;
  if (v?.kind !== PC_KIND || !term) return;
  tab.noHistory = true;
  send(PAGE.pcWatch, { id: v.client, tab: tab.id, pane: v.pane, cols: term.cols, rows: term.rows });
  term.onResize((/** @type {{ cols: number, rows: number }} */ { cols, rows }) => send(PAGE.pcSize, { tab: tab.id, cols, rows }));
});
on(EVENTS.tabClosed, (/** @type {Tab} */ tab) => { if (tab.virtual?.kind === PC_KIND) send(PAGE.pcUnwatch, { tab: tab.id }); });

setVirtualInput(PC_KIND, (tab, data) => send(PAGE.pcInput, { tab: tab.id, data }));

onHost(HOST.pcOutput, m => {
  const term = state.tabs.get(m.tab)?.view?.term;
  if (!term) return;
  term.write(m.screen ? `\x1b[H\x1b[2J\x1b[3J${m.data}` : m.data);
});
onHost(HOST.pcRefused, m => showToast({ text: m.error, state: TOAST.failed }));
onHost(HOST.pcList, m => {
  pcs = m.items;
  renderRemote();
});
onHost(HOST.pcAdded, () => {});

/** @param {Pc} pc @param {MouseEvent} e */
function computerMenu(pc, e) {
  showMenu([
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
  const el = /** @type {HTMLElement | null} */ (targetOf(e).closest(`[data-pc-computer]`));
  const pc = el && pcs.find(p => p.id === el.dataset[ROW.computer]);
  if (!pc) return;
  e.preventDefault();
  e.stopPropagation();
  computerMenu(pc, e);
}, true);

send(PAGE.pcList);
