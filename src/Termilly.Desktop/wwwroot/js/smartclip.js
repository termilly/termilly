// @ts-check
// Smart Clip (the title bar's button, Ctrl+Shift+X, or a terminal's right-click menu): every copy kept, text and
// images, made in Termilly or (on Windows) in any app, kept by the host (SmartClip.cs). A terminal's right-click menu
// offers the newest under Paste from Smart Clip; the panel docked on the right shows them all, pinned first, images in
// a grid. A click selects a clip and shows more of it (a second click folds it), Delete deletes it; a double click (or
// Enter) pastes it into the terminal in focus
// through its paste checks, a clip dragged onto a terminal pastes there, and an image pastes as the path of a PNG file
// (what agents such as Claude Code read). Secrets show masked and go after a while.

import { PAGE, HOST } from './protocol.js';
import { send, request, onHost } from './host.js';
import { state, on, tabTitle, wsById, EVENTS, GROUPS } from './store.js';
import { focusedTab, restoreFocus, newTab } from './panes.js';
import { scheduleFit, pasteInto } from './terminals.js';
import { escapeHtml, formatWhen, ICONS } from './ui.js';
import { byId, targetOf, dockRight, WORKSPACE_ID, DOCK_GRIP, CLIP_DRAG } from './dom.js';
import { showMenu, SEPARATOR } from './popups.js';
import { showToast, TOAST } from './toasts.js';
import { quotePaths } from './quoting.js';
import { setClipHooks } from './termclipboard.js';
import { CLIP_KIND, CLIP_FORM, PRODUCT } from './constants.js';
import { updateSettings } from './preferences.js';
import { fileSize } from './pictures.js';
import { pathActions } from './actions.js';
import { copyToNotepadItem, copyToNoteItem } from './notepad.js';
import { parentOf } from './filepaths.js';

/** @typedef {import('./protocol.js').ClipView} Clip */

/** How many of the newest clips the right-click menu offers, each with its digit. */
const MENU_COUNT = 6;
/** The longest label a clip gets in a menu, and the most of its text a tooltip shows. */
const MENU_CHARS = 48;
const TIP_CHARS = 400;
const MIN_WIDTH_PX = 280;
/** From this many characters a clip's size shows with it. */
const SIZE_FROM = 1_000;
const ROW_TIP = 'Click to see more, double-click or Enter to paste, Del to delete';
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_HOURS = 24;
/** Its shortcut, here and on the title bar's button (main.js runs it). */
export const CLIPS_KEY = 'KeyX';
const KEYS_TEXT = 'Ctrl+Shift+X';
const OPEN_LABEL = 'Open Smart Clip';
const CLEAR_LABEL = 'Clear history';
const UNPIN_LABEL = 'Unpin';
/** A clip's age under a minute. */
const JUST_NOW = 'now';

/** 16px icons at a 1px line on the pixel grid: the panel, each kind of clip, and the panel's tools. */
export const CLIP_ICON = '<svg viewBox="0 0 16 16"><path d="M3.5 4.5h-1v10h8v-1"/><rect x="4.5" y="2.5" width="9" height="11" rx="1"/><path d="M7.5 1.5h3v2h-3zM6.5 6.5h5M6.5 9.5h4"/></svg>';
/** @type {Readonly<Record<string, string>>} */
const KIND_ICONS = Object.freeze({
  [CLIP_KIND.text]: '<svg viewBox="0 0 16 16"><path d="M2.5 4.5h11M2.5 8.5h11M2.5 12.5h7"/></svg>',
  [CLIP_KIND.command]: '<svg viewBox="0 0 16 16"><path d="M3.5 4.5l3 3-3 3M8.5 11.5h4"/></svg>',
  [CLIP_KIND.path]: ICONS.folder,
  [CLIP_KIND.url]: ICONS.link,
  [CLIP_KIND.image]: '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M1.5 11.5l4-4 3 3 2-2 4 4"/><rect x="10" y="5" width="2" height="2" fill="currentColor" stroke="none"/></svg>',
  [CLIP_KIND.secret]: ICONS.lock,
});
/** @type {Readonly<Record<string, string>>} */
const KIND_LABELS = Object.freeze({
  [CLIP_KIND.text]: 'Text', [CLIP_KIND.command]: 'Command', [CLIP_KIND.path]: 'Path', [CLIP_KIND.url]: 'Link',
  [CLIP_KIND.image]: 'Image', [CLIP_KIND.secret]: 'Secret',
});
const TOOL_ICONS = Object.freeze({
  pin: '<svg viewBox="0 0 16 16"><path d="M5.5 2.5h6M6.5 2.5v4l-2 2.5h8l-2-2.5v-4M8.5 9v5"/></svg>',
  pause: '<svg viewBox="0 0 16 16"><path d="M5.5 3.5v9M10.5 3.5v9"/></svg>',
});
/** What the panel's buttons do (data-clips), and what a clip's own buttons do (data-clip-act). */
const PANEL_ACTION = Object.freeze({ pause: 'pause', clear: 'clear', close: 'close' });
const CLIP_ACTION = Object.freeze({ open: 'open', run: 'run', pin: 'pin', forget: 'forget' });
const SEARCH = '[data-clips-search]';
const LIST = '.clips-list';

/** The clips, newest first, as the host last sent them, and whether it keeps new copies. */
/** @type {Clip[]} */
let clips = [];
let keeping = true;
let query = '';
/** The clip selected in the panel: shown in full below its row (or outlined, an image), what Enter pastes. */
/** @type {string | null} */
let selected = null;
/** Images as data: URLs, by clip id: a clip never changes, so each is asked for once. */
/** @type {Map<string, string>} */
const pictures = new Map();

// ---- Taking a clip ----

/**
 * What a clip gives: its text, an image's file or its picture; null (and a note) when it's gone.
 * @param {Clip} clip
 * @param {string} as one of CLIP_FORM
 * @returns {Promise<string | null>}
 */
async function take(clip, as) {
  const answer = await request(PAGE.clipTake, { id: clip.id, as });
  if (answer?.text == null) showToast({ text: answer?.error ?? 'That clip is gone', state: TOAST.failed });
  return answer?.text ?? null;
}

/**
 * What a clip pastes into a terminal: its text, or an image's file path quoted for the terminal's shell.
 * @param {Clip} clip
 * @param {Tab | null | undefined} tab
 */
async function pasteText(clip, tab) {
  if (clip.kind !== CLIP_KIND.image) return take(clip, CLIP_FORM.text);
  const file = await take(clip, CLIP_FORM.path);
  const profile = state.profiles.find(p => p.id === tab?.profile);
  return file && `${quotePaths([file], profile?.shellIcon ?? profile?.icon)} `;
}

/**
 * Pastes a clip into a terminal (the one in focus by default); with `run`, runs it too.
 * @param {Clip} clip
 * @param {Tab | null | undefined} [tab]
 * @param {boolean} [run]
 */
export async function pasteClip(clip, tab = focusedTab(), run = false) {
  if (!tab || tab.exited) return;
  const text = await pasteText(clip, tab);
  if (text) pasteInto(tab, text, run);
}

/**
 * Puts a clip back on the clipboard, an image as an image.
 * @param {Clip} clip
 */
async function copyClip(clip) {
  const isImage = clip.kind === CLIP_KIND.image;
  const value = await take(clip, isImage ? CLIP_FORM.picture : CLIP_FORM.text);
  if (value == null) return;
  try {
    if (isImage) await navigator.clipboard.write([new ClipboardItem({ 'image/png': await (await fetch(value)).blob() })]);
    else await navigator.clipboard.writeText(value);
    showToast({ text: isImage ? 'Copied the image' : 'Copied' });
  } catch {
    showToast({ text: 'Couldn’t copy to the clipboard', state: TOAST.failed });
  }
}

/** @param {string} id */
const clipById = id => clips.find(c => c.id === id);

/** @param {Clip} clip */
const runnable = clip => (clip.kind === CLIP_KIND.text || clip.kind === CLIP_KIND.command) && clip.lines === 1;

// ---- How a clip reads ----

/** @param {number} at */
function age(at) {
  const ms = Date.now() - at;
  if (ms < MINUTE_MS) return JUST_NOW;
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)} min`;
  if (ms < DAY_HOURS * HOUR_MS) return `${Math.floor(ms / HOUR_MS)} h`;
  return formatWhen(at);
}

/** A clip in a word or a line: an image's size, else its first line. @param {Clip} clip */
const titleOf = clip => (clip.kind === CLIP_KIND.image ? `Image ${clip.width} × ${clip.height}` : clip.text.trim().split('\n')[0]);

/** @param {Clip} clip */
const metaOf = clip => [KIND_LABELS[clip.kind] ?? '', clip.source, clip.lines > 1 ? `${clip.lines.toLocaleString()} lines` : '',
  clip.chars >= SIZE_FROM ? fileSize(clip.chars) : '', age(clip.at)].filter(Boolean).join(' · ');

/** @param {Clip} clip */
const iconOf = clip => KIND_ICONS[clip.kind] ?? KIND_ICONS[CLIP_KIND.text];

// ---- The right-click menu ----

/**
 * The terminal a right-click menu or a copy came from.
 * @param {HTMLElement | null} body
 */
const tabOf = body => (body ? [...state.tabs.values()].find(t => t.view?.body.contains(body)) ?? null : null);

/**
 * Paste from Smart Clip: the newest clips, each with its digit, then Open Smart Clip and Clear history.
 * @param {HTMLElement} body
 * @param {(text: string) => void} paste the terminal's own paste, with its checks
 * @returns {import('./popups.js').MenuEntry[]}
 */
function menuEntries(body, paste) {
  const recent = clips.slice(0, MENU_COUNT).map((c, i) => ({
    label: titleOf(c).slice(0, MENU_CHARS), icon: iconOf(c), hint: String(i + 1), key: String(i + 1),
    title: `${c.kind === CLIP_KIND.image ? 'Pastes the image’s file path' : c.text.slice(0, TIP_CHARS)}\n${metaOf(c)}`,
    action: async () => {
      const text = await pasteText(c, tabOf(body));
      if (text) paste(text);
    },
  }));
  return [{
    label: 'Paste from Smart Clip', icon: CLIP_ICON,
    submenu: () => [
      ...(recent.length ? recent : [{ label: 'Nothing copied yet', disabled: true }]),
      SEPARATOR,
      { label: OPEN_LABEL, icon: CLIP_ICON, hint: KEYS_TEXT, action: () => openClips() },
      { label: CLEAR_LABEL, icon: ICONS.trash, disabled: !clips.some(c => !c.pinned), action: () => send(PAGE.clipClear) },
    ],
  }];
}

/**
 * A copy made in a terminal, for Smart Clip: where it came from, the terminal and its workspace.
 * @param {string} text
 * @param {HTMLElement | null} body
 * @param {boolean} link
 */
function noteCopy(text, body, link) {
  const tab = tabOf(body);
  const ws = tab ? wsById(tab.wsId)?.name : '';
  const where = tab ? [tabTitle(tab), link ? 'link' : ws].filter(Boolean).join(' · ') : '';
  send(PAGE.clipCopied, { text, source: where || PRODUCT.name });
}

setClipHooks(menuEntries, noteCopy);

// ---- The panel ----

const panel = document.createElement('aside');
panel.className = 'clips-panel';
panel.hidden = true;
panel.tabIndex = -1;
byId(WORKSPACE_ID).append(panel);
const button = byId('clips-button');

/** A clip's row: its icon (or picture), first line and where and when; its buttons show on hover. @param {Clip} c */
function rowHtml(c) {
  const mono = c.kind !== CLIP_KIND.text ? ' mono' : '';
  const open = openOf(c);
  return `<div class="clip-row${c.id === selected ? ' selected' : ''}" data-clip="${escapeHtml(c.id)}" draggable="true" title="${ROW_TIP}">
    <span class="clip-kind k-${escapeHtml(c.kind)}">${iconOf(c)}</span>
    <span class="clip-body"><span class="clip-text${mono}">${escapeHtml(titleOf(c))}</span><span class="clip-meta">${escapeHtml(metaOf(c))}</span></span>
    <span class="clip-acts">${open ? `<button class="pane-btn" data-clip-act="${CLIP_ACTION.open}" title="${open.label}">${ICONS.launch}</button>` : ''}${runnable(c) ? `<button class="pane-btn" data-clip-act="${CLIP_ACTION.run}" title="Paste and run">${ICONS.play}</button>` : ''}
      ${c.kind === CLIP_KIND.secret ? '' : `<button class="pane-btn${c.pinned ? ' on' : ''}" data-clip-act="${CLIP_ACTION.pin}" title="${c.pinned ? UNPIN_LABEL : 'Pin: kept at the top, never dropped'}">${TOOL_ICONS.pin}</button>`}
      <button class="pane-btn" data-clip-act="${CLIP_ACTION.forget}" title="Delete (Del)">${ICONS.cross}</button></span>
  </div>${c.id === selected ? previewHtml(c) : ''}`;
}

/**
 * The selected clip's text, scrolling within a few lines' height; a long clip shows its start and says how much more
 * there is (the whole of it pastes).
 * @param {Clip} c
 */
const previewHtml = c => `<div class="clip-preview"><pre>${escapeHtml(c.text)}</pre>${c.chars > c.text.length
  ? `<div class="clip-cut">The first ${c.text.length.toLocaleString()} of ${c.chars.toLocaleString()} characters. Pasting gives all of it.</div>` : ''}</div>`;

/** An image in the grid: its picture once it's here. @param {Clip} c */
const pictureHtml = c => `<div class="clip-pic${c.pinned ? ' pinned' : ''}${c.id === selected ? ' selected' : ''}" data-clip="${escapeHtml(c.id)}" draggable="true" title="Image ${c.width} × ${c.height} · ${escapeHtml(c.source)} · ${age(c.at)}. Double-click to paste its file path">
  ${pictures.has(c.id) ? `<img src="${escapeHtml(/** @type {string} */ (pictures.get(c.id)))}" alt="">` : iconOf(c)}</div>`;

/** @param {string} title @param {string} body */
const groupHtml = (title, body) => (body ? `<div class="clips-group">${title}</div>${body}` : '');

/** The clips that match the search box. */
function shown() {
  const q = query.trim().toLowerCase();
  return q ? clips.filter(c => `${c.text} ${c.source} ${KIND_LABELS[c.kind]}`.toLowerCase().includes(q)) : clips;
}

function listHtml() {
  const list = shown();
  const texts = list.filter(c => c.kind !== CLIP_KIND.image);
  const images = list.filter(c => c.kind === CLIP_KIND.image);
  const html = groupHtml('Pinned', texts.filter(c => c.pinned).map(rowHtml).join(''))
    + groupHtml('Recent', texts.filter(c => !c.pinned).map(rowHtml).join(''))
    + groupHtml('Images', images.length ? `<div class="clips-grid">${images.map(pictureHtml).join('')}</div>` : '');
  if (html) return html;
  return `<p class="clips-empty">${query ? 'No clip matches.' : 'Nothing copied yet. Every copy shows here, to paste again later.'}</p>`;
}

function render() {
  button.classList.toggle('paused', !keeping);
  if (panel.hidden) return;
  const typing = document.activeElement?.matches(SEARCH);
  panel.innerHTML = `
    <div class="${DOCK_GRIP}" title="Drag to resize"></div>
    <div class="files-head">
      <span class="files-title">Smart Clip <span class="files-ws">${clips.length === 1 ? '1 clip' : `${clips.length} clips`}${keeping ? '' : ' · paused'}</span></span>
      <span class="files-tools">
        <button class="pane-btn np-toggle" data-clips="${PANEL_ACTION.pause}" aria-pressed="${!keeping}" title="${keeping ? 'Pause: stop keeping copies (while sharing your screen)' : 'Paused: copies aren’t kept. Click to keep them again'}">${TOOL_ICONS.pause}</button>
        <button class="pane-btn" data-clips="${PANEL_ACTION.clear}" title="Clear history (pinned clips stay)"${clips.some(c => !c.pinned) ? '' : ' disabled'}>${ICONS.trash}</button>
        <button class="pane-btn" data-clips="${PANEL_ACTION.close}" title="Close (${KEYS_TEXT})">${ICONS.close}</button>
      </span>
    </div>
    <div class="files-bar"><input class="field files-search" type="search" placeholder="Search clips" spellcheck="false" autocomplete="off" data-clips-search value="${escapeHtml(query)}"></div>
    <div class="clips-list">${listHtml()}</div>`;
  if (typing) {
    const box = /** @type {HTMLInputElement} */ (panel.querySelector(SEARCH));
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }
  loadPictures();
}

/** Asks for the pictures the grid shows that aren't here yet, and draws each as it comes. */
function loadPictures() {
  for (const c of shown().filter(c => c.kind === CLIP_KIND.image && !pictures.has(c.id))) {
    request(PAGE.clipTake, { id: c.id, as: CLIP_FORM.picture }).then(answer => {
      if (!answer?.text) return;
      pictures.set(c.id, answer.text);
      const slot = panel.querySelector(`.clip-pic[data-clip="${CSS.escape(c.id)}"]`);
      if (slot) slot.innerHTML = `<img src="${escapeHtml(answer.text)}" alt="">`;
    });
  }
}

/** Opens the panel (it stays open while you work). */
export function openClips() {
  if (panel.hidden) toggleClips();
}

export function toggleClips() {
  panel.hidden = !panel.hidden;
  if (panel.hidden) return restoreFocus();
  send(PAGE.clipList);
  render();
  /** @type {HTMLElement | null} */ (panel.querySelector(SEARCH))?.focus();
}

/** A path clip's path, without the quotes it may have been copied with. @param {Clip} c */
const pathOf = c => c.text.trim().replace(/^["']|["']$/g, '');

/**
 * What opening a clip does: a link in the browser, a folder in the file manager, a file shown there, an image in the
 * image viewer; null for the rest (and a path that isn't on this PC).
 * @param {Clip} c
 * @returns {{ label: string, run: () => void } | null}
 */
function openOf(c) {
  if (c.kind === CLIP_KIND.url) return { label: 'Open in browser', run: () => send(PAGE.openUrl, { url: c.text.trim() }) };
  if (c.kind === CLIP_KIND.image) return { label: 'Open the image', run: () => send(PAGE.clipOpen, { id: c.id }) };
  if (c.kind !== CLIP_KIND.path || c.folder == null) return null;
  return { label: c.folder ? 'Open folder' : 'Show in the file manager', run: () => send(PAGE.openPath, { path: pathOf(c) }) };
}

/**
 * What a clip of its kind offers first: open it; a folder or a file's folder, a new terminal there; a command, run in
 * a new terminal; text, into the Notepad or a note; and the user's actions that take it (Settings › Actions).
 * @param {Clip} c
 * @param {string} text the clip's whole text
 * @returns {import('./popups.js').MenuEntry[]}
 */
function kindEntries(c, text) {
  const open = openOf(c);
  const folder = c.kind === CLIP_KIND.path && c.folder != null ? (c.folder ? pathOf(c) : parentOf(pathOf(c))) : null;
  const tab = focusedTab();
  const entries = [
    ...(open ? [{ label: open.label, icon: c.kind === CLIP_KIND.url ? ICONS.link : c.kind === CLIP_KIND.image ? ICONS.launch : ICONS.folder, action: open.run }] : []),
    ...(c.kind === CLIP_KIND.path && c.folder == null ? [{ label: 'Not found on this PC', disabled: true }] : []),
    ...(folder ? [{ label: c.folder ? 'New terminal here' : 'New terminal in its folder', icon: ICONS.terminal, action: () => newTab({ cwd: folder }) }] : []),
    ...(c.kind === CLIP_KIND.command ? [{ label: 'Run in a new terminal', icon: ICONS.terminal, action: () => newTab({ command: text.trim() }) }] : []),
    ...(c.kind === CLIP_KIND.text || c.kind === CLIP_KIND.command ? [copyToNotepadItem(text), copyToNoteItem(text)] : []),
    ...(tab && c.kind !== CLIP_KIND.image && c.kind !== CLIP_KIND.secret ? pathActions(tab, text.trim(), folder ?? '').map(a => ({ ...a, icon: ICONS.play })) : []),
  ];
  return entries.length ? [...entries, SEPARATOR] : [];
}

/**
 * A clip's right-click menu: what its kind offers (kindEntries), then paste (an image as its path), paste and run,
 * copy, pin, delete. A long clip's whole text is asked for first, so what it hands on is all of it.
 * @param {Clip} c
 * @param {MouseEvent} e
 */
async function clipMenu(c, e) {
  const isImage = c.kind === CLIP_KIND.image;
  const text = c.chars > c.text.length && c.kind !== CLIP_KIND.secret ? await take(c, CLIP_FORM.text) ?? c.text : c.text;
  showMenu([
    ...kindEntries(c, text),
    { label: isImage ? 'Paste the file path' : 'Paste', icon: ICONS.paste, action: () => pasteClip(c) },
    ...(runnable(c) ? [{ label: 'Paste and run', icon: ICONS.play, action: () => pasteClip(c, focusedTab(), true) }] : []),
    { label: isImage ? 'Copy the image' : 'Copy', icon: ICONS.copy, action: () => copyClip(c) },
    SEPARATOR,
    ...(c.kind === CLIP_KIND.secret ? [] : [{ label: c.pinned ? UNPIN_LABEL : 'Pin', icon: TOOL_ICONS.pin, action: () => send(PAGE.clipPin, { id: c.id, pinned: !c.pinned }) }]),
    { label: 'Delete', icon: ICONS.trash, hint: 'Del', action: () => send(PAGE.clipForget, { id: c.id }) },
  ], { x: e.clientX, y: e.clientY });
}

/** @param {string} act @param {Clip} c */
function clipAct(act, c) {
  if (act === CLIP_ACTION.open) openOf(c)?.run();
  else if (act === CLIP_ACTION.run) pasteClip(c, focusedTab(), true);
  else if (act === CLIP_ACTION.pin) send(PAGE.clipPin, { id: c.id, pinned: !c.pinned });
  else if (act === CLIP_ACTION.forget) send(PAGE.clipForget, { id: c.id });
}

panel.addEventListener('click', e => {
  const tool = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-clips]'))?.dataset.clips;
  if (tool === PANEL_ACTION.close) return toggleClips();
  if (tool === PANEL_ACTION.clear) return send(PAGE.clipClear);
  if (tool === PANEL_ACTION.pause) return updateSettings(GROUPS.clips, { enabled: !keeping });
  const el = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-clip]'));
  const c = el && clipById(/** @type {string} */ (el.dataset.clip));
  if (!c) return;
  const act = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-clip-act]'))?.dataset.clipAct;
  if (act) return clipAct(act, c);
  // The second click of a double click pastes (dblclick), it doesn't fold.
  if (e.detail > 1) return;
  selected = selected === c.id ? null : c.id;
  drawList();
});

panel.addEventListener('dblclick', e => {
  if (targetOf(e).closest('[data-clip-act]')) return;
  const el = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-clip]'));
  const c = el && clipById(/** @type {string} */ (el.dataset.clip));
  if (!c) return;
  if (selected !== c.id) {
    selected = c.id;
    drawList();
  }
  pasteClip(c);
});

/** Deletes the selected clip; the one after it (or before, at the end) is selected instead. */
function forgetSelected() {
  const list = shown();
  const i = list.findIndex(c => c.id === selected);
  if (i < 0) return;
  send(PAGE.clipForget, { id: list[i].id });
  selected = (list[i + 1] ?? list[i - 1])?.id ?? null;
}

/** Draws the list again where it was scrolled (the head and search box stay). */
function drawList() {
  const list = /** @type {HTMLElement | null} */ (panel.querySelector(LIST));
  if (!list) return;
  const scroll = list.scrollTop;
  list.innerHTML = listHtml();
  list.scrollTop = scroll;
  loadPictures();
}

panel.addEventListener('contextmenu', e => {
  const el = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-clip]'));
  const c = el && clipById(/** @type {string} */ (el.dataset.clip));
  if (!c) return;
  e.preventDefault();
  clipMenu(c, e);
});

panel.addEventListener('input', e => {
  if (!targetOf(e).matches(SEARCH)) return;
  query = /** @type {HTMLInputElement} */ (e.target).value;
  drawList();
});

panel.addEventListener('keydown', e => {
  const chosen = selected ? clipById(selected) : shown()[0];
  if (e.key === 'Escape' && !e.ctrlKey && !e.shiftKey && !e.altKey) restoreFocus();
  else if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey && !e.altKey && chosen) pasteClip(chosen);
  // In the search box Delete deletes letters.
  else if (e.key === 'Delete' && !e.ctrlKey && !e.shiftKey && !e.altKey && selected && !targetOf(e).matches(SEARCH)) forgetSelected();
  else if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === CLIPS_KEY) toggleClips();
  else return;
  e.preventDefault();
  e.stopPropagation();
});

// Dragged onto a terminal, a clip pastes there (terminals.js takes the drop).
panel.addEventListener('dragstart', e => {
  const el = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-clip]'));
  if (!el || !e.dataTransfer) return;
  e.dataTransfer.setData(CLIP_DRAG, /** @type {string} */ (el.dataset.clip));
  e.dataTransfer.effectAllowed = 'copy';
});

on(EVENTS.clipDrop, (/** @type {{ tab: Tab, id: string }} */ { tab, id }) => {
  const c = clipById(id);
  if (c) pasteClip(c, tab);
});

onHost(HOST.clipClips, m => {
  clips = m.items;
  keeping = m.keeping;
  for (const id of pictures.keys()) if (!clipById(id)) pictures.delete(id);
  if (selected && !clipById(selected)) selected = null;
  render();
});

button.addEventListener('click', () => toggleClips());

dockRight(panel, { dockVar: '--clips-dock', minWidth: MIN_WIDTH_PX, resized: scheduleFit });

send(PAGE.clipList);
