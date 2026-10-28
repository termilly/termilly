// @ts-check
// The Files panel's "Copy to" (filepanel.js): which terminal's folder the files and folders selected go to, and what
// to do about the ones already there. The window lists the terminals whose files can be shown, by workspace, and
// browses the folders of the one chosen, starting where its shell is; the copy itself is the host's (FileCopies.cs).

import { PAGE } from './protocol.js';
import { request } from './host.js';
import { state, tabsOf, tabTitle, isSsh } from './store.js';
import { modal, noticeDialog } from './dialogs.js';
import { escapeHtml, ICONS } from './ui.js';
import { find, targetOf } from './dom.js';
import {
  hasFiles, shellFolderOf, placeOf, folderOf, sameMachine, joinPath, parentOf, isInside, freeName, folderName, DRIVE_ICON,
} from './filepaths.js';
import { FILE_OP, FOLDER_PATH } from './constants.js';

/** What to do about the items already in the folder. */
const CONFLICT = Object.freeze({ replace: 'replace', skip: 'skip', keep: 'keep' });
/** How many of the items already there the question names. */
const CLASHES_SHOWN = 8;

/** A file or folder to copy, as the panel lists it. */
/** @typedef {{ name: string, isDirectory: boolean }} CopyItem */
/** Where the items go and under which names. */
/** @typedef {{ to: Tab, dir: string, items: { path: string, name: string }[] }} CopyPlan */
/** The window's state: the terminal chosen, the folder it shows and the subfolder clicked in it. */
/**
 * @typedef {{ tab: Tab | null, path: string, folders: { name: string, label?: string | null }[], sub: string | null,
 *   loading: boolean, error: string | null, filter: string, listings: number }} Picker
 */

/**
 * Asks where `items` (in `sourceDir`, a folder of `source`) go, then about the ones already there. Resolves with what
 * to copy where, or null when cancelled.
 * @param {Tab} source
 * @param {string} sourceDir
 * @param {CopyItem[]} items
 * @returns {Promise<CopyPlan | null>}
 */
export async function planCopy(source, sourceDir, items) {
  const target = await pickFolder(source, items.length);
  if (!target) return null;
  const { tab, dir } = target;
  const same = sameMachine(source, tab);
  const inside = same && items.find(i => i.isDirectory && isInside(dir, joinPath(sourceDir, i.name)));
  if (inside) {
    await noticeDialog({ title: 'Can’t copy a folder into itself', body: `${dir} is in ${inside.name}.` });
    return null;
  }
  const m = await request(PAGE.filesList, { id: tab.id, path: dir });
  if (m.error || m.ok === false) {
    await noticeDialog({ title: 'Can’t open the folder', body: m.message ?? m.error });
    return null;
  }
  // Names on a server tell case apart; here they don't.
  const key = isSsh(tab) ? (/** @type {string} */ n) => n : (/** @type {string} */ n) => n.toLowerCase();
  const taken = new Set((m.entries ?? []).map((/** @type {{ name: string }} */ e) => key(e.name)));
  const clashes = items.filter(i => taken.has(key(i.name)));
  const samePlace = same && key(m.path) === key(sourceDir);
  const choice = clashes.length ? await askConflict(clashes, m.path, samePlace) : CONFLICT.replace;
  if (!choice) return null;
  const copies = [];
  for (const item of items) {
    const clash = taken.has(key(item.name));
    if (clash && choice === CONFLICT.skip) continue;
    const name = clash && choice === CONFLICT.keep ? freeName(item.name, item.isDirectory, taken, key) : item.name;
    taken.add(key(name));
    copies.push({ path: joinPath(sourceDir, item.name), name });
  }
  return copies.length ? { to: tab, dir: m.path, items: copies } : null;
}

/**
 * Asks what to do about the items already in the folder: replace them (a folder merges), skip them, or keep both.
 * Copying into the folder they're in can only keep both.
 * @param {CopyItem[]} clashes
 * @param {string} dir
 * @param {boolean} samePlace
 * @returns {Promise<string | null>}
 */
function askConflict(clashes, dir, samePlace) {
  const names = clashes.slice(0, CLASHES_SHOWN).map(c => `<li>${c.isDirectory ? '📁' : '📄'} ${escapeHtml(c.name)}</li>`).join('');
  const more = clashes.length > CLASHES_SHOWN ? `<li class="copyto-more">and ${clashes.length - CLASHES_SHOWN} more</li>` : '';
  const title = clashes.length === 1 ? `${clashes[0].name} is already there` : `${clashes.length} items are already there`;
  return modal('copyto-clash', `
    <h3>${escapeHtml(title)}</h3>
    <p class="dialog-sub">In ${escapeHtml(dir)}</p>
    <ul class="copyto-clashes">${names}${more}</ul>
    <p class="dialog-sub">${samePlace ? (clashes.length === 1 ? 'This is the folder it’s in, so the copy gets a new name.' : 'This is the folder they’re in, so the copies get new names.')
      : 'Replace overwrites files with the same name and merges folders into the ones there. Keep both names the copies “name (1)”.'}</p>
    <div class="dialog-actions">
      <button class="btn" data-cancel>Cancel</button>
      ${samePlace ? '' : `<button class="btn" data-choice="${CONFLICT.skip}">Skip these</button>`}
      <button class="btn primary" data-choice="${CONFLICT.keep}" autofocus>Keep both</button>
      ${samePlace ? '' : `<button class="btn danger" data-choice="${CONFLICT.replace}">Replace</button>`}
    </div>`, (dialog, close) => {
    dialog.addEventListener('click', e => {
      const choice = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-choice]'))?.dataset.choice;
      if (choice) close(choice);
    });
    return { submit: () => close(CONFLICT.keep) };
  });
}

// ---- The window: terminals on the left, the chosen one's folders on the right ----

/** The terminals whose files can be shown, by workspace in the sidebar's order. */
const terminals = () => state.workspaces.map(ws => ({ ws, tabs: tabsOf(ws).filter(hasFiles) })).filter(g => g.tabs.length);

/**
 * Whether a terminal matches what's typed in the filter: its name, workspace or host.
 * @param {Tab} tab
 * @param {string} wsName
 * @param {string} filter
 */
const matches = (tab, wsName, filter) => !filter || [tabTitle(tab), wsName, placeOf(tab)].some(t => t.toLowerCase().includes(filter));

/**
 * The terminals' list, filtered.
 * @param {Picker} p
 * @param {Tab} source
 */
function termsHtml(p, source) {
  const html = terminals().map(({ ws, tabs }) => {
    const shown = tabs.filter(t => matches(t, ws.name, p.filter));
    return shown.length ? `<div class="copyto-ws">${escapeHtml(ws.name)}</div>${shown.map(t => `
      <div class="copyto-term${t === p.tab ? ' on' : ''}" data-tab="${escapeHtml(t.id)}">
        <span class="files-name">${escapeHtml(tabTitle(t))}${t === source ? ' <span class="copyto-host">(this one)</span>' : ''}</span>
        <span class="copyto-host">${escapeHtml(placeOf(t))}</span>
      </div>`).join('')}` : '';
  }).join('');
  return html || '<div class="inbox-empty">No terminal matches.</div>';
}

/** @param {Picker} p */
function foldersHtml(p) {
  if (!p.tab) return '';
  if (p.loading) return '<div class="inbox-empty">Loading…</div>';
  if (p.error) return `<div class="inbox-empty files-error">${escapeHtml(p.error)}</div>`;
  if (!p.folders.length) return '<div class="inbox-empty">No folders here. Copy here, or make one.</div>';
  return p.folders.map(f => `
    <div class="files-item dir${f.name === p.sub ? ' selected' : ''}" data-folder="${escapeHtml(f.name)}" title="Click to copy into it, double-click to open it">
      <span class="files-name">${f.label != null ? `${DRIVE_ICON}${escapeHtml(`${f.label} (${f.name.replace(/\\$/, '')})`)}` : `📁 ${escapeHtml(f.name)}`}</span>
    </div>`).join('');
}

/** The folder the items go to: the subfolder clicked, else the one shown; none on the drives. @param {Picker} p */
const copyTarget = p => (p.sub ? joinPath(p.path, p.sub) : p.path === FOLDER_PATH.drives ? null : p.path);

/**
 * Draws the parts of the window that change.
 * @param {HTMLElement} dialog
 * @param {Picker} p
 * @param {Tab} source
 */
function paint(dialog, p, source) {
  find(dialog, '[data-terms]').innerHTML = termsHtml(p, source);
  find(dialog, '[data-folders]').innerHTML = foldersHtml(p);
  // In a <bdi>: the path's own direction stays left to right while a long one is cut at its start (app.css).
  find(dialog, '[data-path]').innerHTML = p.tab ? `<bdi>${escapeHtml(folderName(p.path))}</bdi>` : '';
  paintTarget(dialog, p);
  /** @type {HTMLButtonElement} */ (find(dialog, '[data-mkdir]')).disabled = !p.tab || p.path === FOLDER_PATH.drives;
}

/**
 * Selects a folder in the list (or none) without drawing the list again, so a double click keeps the row it
 * started on and goes into it.
 * @param {HTMLElement} dialog
 * @param {Picker} p
 * @param {string | null} sub
 */
function selectFolder(dialog, p, sub) {
  p.sub = sub;
  for (const row of /** @type {NodeListOf<HTMLElement>} */ (dialog.querySelectorAll('[data-folder]'))) {
    row.classList.toggle('selected', row.dataset.folder === sub);
  }
  paintTarget(dialog, p);
}

/**
 * The folder the items go to, below the lists, and whether they can go there.
 * @param {HTMLElement} dialog
 * @param {Picker} p
 */
function paintTarget(dialog, p) {
  const target = copyTarget(p);
  find(dialog, '[data-target]').textContent = target && p.tab ? `To ${folderOf(p.tab, target)}` : '';
  /** @type {HTMLButtonElement} */ (find(dialog, '[data-ok]')).disabled = !target;
}

/**
 * Lists a folder of the chosen terminal; an answer that comes after another was asked for is dropped.
 * @param {HTMLElement} dialog
 * @param {Picker} p
 * @param {Tab} source
 * @param {string} path
 * @param {string | null} [sub] the subfolder to select once it's listed
 */
async function browse(dialog, p, source, path, sub = null) {
  if (!p.tab) return;
  const asked = ++p.listings;
  Object.assign(p, { loading: true, error: null, sub: null });
  paint(dialog, p, source);
  const m = await request(PAGE.filesList, { id: p.tab.id, path });
  if (asked !== p.listings) return;
  p.loading = false;
  if (m.error || m.ok === false) p.error = m.message ?? m.error;
  else Object.assign(p, { path: m.path, folders: (m.entries ?? []).filter((/** @type {{ isDirectory: boolean }} */ e) => e.isDirectory), sub });
  paint(dialog, p, source);
}

/**
 * Chooses a terminal: its folders show, from where its shell is.
 * @param {HTMLElement} dialog
 * @param {Picker} p
 * @param {Tab} source
 * @param {Tab} tab
 */
function choose(dialog, p, source, tab) {
  if (p.tab === tab) return;
  p.tab = tab;
  browse(dialog, p, source, shellFolderOf(tab));
}

/** The terminals the filter shows, in order. @param {Picker} p */
const shownTerms = p => terminals().flatMap(({ ws, tabs }) => tabs.filter(t => matches(t, ws.name, p.filter)));

/**
 * The filter changed, or an arrow key moved: the terminal chosen stays if it's still shown, else the first one is.
 * @param {HTMLElement} dialog
 * @param {Picker} p
 * @param {Tab} source
 * @param {number} [step] up (-1) or down (1) the list
 */
function refilter(dialog, p, source, step = 0) {
  const shown = shownTerms(p);
  const at = p.tab ? shown.indexOf(p.tab) : -1;
  const next = shown[at < 0 ? 0 : Math.max(0, Math.min(shown.length - 1, at + step))];
  if (next) choose(dialog, p, source, next);
  paint(dialog, p, source);
  find(dialog, '.copyto-term.on')?.scrollIntoView({ block: 'nearest' });
}

/**
 * Makes a folder in the folder shown (the name typed in the row that New folder adds), then selects it.
 * @param {HTMLElement} dialog
 * @param {Picker} p
 * @param {Tab} source
 * @param {string} name
 */
async function makeFolder(dialog, p, source, name) {
  if (!p.tab || !name) return paint(dialog, p, source);
  const m = await request(PAGE.filesOp, { id: p.tab.id, op: FILE_OP.makeDirectory, path: joinPath(p.path, name) });
  if (m.ok === false) {
    p.error = m.message;
    return paint(dialog, p, source);
  }
  browse(dialog, p, source, p.path, name);
}

/**
 * The window's markup.
 * @param {number} count
 */
const pickerHtml = count => `
  <h3>Copy ${count === 1 ? '1 item' : `${count} items`} to</h3>
  <div class="copyto">
    <div class="copyto-side">
      <input class="field" data-filter placeholder="Filter terminals" spellcheck="false" autofocus>
      <div class="copyto-list" data-terms></div>
    </div>
    <div class="copyto-side">
      <div class="copyto-bar">
        <button class="btn small" data-up title="Up a folder">↑</button>
        <button class="btn small" data-mkdir title="New folder">${ICONS.plus}</button>
        <span class="copyto-path" data-path></span>
      </div>
      <div class="copyto-list" data-folders></div>
    </div>
  </div>
  <div class="dialog-actions">
    <span class="copyto-target" data-target></span>
    <button class="btn" data-cancel>Cancel</button>
    <button class="btn primary" data-ok>Copy here</button>
  </div>`;

/**
 * The window: resolves with the terminal and folder picked, or null.
 * @param {Tab} source
 * @param {number} count
 * @returns {Promise<{ tab: Tab, dir: string } | null>}
 */
function pickFolder(source, count) {
  /** @type {Picker} */
  const p = { tab: null, path: '', folders: [], sub: null, loading: false, error: null, filter: '', listings: 0 };
  /** @type {(e: KeyboardEvent) => void} */
  let keys = () => {};
  const picked = modal('copyto-dialog', pickerHtml(count), (dialog, close) => {
    keys = pickerKeys(dialog, p, source);
    window.addEventListener('keydown', keys, true);
    wirePicker(dialog, p, source);
    // The first terminal that isn't the one the files are in, if there is one.
    const first = shownTerms(p).find(t => t !== source) ?? source;
    choose(dialog, p, source, first);
    const submit = () => {
      const dir = copyTarget(p);
      if (p.tab && dir && !p.loading) close({ tab: p.tab, dir });
    };
    return { submit };
  });
  return picked.finally(() => window.removeEventListener('keydown', keys, true));
}

/**
 * The window's clicks and typing.
 * @param {HTMLElement} dialog
 * @param {Picker} p
 * @param {Tab} source
 */
function wirePicker(dialog, p, source) {
  dialog.addEventListener('input', e => {
    if (!targetOf(e).matches('[data-filter]')) return;
    p.filter = /** @type {HTMLInputElement} */ (e.target).value.trim().toLowerCase();
    refilter(dialog, p, source);
  });
  dialog.addEventListener('click', e => {
    const term = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-tab]'))?.dataset.tab;
    const folder = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-folder]'))?.dataset.folder;
    if (term) choose(dialog, p, source, /** @type {Tab} */ (state.tabs.get(term)));
    else if (folder != null) selectFolder(dialog, p, e.detail > 1 || p.sub !== folder ? folder : null);
    else if (targetOf(e).closest('[data-up]') && p.tab) browse(dialog, p, source, parentOf(p.path));
    else if (targetOf(e).closest('[data-mkdir]')) newFolderRow(dialog);
  });
  dialog.addEventListener('dblclick', e => {
    const folder = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-folder]'))?.dataset.folder;
    if (folder != null) browse(dialog, p, source, p.path === FOLDER_PATH.drives ? folder : joinPath(p.path, folder));
  });
  dialog.addEventListener('focusout', e => {
    if (targetOf(e).matches('[data-new-folder]')) makeFolder(dialog, p, source, /** @type {HTMLInputElement} */ (e.target).value.trim());
  });
}

/** Adds the row where a new folder's name is typed (Enter or leaving it makes the folder, Escape drops it). @param {HTMLElement} dialog */
function newFolderRow(dialog) {
  const list = find(dialog, '[data-folders]');
  list.querySelector('.inbox-empty')?.remove();
  list.insertAdjacentHTML('afterbegin', '<div class="files-item dir"><input class="field" data-new-folder placeholder="New folder" spellcheck="false"></div>');
  /** @type {HTMLElement} */ (list.querySelector('[data-new-folder]')).focus();
}

/**
 * The keys the window takes before the dialog does: arrows move through the terminals; Enter and Escape in the new
 * folder's row make it or drop it rather than copying or closing.
 * @param {HTMLElement} dialog
 * @param {Picker} p
 * @param {Tab} source
 */
const pickerKeys = (dialog, p, source) => (/** @type {KeyboardEvent} */ e) => {
  const naming = targetOf(e).matches('[data-new-folder]');
  if (naming && (e.key === 'Enter' || e.key === 'Escape')) {
    e.preventDefault();
    e.stopPropagation();
    const input = /** @type {HTMLInputElement} */ (e.target);
    if (e.key === 'Escape') input.value = '';
    input.blur();
  } else if (!naming && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    refilter(dialog, p, source, e.key === 'ArrowDown' ? 1 : -1);
  }
};
