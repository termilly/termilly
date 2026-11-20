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

/**
 * The files dropped: each file, and the files in each folder (and its folders' a few levels down, where the system
 * lets the page read them), within the limits; how many were left out.
 * @param {DataTransfer} transfer
 * @returns {Promise<{ files: File[], skipped: number }>}
 */
async function droppedFiles(transfer) {
  /** @type {File[]} */
  const files = [];
  let skipped = 0;
  /** @param {FileSystemEntry} entry @param {number} depth */
  const walk = async (entry, depth) => {
    if (files.length >= CUSTOM_THEME.maxFiles) return void skipped++;
    if (entry.isFile) return files.push(await new Promise((resolve, reject) => /** @type {FileSystemFileEntry} */ (entry).file(resolve, reject)));
    if (depth > CUSTOM_THEME.folderDepth) return;
    const reader = /** @type {FileSystemDirectoryEntry} */ (entry).createReader();
    for (let batch = await readBatch(reader); batch.length; batch = await readBatch(reader)) {
      for (const child of batch) await walk(child, depth + 1);
    }
  };
  const entries = [...transfer.items].map(i => i.webkitGetAsEntry?.()).filter(e => !!e);
  if (!entries.length) return { files: [...transfer.files].slice(0, CUSTOM_THEME.maxFiles), skipped: Math.max(0, transfer.files.length - CUSTOM_THEME.maxFiles) };
  for (const entry of entries) await walk(/** @type {FileSystemEntry} */ (entry), 0);
  return { files, skipped };
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
const PART = Object.freeze({ collection: '.si-collection', list: '.si-list', search: '.si-search', status: '.si-status', preview: '.si-preview', ok: '[data-ok]', row: '.si-row' });
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
    /** @type {import('./schemes.js').Scheme[]} */
    this.fromFiles = [];
    this.action = 0;
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
    find(this.dialog, PART.collection).hidden = source !== SOURCE.collection;
    this.say('');
    return action;
  }

  /** The rows the search matches, the picked one ticked. */
  filter() {
    const query = this.search.value.trim().toLowerCase();
    /** @type {[string, string][]} each row's key and label */
    const rows = this.source === SOURCE.file ? this.fromFiles.map((s, i) => [String(i), s.name])
      : this.source === SOURCE.collection ? collectionNames().map(n => [n, n]) : [];
    const matches = rows.filter(([, label]) => label.toLowerCase().includes(query));
    this.list.innerHTML = matches.slice(0, MAX_LISTED).map(([key, label]) => {
      const on = key === this.selected;
      return `<button class="si-row${on ? ' on' : ''}" role="option" aria-selected="${on}" data-no-enter data-si-key="${escapeHtml(key)}">${escapeHtml(label)}</button>`;
    }).join('') || '<p class="dialog-sub">No schemes match.</p>';
    if (matches.length > MAX_LISTED) this.say(`The first ${MAX_LISTED} of ${matches.length} shown: search to find others.`);
  }

  /**
   * The schemes in files read: all of them in the list, the first shown.
   * @param {{ name: string, text: string }[]} files
   * @param {number} [left] files left out before reading (too big, past the limits)
   */
  readFiles(files, left = 0) {
    let notSchemes = 0;
    let incomplete = 0;
    for (const file of files) {
      try {
        const { schemes, skipped } = readSchemes(file.name, file.text);
        this.fromFiles.push(...schemes);
        incomplete += skipped;
      } catch {
        notSchemes++; // a file in the folder that isn't a scheme: counted, not an error
      }
    }
    const out = [left + notSchemes && count(left + notSchemes, 'file isn’t a scheme', 'files aren’t schemes'), incomplete && count(incomplete, 'scheme misses colours', 'schemes miss colours')].filter(Boolean);
    if (!this.fromFiles.length) return this.say(`No colour schemes found${out.length ? ` (${out.join(', ')})` : ''}.`, true);
    find(this.dialog, PART.collection).hidden = false;
    this.selected = '0';
    this.filter();
    this.show(this.fromFiles[0]);
    this.say(`${count(this.fromFiles.length, 'scheme', 'schemes')} found${out.length ? `; ${out.join(', ')}` : ''}.`);
  }

  /** @param {DataTransfer} transfer files or folders dropped from the file manager */
  async drop(transfer) {
    const action = this.start(SOURCE.file);
    try {
      const { files, skipped } = await droppedFiles(transfer);
      const small = files.filter(f => f.size <= CUSTOM_THEME.maxFileBytes);
      const texts = await Promise.all(small.map(async f => ({ name: f.webkitRelativePath || f.name, text: await f.text() })));
      if (this.current(action)) this.readFiles(texts, skipped + files.length - small.length);
    } catch (error) {
      if (this.current(action)) this.say(`Couldn’t read what was dropped. ${reason(error)}`, true);
    }
  }

  /** @param {boolean} folder a folder's files, or files picked */
  async choose(folder) {
    const action = this.start(SOURCE.file);
    const reply = await request(PAGE.schemeOpen, { folder });
    if (!this.current(action)) return;
    if (reply.error) this.say(reply.error, true);
    else if (reply.files?.length || reply.skipped) this.readFiles(reply.files ?? [], reply.skipped ?? 0);
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
    if (this.source === SOURCE.file) return this.show(this.fromFiles[Number(key)] ?? null);
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
    this.pick(rows[next], true);
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
