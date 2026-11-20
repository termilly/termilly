// @ts-check
// Importing other terminals' colour schemes (Settings › Appearance › Theme › Import): drop files or a folder, or choose
// files or a folder (read by schemes.js). Every scheme found goes in one list; ↑ and ↓ preview them in turn. The one
// shown is saved with the imported themes, or all the ticked ones at once (a tick, Space or Ctrl+click on a row).

import { PAGE } from './protocol.js';
import { request } from './host.js';
import { state, GROUPS } from './store.js';
import { updateSettings } from './preferences.js';
import { modal } from './dialogs.js';
import { readSchemes } from './schemes.js';
import { droppedFiles } from './schemedrop.js';
import { CUSTOM_THEME } from './constants.js';
import { cssColor, escapeHtml } from './ui.js';
import { find, targetOf } from './dom.js';

/** How much of a name its id keeps, and the id's name part when nothing of the name fits one (no Latin letters). */
const MAX_ID_NAME = 30;
const UNNAMED_ID = 'scheme';
/** The most rows the list shows at once; the search narrows it. */
const MAX_LISTED = 200;

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

/** @typedef {{ id: string, name: string }} SavedTheme */

/**
 * The imported themes with a scheme added first; one of the same name is replaced, keeping its id.
 * @param {SavedTheme[]} saved
 * @param {import('./schemes.js').Scheme} s
 */
function withScheme(saved, s) {
  const others = saved.filter(t => !sameName(s.name)(t));
  const id = saved.find(sameName(s.name))?.id ?? idOf(s.name, others);
  const theme = { id, name: savedName(s.name), background: s.background, foreground: s.foreground, cursor: s.cursor, ansi: s.ansi };
  return { themes: [theme, ...others], id };
}

/**
 * Saves schemes with the imported themes (in the list's order, before the older ones; the oldest going past the limit)
 * and shows one of them.
 * @param {import('./schemes.js').Scheme[]} schemes
 * @param {import('./schemes.js').Scheme} shown one of them
 */
function save(schemes, shown) {
  /** @type {SavedTheme[]} */
  let themes = state.settings.interface.customThemes ?? [];
  let id = '';
  // Last first, so each one goes in before the ones after it; another of the shown one's name would replace it.
  for (const s of schemes.filter(x => x === shown || !sameName(shown.name)(x)).reverse()) {
    const added = withScheme(themes, s);
    themes = added.themes;
    if (s === shown) id = added.id;
  }
  updateSettings(GROUPS.interface, { customThemes: themes.slice(0, CUSTOM_THEME.maxThemes), theme: id });
  return id;
}

/**
 * How many imported themes there are once schemes are saved: one of a name already there replaces it.
 * @param {import('./schemes.js').Scheme[]} schemes
 */
function themesAfter(schemes) {
  const saved = state.settings.interface.customThemes ?? [];
  const key = (/** @type {string} */ name) => savedName(name).toLowerCase();
  const had = new Set(saved.map(t => key(t.name)));
  return saved.length + new Set(schemes.map(s => key(s.name)).filter(n => !had.has(n))).size;
}

/** @param {number} n @param {string} one @param {string} many */
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const SEARCH_LABEL = 'Search schemes';
/** The save button: the scheme shown, or the ticked ones. */
const USE_LABEL = 'Use this theme';
/** @param {number} n */
const addLabel = n => `Add ${count(n, 'theme', 'themes')}`;

// Buttons, rows and ticks take Enter as their own (data-no-enter): only the save button saves with it.
const DIALOG = `
  <h3 id="si-title">Import colour schemes</h3>
  <div class="si-body">
    <div class="si-pick">
      <div class="si-drop">
        <b>Drop scheme files or a folder here</b>
        <span class="dialog-sub">From iTerm2, Windows Terminal, Ghostty, Kitty, Alacritty or Warp</span>
        <span class="si-buttons"><button class="btn" data-si-choose data-no-enter autofocus>Choose files</button><button class="btn" data-si-folder data-no-enter>Choose folder</button></span>
      </div>
      <div class="si-collection" hidden>
        <input class="field si-search" type="search" placeholder="${SEARCH_LABEL}" spellcheck="false" autocomplete="off" aria-label="${SEARCH_LABEL}" data-no-enter>
        <label class="dialog-check si-all"><input type="checkbox" data-si-all data-no-enter> Select all</label>
        <div class="si-list" role="listbox" aria-label="Schemes" aria-multiselectable="true"></div>
        <p class="dialog-sub si-more"></p>
      </div>
    </div>
    <div class="si-show">
      <div class="si-preview"><p class="dialog-sub">Pick a scheme to see it here. ↑ and ↓ go through the list.</p></div>
      <p class="dialog-sub si-status" role="status"></p>
    </div>
  </div>
  <div class="dialog-actions">
    <span class="dialog-sub si-count" title="Imported themes, with the ones added here"></span><span class="spacer"></span>
    <button class="btn" data-cancel data-no-enter>Cancel</button>
    <button class="btn primary" data-ok disabled>${USE_LABEL}</button>
  </div>`;

/** The dialog's parts it changes, and the class its status line has for an error. */
const PART = Object.freeze({
  collection: '.si-collection', list: '.si-list', more: '.si-more', search: '.si-search', status: '.si-status',
  preview: '.si-preview', ok: '[data-ok]', count: '.si-count', row: '.si-row', all: '[data-si-all]', tick: '[data-si-tick]',
});
const ERROR_CLASS = 'error';
/** The keys that move through the list: by one row, or to its ends. */
const LIST_KEYS = Object.freeze({ ArrowDown: 1, ArrowUp: -1, Home: -Infinity, End: Infinity });
/** The key that ticks or unticks the row it's on, and the one that (with Ctrl) ticks them all. */
const TICK_KEY = ' ';
const ALL_KEY = 'a';

/**
 * The Import dialog's state: the scheme shown, the schemes read from files, the ones ticked, and which of the user's
 * actions is the current one (a slower answer to an earlier one is dropped).
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
    /** The row picked (a scheme's place in fromFiles), kept marked while the search shows it. */
    this.selected = '';
    /** @type {Set<string>} the rows ticked, kept while the search hides them */
    this.ticked = new Set();
    /** @type {string[]} the rows the search matches */
    this.matches = [];
    /** What the files read came to, said again once the ticks are back within the limit. */
    this.found = '';
    this.list = find(dialog, PART.list);
    this.search = /** @type {HTMLInputElement} */ (find(dialog, PART.search));
    this.all = /** @type {HTMLInputElement} */ (find(dialog, PART.all));
    this.syncTicks();
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
    find(this.dialog, PART.preview).innerHTML = s ? `<b class="si-name">${escapeHtml(s.name)}</b>${preview(s)}` : '';
    this.syncTicks();
  }

  /**
   * The save button, Select all and the status line, as the ticks stand: more than the imported themes kept can't be added.
   */
  syncTicks() {
    const ok = /** @type {HTMLButtonElement} */ (find(this.dialog, PART.ok));
    const chosen = this.chosen();
    const total = themesAfter(chosen);
    const over = total > CUSTOM_THEME.maxThemes;
    ok.textContent = this.ticked.size ? addLabel(this.ticked.size) : USE_LABEL;
    ok.disabled = !chosen.length || over;
    const counter = find(this.dialog, PART.count);
    counter.textContent = `${total}/${CUSTOM_THEME.maxThemes}`;
    counter.classList.toggle(ERROR_CLASS, over);
    const shownTicked = this.matches.filter(key => this.ticked.has(key)).length;
    this.all.checked = shownTicked > 0 && shownTicked === this.matches.length;
    this.all.indeterminate = shownTicked > 0 && !this.all.checked;
    if (this.found) this.say(over ? `Only ${CUSTOM_THEME.maxThemes} imported themes are kept: tick fewer, or remove some with Manage.` : this.found, over);
  }

  /** A new list: the old rows, ticks and search go, so a stale row can't be picked. */
  start() {
    const action = ++this.action;
    this.fromFiles = [];
    this.selected = '';
    this.ticked.clear();
    this.matches = [];
    this.found = '';
    this.search.value = '';
    this.list.innerHTML = '';
    find(this.dialog, PART.more).textContent = '';
    find(this.dialog, PART.collection).hidden = true;
    this.show(null);
    this.say('');
    return action;
  }

  /** The rows the search matches (by name, or by the file a scheme's in), the picked one marked and the ticked ones ticked. */
  filter() {
    const query = this.search.value.trim().toLowerCase();
    const matches = this.fromFiles.map((f, i) => ({ key: String(i), label: f.scheme.name, place: f.place }))
      .filter(r => `${r.label}\n${r.place}`.toLowerCase().includes(query));
    this.matches = matches.map(r => r.key);
    this.list.innerHTML = matches.slice(0, MAX_LISTED).map(({ key, label, place }) => {
      const on = key === this.selected;
      const ticked = this.ticked.has(key);
      const k = escapeHtml(key);
      const where = place ? `<span class="si-place">${escapeHtml(place)}</span>` : '';
      return `<div class="si-item" role="none"><input type="checkbox" class="si-tick" data-si-tick="${k}" data-no-enter tabindex="-1" aria-label="Add ${escapeHtml(label)}"${ticked ? ' checked' : ''}>`
        + `<button class="si-row${on ? ' on' : ''}" role="option" aria-selected="${on}" aria-checked="${ticked}" data-no-enter data-si-key="${k}"><span class="si-label">${escapeHtml(label)}</span>${where}</button></div>`;
    }).join('') || '<p class="dialog-sub">No schemes match.</p>';
    find(this.dialog, PART.more).textContent = matches.length > MAX_LISTED ? `The first ${MAX_LISTED} of ${matches.length} shown: search to find others.` : '';
    this.syncTicks();
  }

  /** @param {string} key @param {boolean} on */
  tick(key, on) {
    if (on) this.ticked.add(key);
    else this.ticked.delete(key);
    this.showTicks();
  }

  /** The rows' ticks as they stand, drawn in place so the row with the focus keeps it. */
  showTicks() {
    for (const box of /** @type {NodeListOf<HTMLInputElement>} */ (this.list.querySelectorAll(PART.tick))) {
      const on = this.ticked.has(/** @type {string} */ (box.dataset.siTick));
      box.checked = on;
      box.nextElementSibling?.setAttribute('aria-checked', String(on));
    }
    this.syncTicks();
  }

  /** @param {string} key */
  toggle(key) {
    this.tick(key, !this.ticked.has(key));
  }

  /** Select all: ticks every row the search matches, or unticks them when they all are. */
  tickAll() {
    const on = !this.matches.every(key => this.ticked.has(key));
    for (const key of this.matches) {
      if (on) this.ticked.add(key);
      else this.ticked.delete(key);
    }
    this.showTicks();
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
    this.found = `${count(this.fromFiles.length, 'scheme', 'schemes')} found${out.length ? `; ${out.join(', ')}` : ''}.`;
    this.selected = '0';
    this.filter();
    this.show(this.fromFiles[0].scheme);
  }

  /** @param {DataTransfer} transfer files or folders dropped from the file manager */
  async drop(transfer) {
    const action = this.start();
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
    const asked = ++this.asked;
    const reply = await request(PAGE.schemeOpen, { folder });
    if (asked !== this.asked || !this.dialog.isConnected || (!reply.files && !reply.error)) return;
    this.start();
    if (reply.error) return this.say(reply.error, true);
    const files = reply.files ?? [];
    // The host reads one past the limit, so a folder with more says so.
    const over = Math.max(0, files.length + (reply.skipped ?? 0) - CUSTOM_THEME.maxFiles);
    this.readFiles(files, (reply.skipped ?? 0) - over, over > 0);
  }

  /** @param {HTMLElement} row */
  pick(row) {
    const key = /** @type {string} */ (row.dataset.siKey);
    this.selected = key;
    for (const r of this.list.querySelectorAll(PART.row)) {
      r.classList.toggle('on', r === row);
      r.setAttribute('aria-selected', String(r === row));
    }
    this.show(this.fromFiles[Number(key)]?.scheme ?? null);
  }

  /** The ticked schemes saved, or the one shown; the id of the one put on screen, or null when there's nothing to save. */
  saveChosen() {
    const schemes = this.chosen();
    if (!schemes.length || themesAfter(schemes) > CUSTOM_THEME.maxThemes) return null;
    // The one previewed goes on screen when it's among them, else the first.
    return save(schemes, this.picked && schemes.includes(this.picked) ? this.picked : schemes[0]);
  }

  /** What saving adds: the ticked schemes, or the one shown when none are ticked. */
  chosen() {
    if (!this.ticked.size) return this.picked ? [this.picked] : [];
    return this.fromFiles.filter((_, i) => this.ticked.has(String(i))).map(f => f.scheme);
  }

  /**
   * Keys in the list or its search box: ↑ ↓ Home End pick and show the row beside the picked one (or the first or
   * last); Space on a row ticks it; Ctrl+A in the list ticks them all.
   * @param {KeyboardEvent} e
   */
  step(e) {
    const target = targetOf(e);
    const row = /** @type {HTMLElement | null} */ (target.closest(PART.row));
    if (e.key === TICK_KEY && row && this.list.contains(row)) {
      this.toggle(/** @type {string} */ (row.dataset.siKey));
      return true;
    }
    if (e.key.toLowerCase() === ALL_KEY && (e.ctrlKey || e.metaKey) && this.list.contains(target)) {
      this.tickAll();
      return true;
    }
    const by = LIST_KEYS[/** @type {keyof typeof LIST_KEYS} */ (e.key)];
    const inList = target === this.search || this.list.contains(target);
    // Home and End move the caret in the search box; only ↑ and ↓ leave it.
    if (by === undefined || !inList || (target === this.search && !Number.isFinite(by))) return false;
    const rows = /** @type {HTMLElement[]} */ ([...this.list.querySelectorAll(PART.row)]);
    if (!rows.length) return false;
    const at = rows.findIndex(r => r.classList.contains('on'));
    const next = Number.isFinite(by) ? Math.min(rows.length - 1, Math.max(0, at < 0 ? 0 : at + by)) : by < 0 ? 0 : rows.length - 1;
    if (target !== this.search) rows[next].focus(); // from the search box, typing goes on there
    rows[next].scrollIntoView({ block: 'nearest' });
    if (next !== at) this.pick(rows[next]); // at an end the key does nothing, so the scheme shown stays
    return true;
  }
}

/**
 * The Import dialog. Resolves with the id of the theme put on screen, or null when cancelled.
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
      else if (row && (e.ctrlKey || e.metaKey)) picker.toggle(/** @type {string} */ (row.dataset.siKey));
      else if (row) picker.pick(row);
    });
    dialog.addEventListener('change', e => {
      const box = /** @type {HTMLInputElement} */ (targetOf(e));
      if (box.matches(PART.all)) picker.tickAll();
      else if (box.matches(PART.tick)) picker.tick(/** @type {string} */ (box.dataset.siTick), box.checked);
    });
    picker.search.addEventListener('input', () => picker.filter());
    return {
      submit: () => {
        const id = picker.saveChosen();
        if (id) close(id);
      },
      key: e => picker.step(e),
    };
  });
}
