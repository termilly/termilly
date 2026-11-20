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
import { cssColor, escapeHtml } from './ui.js';
import { find, targetOf } from './dom.js';

/** The iTerm2 Color Schemes collection, in its Windows Terminal form: the list of schemes, and one scheme's file. */
const COLLECTION = Object.freeze({
  list: 'https://api.github.com/repos/mbadolato/iTerm2-Color-Schemes/contents/windowsterminal',
  file: (/** @type {string} */ name) => `https://raw.githubusercontent.com/mbadolato/iTerm2-Color-Schemes/master/windowsterminal/${encodeURIComponent(name)}.json`,
  extension: '.json',
});
/** Every imported theme's id starts with this (C#'s CustomTheme.IdPrefix); the rest is its name's. */
const ID_PREFIX = 'custom-';
const MAX_ID_NAME = 30;
/** The most schemes the list shows at once; the search narrows it. */
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

/**
 * The id an imported scheme is saved under: from its name, so importing it again replaces it.
 * @param {string} name
 */
const idOf = name => ID_PREFIX + (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, MAX_ID_NAME) || 'scheme');

/**
 * Saves a scheme with the imported themes (newest first, one of the same name replaced) and shows it.
 * @param {import('./schemes.js').Scheme} s
 */
function save(s) {
  const id = idOf(s.name);
  const theme = { id, name: s.name, background: s.background, foreground: s.foreground, cursor: s.cursor, ansi: s.ansi };
  const others = (state.settings.interface.customThemes ?? []).filter(t => t.id !== id);
  updateSettings(GROUPS.interface, { customThemes: [theme, ...others], theme: id });
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
  return readSchemes(`${name}${COLLECTION.extension}`, await response.text());
}

const DIALOG = `
  <h3>Import a colour scheme</h3>
  <div class="si-body">
    <div class="si-pick">
      <div class="si-drop">
        <b>Drop a scheme file here</b>
        <span class="dialog-sub">From iTerm2, Windows Terminal, Ghostty, Kitty, Alacritty or Warp</span>
        <button class="btn" data-si-choose>Choose file</button>
      </div>
      <button class="btn si-browse" data-si-browse>Browse iTerm2 Color Schemes</button>
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
    <button class="btn" data-cancel>Cancel</button>
    <button class="btn primary" data-ok disabled>Use this theme</button>
  </div>`;

/** The dialog's parts it changes, and the class its status line has for an error. */
const PART = Object.freeze({ collection: '.si-collection', list: '.si-list', search: '.si-search', status: '.si-status', preview: '.si-preview' });
const ERROR_CLASS = 'error';

/** @param {unknown} error */
const reason = error => (error instanceof Error ? error.message : '');

/** The Import dialog's state: the scheme picked, and the schemes of a file holding several. */
class SchemePicker {
  /** @param {HTMLElement} dialog */
  constructor(dialog) {
    this.dialog = dialog;
    /** @type {import('./schemes.js').Scheme | null} */
    this.picked = null;
    /** @type {import('./schemes.js').Scheme[]} */
    this.fromFile = [];
    this.list = find(dialog, PART.list);
    this.search = /** @type {HTMLInputElement} */ (find(dialog, PART.search));
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
    /** @type {HTMLButtonElement} */ (find(this.dialog, '[data-ok]')).disabled = !s;
    find(this.dialog, PART.preview).innerHTML = s ? `<b class="si-name">${escapeHtml(s.name)}</b>${preview(s)}` : '';
  }

  /** @param {string[]} names @param {string} [current] */
  listNames(names, current) {
    this.list.innerHTML = names.slice(0, MAX_LISTED).map(n => `<button class="si-row${n === current ? ' on' : ''}" role="option" data-si-name="${escapeHtml(n)}">${escapeHtml(n)}</button>`).join('')
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
      this.fromFile = readSchemes(name, text);
      this.show(this.fromFile[0]);
      const several = this.fromFile.length > 1;
      this.say(several ? `${this.fromFile.length} schemes in ${name}: pick one.` : `From ${name}.`);
      if (several) {
        this.showList(false);
        this.listNames(this.fromFile.map(s => s.name), this.fromFile[0].name);
      }
    } catch (error) {
      this.show(null);
      this.say(reason(error) || SCHEME_ERROR.unknown, true);
    }
  }

  async choose() {
    const reply = await request(PAGE.schemeOpen, {});
    if (reply.error) this.say(reply.error, true);
    else if (reply.name && typeof reply.text === 'string') this.readFile(reply.name, reply.text);
  }

  async browse() {
    this.showList(true);
    this.fromFile = [];
    this.list.innerHTML = '<p class="dialog-sub">Loading the list from GitHub…</p>';
    try {
      this.listNames(await fetchCollection());
      this.search.focus();
    } catch (error) {
      this.list.innerHTML = '';
      this.say(`Couldn’t load the list from GitHub. ${reason(error)}`, true);
    }
  }

  /** @param {HTMLElement} row */
  async pick(row) {
    for (const r of this.list.querySelectorAll('.si-row')) r.classList.toggle('on', r === row);
    const name = /** @type {string} */ (row.dataset.siName);
    const inFile = this.fromFile.find(s => s.name === name);
    if (inFile) return this.show(inFile);
    this.say('Loading…');
    try {
      this.show((await fetchScheme(name))[0]);
      this.say('From iTerm2 Color Schemes on GitHub.');
    } catch (error) {
      this.show(null);
      this.say(`Couldn’t load ${name}. ${reason(error)}`, true);
    }
  }

  filter() {
    const query = this.search.value.trim().toLowerCase();
    this.listNames((collection ?? []).filter(n => n.toLowerCase().includes(query)));
  }
}

/**
 * The Import dialog. Resolves with the imported theme's id, or null when cancelled.
 * @returns {Promise<string | null>}
 */
export function importScheme() {
  return modal('scheme-import', DIALOG, (dialog, close) => {
    const picker = new SchemePicker(dialog);
    dialog.addEventListener('dragover', e => e.preventDefault());
    dialog.addEventListener('drop', async e => {
      e.preventDefault();
      e.stopPropagation(); // not a file dropped into a terminal
      const file = e.dataTransfer?.files[0];
      if (file) picker.readFile(file.name, await file.text());
    });
    dialog.addEventListener('click', e => {
      const target = targetOf(e);
      const row = /** @type {HTMLElement | null} */ (target.closest('[data-si-name]'));
      if (target.closest('[data-si-choose]')) picker.choose();
      else if (target.closest('[data-si-browse]')) picker.browse();
      else if (row) picker.pick(row);
    });
    picker.search.addEventListener('input', () => picker.filter());
    return { submit: () => { if (picker.picked) close(save(picker.picked)); } };
  });
}
