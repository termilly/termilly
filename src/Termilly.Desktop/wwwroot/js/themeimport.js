// @ts-check
// Importing other terminals' colour schemes (Settings › Appearance › Theme › Import): drop files or a folder, choose
// files or a folder (read by schemes.js), or browse the iTerm2 Color Schemes collection (schemecollection.js). Every
// scheme found goes in one list; ↑ and ↓ preview them in turn, and the one shown is saved with the imported themes.

import { PAGE } from './protocol.js';
import { request } from './host.js';
import { state, GROUPS } from './store.js';
import { updateSettings } from './preferences.js';
import { modal } from './dialogs.js';
import { readSchemes } from './schemes.js';
import { fetchCollection, fetchScheme, collectionNames } from './schemecollection.js';
import { CUSTOM_THEME } from './constants.js';
import { cssColor, escapeHtml } from './ui.js';
import { find, targetOf } from './dom.js';

/** How much of a name its id keeps, and the id's name part when nothing of the name fits one (no Latin letters). */
const MAX_ID_NAME = 30;
const UNNAMED_ID = 'scheme';
/** The most rows the list shows at once; the search narrows it. */
const MAX_LISTED = 200;
/** How long ↑ or ↓ held on the collection waits before fetching the scheme it stopped on, in ms. */
const FETCH_PAUSE_MS = 180;

/**
 * A scheme's small terminal, in its colours.
 * @param {import('./schemes.js').Scheme} s
 */
const preview = s => {
  const c = (/** @type {number} */ i, /** @type {string} */ text) => `<span style="color:${cssColor(s.ansi[i])}">${escapeHtml(text)}</span>`;
  return `<div class="si-term" style="background:${cssColor(s.background)};color:${cssColor(s.foreground)}">${c(8, '~/acme>')} npm test
 ${c(2, '✓')} src/http/retry.test.ts ${c(8, '(14)')}
 ${c(1, '✗')} src/orders/export.test.ts
 ${c(5, '●')} Edit ${c(4, 'retry.ts')} ${c(3, '+12')} ${c(6, 'done')}
${c(8, '~/acme>')} <span class="si-cursor" style="background:${cssColor(s.cursor ?? s.foreground)}"></span></div>
<div class="si-swatches">${s.ansi.map(a => `<i style="background:${cssColor(a)}"></i>`).join('')}</div>`;
};

/**
 * A name as it's saved (the host keeps its first maxName characters), so a long one matches itself after a restart.
 * @param {string} name
 */
const savedName = name => name.trim().slice(0, CUSTOM_THEME.maxName);
/** @param {string} name */
const sameName = name => (/** @type {{ name: string }} */ t) => savedName(t.name).toLowerCase() === savedName(name).toLowerCase();

/**
 * The id a scheme is saved under: its name's, unless another scheme's name has it, then with a number added.
 * @param {string} name
 * @param {{ id: string }[]} others the imported themes it's saved beside
 */
function idOf(name, others) {
  const base = CUSTOM_THEME.idPrefix + (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, MAX_ID_NAME) || UNNAMED_ID);
  let id = base;
  for (let n = 2; others.some(t => t.id === id); n++) id = `${base}-${n}`;
  return id;
}

/**
 * Saves a scheme with the imported themes (newest first; one of the same name replaced, keeping its id; the oldest
 * going past the limit) and shows it.
 * @param {import('./schemes.js').Scheme} s
 */
function save(s) {
  const saved = state.settings.interface.customThemes ?? [];
  const others = saved.filter(t => !sameName(s.name)(t));
  const id = saved.find(sameName(s.name))?.id ?? idOf(s.name, others);
  const theme = { id, name: savedName(s.name), background: s.background, foreground: s.foreground, cursor: s.cursor, ansi: s.ansi };
  updateSettings(GROUPS.interface, { customThemes: [theme, ...others].slice(0, CUSTOM_THEME.maxThemes), theme: id });
  return id;
}

/** A file found and where it is: its path in the folder dropped, or its name. */
/** @typedef {{ file: File, place: string }} DroppedFile */

/**
 * The files dropped: each file, and the files in each folder (and its folders' a few levels down, where the system
 * lets the page read them), within the limits; how many couldn't be read, and whether there were more than the limit.
 * @param {DataTransfer} transfer
 * @returns {Promise<{ files: DroppedFile[], left: number, capped: boolean }>}
 */
async function droppedFiles(transfer) {
  /** @type {DroppedFile[]} */
  const files = [];
  let left = 0;
  let capped = false;
  /** Whether there's room for one more file; when there isn't, the walk stops. */
  const room = () => !(capped ||= files.length >= CUSTOM_THEME.maxFiles);
  /** @param {FileSystemEntry} entry @param {number} depth */
  const walk = async (entry, depth) => {
    try {
      if (entry.isFile) {
        if (!room()) return;
        const file = await new Promise((resolve, reject) => /** @type {FileSystemFileEntry} */ (entry).file(resolve, reject));
        return void files.push({ file, place: entry.fullPath.replace(/^\//, '') });
      }
      if (depth > CUSTOM_THEME.folderDepth) return;
      const reader = /** @type {FileSystemDirectoryEntry} */ (entry).createReader();
      for (let batch = await readBatch(reader); batch.length; batch = await readBatch(reader)) {
        for (const child of batch) {
          if (capped) return;
          await walk(child, depth + 1);
        }
      }
    } catch {
      left++; // a file or folder the system won't give: counted, the rest still read
    }
  };
  // Taken while the drop is still going on (a drop's items can't be read once it's over): a file as it is, a folder
  // as an entry to walk (where the system gives one).
  const dropped = [...transfer.items].map(item => {
    try {
      const entry = item.webkitGetAsEntry?.();
      return entry?.isDirectory ? { folder: entry } : { file: item.getAsFile() };
    } catch {
      return { unreadable: true };
    }
  });
  for (const { file, folder, unreadable } of dropped) {
    if (unreadable) left++;
    else if (folder && !capped) await walk(folder, 0);
    else if (file && room()) files.push({ file, place: file.name });
  }
  return { files, left, capped };
}

/** @param {FileSystemDirectoryReader} reader @returns {Promise<FileSystemEntry[]>} */
const readBatch = reader => new Promise((resolve, reject) => reader.readEntries(resolve, reject));

// Buttons and rows take Enter as a click (data-no-enter): only "Use this theme" saves with it.
const DIALOG = `
  <h3 id="si-title">Import colour schemes</h3>
  <div class="si-body">
    <div class="si-pick">
      <div class="si-drop">
        <b>Drop scheme files or a folder here</b>
        <span class="dialog-sub">From iTerm2, Windows Terminal, Ghostty, Kitty, Alacritty or Warp</span>
        <span class="si-buttons"><button class="btn" data-si-choose data-no-enter autofocus>Choose files</button><button class="btn" data-si-folder data-no-enter>Choose folder</button></span>
      </div>
      <button class="btn si-browse" data-si-browse data-no-enter>Browse iTerm2 Color Schemes</button>
      <div class="si-collection" hidden>
        <input class="field si-search" type="search" placeholder="Search schemes" spellcheck="false" autocomplete="off" aria-label="Search schemes" data-no-enter>
        <div class="si-list" role="listbox" aria-label="Schemes"></div>
        <p class="dialog-sub si-more"></p>
      </div>
    </div>
    <div class="si-show">
      <div class="si-preview"><p class="dialog-sub">Pick a scheme to see it here. ↑ and ↓ go through the list.</p></div>
      <p class="dialog-sub si-status" role="status"></p>
    </div>
  </div>
  <div class="dialog-actions">
    <button class="btn" data-cancel data-no-enter>Cancel</button>
    <button class="btn primary" data-ok disabled>Use this theme</button>
  </div>`;

/** The dialog's parts it changes, and the class its status line has for an error. */
const PART = Object.freeze({ collection: '.si-collection', list: '.si-list', more: '.si-more', search: '.si-search', status: '.si-status', preview: '.si-preview', ok: '[data-ok]', row: '.si-row' });
const ERROR_CLASS = 'error';
/** Where the list's rows come from: nothing yet, files read, or the collection on GitHub. */
const SOURCE = Object.freeze({ none: 'none', file: 'file', collection: 'collection' });
/** The keys that move through the list: by one row, or to its ends. */
const LIST_KEYS = Object.freeze({ ArrowDown: 1, ArrowUp: -1, Home: -Infinity, End: Infinity });

/** @param {unknown} error */
const reason = error => (error instanceof Error ? error.message : '');
/** @param {number} n @param {string} one @param {string} many */
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The Import dialog's state: the scheme shown, the schemes read from files, where the list's rows come from, and which
 * of the user's actions is the current one (a slower answer to an earlier one is dropped).
 */
class SchemePicker {
  /** @param {HTMLElement} dialog */
  constructor(dialog) {
    this.dialog = dialog;
    /** @type {import('./schemes.js').Scheme | null} */
    this.picked = null;
    /** @type {{ scheme: import('./schemes.js').Scheme, place: string }[]} each with the file it's in */
    this.fromFiles = [];
    this.action = 0;
    /** The latest file or folder picker opened: an older one's answer is dropped. */
    this.asked = 0;
    /** @type {string} */
    this.source = SOURCE.none;
    /** The row picked (a scheme's place in fromFiles, or a collection name), kept ticked while the search shows it. */
    this.selected = '';
    this.list = find(dialog, PART.list);
    this.search = /** @type {HTMLInputElement} */ (find(dialog, PART.search));
  }

  /** A new action: what an earlier one still brings is dropped, and nothing can be used until this one shows. */
  begin() {
    this.show(null);
    return ++this.action;
  }

  /** @param {number} action */
  current(action) {
    return action === this.action && this.dialog.isConnected;
  }

  /** @param {string} text @param {boolean} [error] */
  say(text, error = false) {
    const status = find(this.dialog, PART.status);
    status.textContent = text;
    status.classList.toggle(ERROR_CLASS, error);
  }

  /** @param {import('./schemes.js').Scheme | null} s */
  show(s) {
    this.picked = s;
    /** @type {HTMLButtonElement} */ (find(this.dialog, PART.ok)).disabled = !s;
    find(this.dialog, PART.preview).innerHTML = s ? `<b class="si-name">${escapeHtml(s.name)}</b>${preview(s)}` : '';
  }

  /** A new source for the list: the old rows and search go, so a stale row can't be picked. @param {string} source */
  start(source) {
    const action = this.begin();
    this.source = source;
    this.fromFiles = [];
    this.selected = '';
    this.search.value = '';
    this.list.innerHTML = '';
    find(this.dialog, PART.more).textContent = '';
    find(this.dialog, PART.collection).hidden = source !== SOURCE.collection;
    this.say('');
    return action;
  }

  /** The rows the search matches (by name, or by the file a scheme's in), the picked one ticked. */
  filter() {
    const query = this.search.value.trim().toLowerCase();
    /** @type {[string, string, string][]} each row's key, label and file */
    const rows = this.source === SOURCE.file ? this.fromFiles.map((f, i) => [String(i), f.scheme.name, f.place])
      : this.source === SOURCE.collection ? collectionNames().map(n => [n, n, '']) : [];
    const matches = rows.filter(([, label, place]) => `${label}\n${place}`.toLowerCase().includes(query));
    this.list.innerHTML = matches.slice(0, MAX_LISTED).map(([key, label, place]) => {
      const on = key === this.selected;
      const where = place ? `<span class="si-place">${escapeHtml(place)}</span>` : '';
      return `<button class="si-row${on ? ' on' : ''}" role="option" aria-selected="${on}" data-no-enter data-si-key="${escapeHtml(key)}"><span class="si-label">${escapeHtml(label)}</span>${where}</button>`;
    }).join('') || '<p class="dialog-sub">No schemes match.</p>';
    find(this.dialog, PART.more).textContent = matches.length > MAX_LISTED ? `The first ${MAX_LISTED} of ${matches.length} shown: search to find others.` : '';
  }

  /**
   * The schemes in files read: all of them in the list, the first shown.
   * @param {import('./protocol.js').SchemeFileText[]} files
   * @param {number} left files left out before reading (too big or unreadable)
   * @param {boolean} capped more files than the limit: only the first were read
   */
  readFiles(files, left, capped) {
    let notSchemes = 0;
    let incomplete = 0;
    for (const file of files) {
      try {
        const { schemes, skipped } = readSchemes(file.name, file.text);
        this.fromFiles.push(...schemes.map(scheme => ({ scheme, place: file.place ?? file.name })));
        incomplete += skipped;
      } catch {
        notSchemes++; // a file in the folder that isn't a scheme: counted, not an error
      }
    }
    const out = [
      notSchemes && count(notSchemes, 'file isn’t a scheme', 'files aren’t schemes'),
      incomplete && count(incomplete, 'scheme misses colours', 'schemes miss colours'),
      left && `${left} left out (too big or unreadable)`,
      capped && `only the first ${CUSTOM_THEME.maxFiles} files read`,
    ].filter(Boolean);
    if (!this.fromFiles.length) return this.say(`No colour schemes found${out.length ? ` (${out.join(', ')})` : ''}.`, true);
    find(this.dialog, PART.collection).hidden = false;
    this.selected = '0';
    this.filter();
    this.show(this.fromFiles[0].scheme);
    this.say(`${count(this.fromFiles.length, 'scheme', 'schemes')} found${out.length ? `; ${out.join(', ')}` : ''}.`);
  }

  /** @param {DataTransfer} transfer files or folders dropped from the file manager */
  async drop(transfer) {
    const action = this.start(SOURCE.file);
    const { files, left, capped } = await droppedFiles(transfer);
    // One at a time, within the total, so a big drop isn't all held at once; a newer action stops it.
    let room = CUSTOM_THEME.maxTotalBytes;
    let unread = left;
    /** @type {import('./protocol.js').SchemeFileText[]} */
    const texts = [];
    for (const { file, place } of files) {
      if (!this.current(action)) return;
      if (file.size > Math.min(CUSTOM_THEME.maxFileBytes, room)) { unread++; continue; }
      try {
        texts.push({ name: file.name, text: await file.text(), place });
        room -= file.size;
      } catch {
        unread++;
      }
    }
    if (this.current(action)) this.readFiles(texts, unread, capped);
  }

  /** @param {boolean} folder a folder's files, or files picked; cancelled, the dialog keeps what it shows */
  async choose(folder) {
    // Its own count, so a picker cancelled leaves a list still loading from GitHub to finish.
    const asked = ++this.asked;
    const reply = await request(PAGE.schemeOpen, { folder });
    if (asked !== this.asked || !this.dialog.isConnected || (!reply.files && !reply.error)) return;
    this.start(SOURCE.file);
    if (reply.error) return this.say(reply.error, true);
    const files = reply.files ?? [];
    // The host reads one past the limit, so a folder with more says so.
    const over = Math.max(0, files.length + (reply.skipped ?? 0) - CUSTOM_THEME.maxFiles);
    this.readFiles(files, (reply.skipped ?? 0) - over, over > 0);
  }

  async browse() {
    const action = this.start(SOURCE.collection);
    this.list.innerHTML = '<p class="dialog-sub">Loading the list from GitHub…</p>';
    try {
      await fetchCollection();
      if (!this.current(action)) return;
      this.filter();
      this.search.focus();
    } catch (error) {
      if (!this.current(action)) return;
      this.list.innerHTML = '';
      this.say(`Couldn’t load the list from GitHub. ${reason(error)}`, true);
    }
  }

  /** @param {HTMLElement} row @param {boolean} [stepping] reached with ↑ or ↓: a fetch waits a moment, in case it's passed */
  async pick(row, stepping = false) {
    const key = /** @type {string} */ (row.dataset.siKey);
    this.selected = key;
    for (const r of this.list.querySelectorAll(PART.row)) {
      r.classList.toggle('on', r === row);
      r.setAttribute('aria-selected', String(r === row));
    }
    if (this.source === SOURCE.file) return this.show(this.fromFiles[Number(key)]?.scheme ?? null);
    if (this.source !== SOURCE.collection) return;
    const action = this.begin();
    this.say('Loading…');
    if (stepping) await new Promise(resolve => setTimeout(resolve, FETCH_PAUSE_MS));
    if (!this.current(action)) return;
    try {
      const scheme = await fetchScheme(key);
      if (!this.current(action)) return;
      this.show(scheme);
      this.say('From iTerm2 Color Schemes on GitHub.');
    } catch (error) {
      if (this.current(action)) this.say(`Couldn’t load ${key}. ${reason(error)}`, true);
    }
  }

  /**
   * ↑ ↓ Home End in the list or its search box: the row beside the picked one (or the first or last) is picked and shown.
   * @param {KeyboardEvent} e
   */
  step(e) {
    const by = LIST_KEYS[/** @type {keyof typeof LIST_KEYS} */ (e.key)];
    const target = targetOf(e);
    const inList = target === this.search || this.list.contains(target);
    // Home and End move the caret in the search box; only ↑ and ↓ leave it.
    if (by === undefined || !inList || (target === this.search && !Number.isFinite(by))) return false;
    const rows = /** @type {HTMLElement[]} */ ([...this.list.querySelectorAll(PART.row)]);
    if (!rows.length) return false;
    const at = rows.findIndex(r => r.classList.contains('on'));
    const next = Number.isFinite(by) ? Math.min(rows.length - 1, Math.max(0, at < 0 ? 0 : at + by)) : by < 0 ? 0 : rows.length - 1;
    if (target !== this.search) rows[next].focus(); // from the search box, typing goes on there
    rows[next].scrollIntoView({ block: 'nearest' });
    if (next !== at) this.pick(rows[next], true); // at an end the key does nothing, so the scheme shown stays
    return true;
  }
}

/**
 * The Import dialog. Resolves with the imported theme's id, or null when cancelled.
 * @returns {Promise<string | null>}
 */
export function importScheme() {
  return modal('scheme-import', DIALOG, (dialog, close) => {
    dialog.setAttribute('aria-labelledby', 'si-title');
    const picker = new SchemePicker(dialog);
    dialog.addEventListener('dragover', e => e.preventDefault());
    dialog.addEventListener('drop', e => {
      e.preventDefault();
      e.stopPropagation(); // not files dropped into a terminal
      if (e.dataTransfer) picker.drop(e.dataTransfer);
    });
    dialog.addEventListener('click', e => {
      const target = targetOf(e);
      const row = /** @type {HTMLElement | null} */ (target.closest('[data-si-key]'));
      if (target.closest('[data-si-choose]')) picker.choose(false);
      else if (target.closest('[data-si-folder]')) picker.choose(true);
      else if (target.closest('[data-si-browse]')) picker.browse();
      else if (row) picker.pick(row);
    });
    picker.search.addEventListener('input', () => picker.filter());
    return { submit: () => { if (picker.picked) close(save(picker.picked)); }, key: e => picker.step(e) };
  });
}
