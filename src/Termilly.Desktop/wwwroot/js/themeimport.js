// @ts-check
// Importing another terminal's colour scheme (Settings › Appearance › Theme › Import): drop a file or choose one (read
// by schemes.js), or pick one of the iTerm2 Color Schemes collection, fetched from GitHub only when asked to Browse.
// The picked scheme is previewed, then saved with the imported themes and shown (themes.js works out the rest).

import { PAGE } from './protocol.js';
import { request } from './host.js';
import { state, GROUPS } from './store.js';
import { updateSettings } from './preferences.js';
import { modal } from './dialogs.js';
import { readSchemes, SCHEME_ERROR } from './schemes.js';
import { CUSTOM_THEME } from './constants.js';
import { cssColor, escapeHtml } from './ui.js';
import { find, targetOf } from './dom.js';

/** The iTerm2 Color Schemes collection, in its Windows Terminal form: the list of schemes, and one scheme's file. */
const COLLECTION = Object.freeze({
  list: 'https://api.github.com/repos/mbadolato/iTerm2-Color-Schemes/contents/windowsterminal',
  file: (/** @type {string} */ name) => `https://raw.githubusercontent.com/mbadolato/iTerm2-Color-Schemes/master/windowsterminal/${encodeURIComponent(name)}.json`,
  extension: '.json',
});
/** How much of a name its id keeps, and the id's name part when nothing of the name fits one (no Latin letters). */
const MAX_ID_NAME = 30;
const UNNAMED_ID = 'scheme';
/** The most of the collection's schemes the list shows at once; the search narrows it. */
const MAX_LISTED = 200;

/** The collection's scheme names, once fetched (for the rest of the session). */
/** @type {string[] | null} */
let collection = null;

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

/** @param {string} name */
const sameName = name => (/** @type {{ name: string }} */ t) => t.name.trim().toLowerCase() === name.trim().toLowerCase();

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
  const theme = { id, name: s.name, background: s.background, foreground: s.foreground, cursor: s.cursor, ansi: s.ansi };
  updateSettings(GROUPS.interface, { customThemes: [theme, ...others].slice(0, CUSTOM_THEME.maxThemes), theme: id });
  return id;
}

/** The collection's scheme names, fetched once. */
async function fetchCollection() {
  if (collection) return collection;
  const response = await fetch(COLLECTION.list);
  if (!response.ok) throw new Error(`GitHub said ${response.status}`);
  const files = /** @type {{ name: string, type: string }[]} */ (await response.json());
  collection = files.filter(f => f.type === 'file' && f.name.endsWith(COLLECTION.extension))
    .map(f => f.name.slice(0, -COLLECTION.extension.length));
  return collection;
}

/** @param {string} name one of the collection's */
async function fetchScheme(name) {
  const response = await fetch(COLLECTION.file(name));
  if (!response.ok) throw new Error(`GitHub said ${response.status}`);
  return readSchemes(`${name}${COLLECTION.extension}`, await response.text()).schemes[0];
}

// Buttons and rows take Enter as a click (data-no-enter): only "Use this theme" saves with it.
const DIALOG = `
  <h3 id="si-title">Import a colour scheme</h3>
  <div class="si-body">
    <div class="si-pick">
      <div class="si-drop">
        <b>Drop a scheme file here</b>
        <span class="dialog-sub">From iTerm2, Windows Terminal, Ghostty, Kitty, Alacritty or Warp</span>
        <button class="btn" data-si-choose data-no-enter autofocus>Choose file</button>
      </div>
      <button class="btn si-browse" data-si-browse data-no-enter>Browse iTerm2 Color Schemes</button>
      <div class="si-collection" hidden>
        <input class="field si-search" type="search" placeholder="Search schemes" spellcheck="false" autocomplete="off" aria-label="Search schemes" data-no-enter>
        <div class="si-list" role="listbox" aria-label="Schemes"></div>
      </div>
    </div>
    <div class="si-show">
      <div class="si-preview"><p class="dialog-sub">Pick a scheme to see it here.</p></div>
      <p class="dialog-sub si-status" role="status"></p>
    </div>
  </div>
  <div class="dialog-actions">
    <button class="btn" data-cancel data-no-enter>Cancel</button>
    <button class="btn primary" data-ok disabled>Use this theme</button>
  </div>`;

/** The dialog's parts it changes, and the class its status line has for an error. */
const PART = Object.freeze({ collection: '.si-collection', list: '.si-list', search: '.si-search', status: '.si-status', preview: '.si-preview', ok: '[data-ok]' });
const ERROR_CLASS = 'error';

/** @param {unknown} error */
const reason = error => (error instanceof Error ? error.message : '');

/**
 * The Import dialog's state: the scheme picked, the schemes of a file holding several, and which of the user's
 * actions is the current one (a slower answer to an earlier one is dropped).
 */
class SchemePicker {
  /** @param {HTMLElement} dialog */
  constructor(dialog) {
    this.dialog = dialog;
    /** @type {import('./schemes.js').Scheme | null} */
    this.picked = null;
    /** @type {import('./schemes.js').Scheme[]} */
    this.fromFile = [];
    this.action = 0;
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

  /** @param {string[]} names @param {number} [selected] which one is picked, by its place */
  listNames(names, selected = -1) {
    this.list.innerHTML = names.map((n, i) => `<button class="si-row${i === selected ? ' on' : ''}" role="option" aria-selected="${i === selected}" data-no-enter data-si-row="${i}" data-si-name="${escapeHtml(n)}">${escapeHtml(n)}</button>`).join('')
      || '<p class="dialog-sub">No schemes match.</p>';
  }

  /** Shows the list, with its search box for the collection and without it for a file's schemes. @param {boolean} searching */
  showList(searching) {
    find(this.dialog, PART.collection).hidden = false;
    this.search.hidden = !searching;
  }

  /** @param {string} name @param {string} text */
  readFile(name, text) {
    try {
      const { schemes, skipped } = readSchemes(name, text);
      this.fromFile = schemes;
      this.show(schemes[0]);
      const left = skipped ? ` (${skipped} without all their colours left out)` : '';
      this.say(schemes.length > 1 ? `${schemes.length} schemes in ${name}${left}: pick one.` : `From ${name}${left}.`);
      if (schemes.length > 1) {
        this.showList(false);
        this.listNames(schemes.map(s => s.name), 0);
      }
    } catch (error) {
      this.say(reason(error) || SCHEME_ERROR.unknown, true);
    }
  }

  /** @param {File} file dropped from the file manager */
  async drop(file) {
    const action = this.begin();
    this.fromFile = [];
    if (file.size > CUSTOM_THEME.maxFileBytes) return this.say(`${file.name} is too big to be a colour scheme.`, true);
    try {
      const text = await file.text();
      if (this.current(action)) this.readFile(file.name, text);
    } catch (error) {
      if (this.current(action)) this.say(`Couldn’t read ${file.name}. ${reason(error)}`, true);
    }
  }

  async choose() {
    const action = this.begin();
    this.fromFile = [];
    const reply = await request(PAGE.schemeOpen, {});
    if (!this.current(action)) return;
    if (reply.error) this.say(reply.error, true);
    else if (reply.name && typeof reply.text === 'string') this.readFile(reply.name, reply.text);
  }

  async browse() {
    const action = this.begin();
    this.showList(true);
    this.fromFile = [];
    this.list.innerHTML = '<p class="dialog-sub">Loading the list from GitHub…</p>';
    this.say('');
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

  /** @param {HTMLElement} row */
  async pick(row) {
    for (const r of this.list.querySelectorAll('.si-row')) {
      r.classList.toggle('on', r === row);
      r.setAttribute('aria-selected', String(r === row));
    }
    const inFile = this.fromFile[Number(row.dataset.siRow)];
    if (inFile) return this.show(inFile);
    const name = /** @type {string} */ (row.dataset.siName);
    const action = this.begin();
    this.say('Loading…');
    try {
      const scheme = await fetchScheme(name);
      if (!this.current(action)) return;
      this.show(scheme);
      this.say('From iTerm2 Color Schemes on GitHub.');
    } catch (error) {
      if (this.current(action)) this.say(`Couldn’t load ${name}. ${reason(error)}`, true);
    }
  }

  /** The collection's schemes the search matches, the first ones (the search narrows them further). */
  filter() {
    const query = this.search.value.trim().toLowerCase();
    const matches = (collection ?? []).filter(n => n.toLowerCase().includes(query));
    this.listNames(matches.slice(0, MAX_LISTED));
    if (matches.length > MAX_LISTED) this.say(`${MAX_LISTED} of ${matches.length} shown: search to find others.`);
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
      e.stopPropagation(); // not a file dropped into a terminal
      const file = e.dataTransfer?.files[0];
      if (file) picker.drop(file);
    });
    dialog.addEventListener('click', e => {
      const target = targetOf(e);
      const row = /** @type {HTMLElement | null} */ (target.closest('[data-si-row]'));
      if (target.closest('[data-si-choose]')) picker.choose();
      else if (target.closest('[data-si-browse]')) picker.browse();
      else if (row) picker.pick(row);
    });
    picker.search.addEventListener('input', () => picker.filter());
    return { submit: () => { if (picker.picked) close(save(picker.picked)); } };
  });
}
