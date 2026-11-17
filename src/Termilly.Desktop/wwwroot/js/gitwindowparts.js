// @ts-check
// The Git window's parts on screen (js/gitwindow.js): its markup, the elements its modules draw into, the window of
// its own it opens in, and what every part of it uses to show something: the title, which right side shows, git's
// own words when something failed.

import { escapeHtml } from './ui.js';
import { modal } from './dialogs.js';
import { DIFF_SIDE, GITHUB_UNAVAILABLE } from './constants.js';
import { byId, find, field, resizeByGrip } from './dom.js';
import { ownWindow } from './ownwindow.js';
import { CONFLICT } from './gitsearch.js';
import { hostPreview } from './gitagent.js';
import { gw, ui, GIT_TAB } from './gitwindowstate.js';

const CLOSE = '<svg viewBox="0 0 12 12"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg>';
export const CHEVRON = '<svg viewBox="0 0 12 12"><path d="M4.5 3L7.5 6 4.5 9"/></svg>';
const REFRESH = '<svg viewBox="0 0 16 16"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3"/></svg>';
/** The buttons in the window's head (data-gw). */
export const HEAD_BUTTON = Object.freeze({ close: 'close', refresh: 'refresh' });
/**
 * Which list a file is in, as GitView.cs takes it for its diff and actions; a file in a commit is on the 'commit'
 * side. 'conflict' is the Conflicts section's own, whose files are unstaged.
 */
export const SIDE = Object.freeze({ ...DIFF_SIDE, conflict: CONFLICT });
/** The window's title before (or without) a repository, and with Agent changes alone (outside a repository). */
export const GIT_TITLE = 'Git';
export const AGENT_TITLE = 'Agent changes';
/** The toolbar's Git button (index.html), which opens the window (main.js) and lends it its icon. */
export const GIT_BUTTON_ID = 'git-button';
/** The Git window's own window: its name, and where it was left. */
const WINDOW_KEY = 'git';
/** A conflicted file's status title, and its side's label over its diff. */
export const CONFLICT_LABEL = 'Conflict';
/** The changes window's layout, which this window shares (app.css): a side list's row and the grip between. */
export const ROW = '.cw-row';
const GRIP = '.cw-grip';
/** How narrow and how wide the file list can be dragged. */
const SIDE_MIN_PX = 240;
const SIDE_MAX_PX = 720;
/** What the search box says it looks through: a repository, or (outside one) only Claude's changes, or issues. */
export const SEARCH_REPO = 'Search changes, commits, code, branches and tags';
export const SEARCH_AGENT = 'Search the files Claude changed';
export const SEARCH_ISSUES = 'Filter issues by number, title, label or author';

export const layer = document.createElement('div');
layer.className = 'modal-layer settings-layer changes-layer git-layer';
layer.hidden = true;
layer.innerHTML = `
  <div class="settings changes-win git-win" role="dialog" aria-modal="true" aria-labelledby="gw-title">
    <div class="set-head">
      <span class="title-icon gw-icon"></span>
      <h2 id="gw-title">${GIT_TITLE}</h2>
      <span class="cw-sub gw-repo"></span>
      <span class="gw-branch"></span>
      <span class="spacer"></span>
      <span class="gw-actions"></span>
      <button class="pane-btn gw-refresh" data-gw="${HEAD_BUTTON.refresh}" title="Refresh (F5)">${REFRESH}</button>
      <button class="set-close" data-gw="${HEAD_BUTTON.close}" title="Close (Esc)">${CLOSE}</button>
    </div>
    <div class="gw-tabbar">
      <span class="seg gw-tabs" role="tablist">
        <button data-gw-tab="${GIT_TAB.agent}" role="tab" title="The files Claude changed in this terminal" hidden>${AGENT_TITLE}</button>
        <button data-gw-tab="${GIT_TAB.changes}" role="tab">Changes</button>
        <button data-gw-tab="${GIT_TAB.history}" role="tab">History</button>
        <button data-gw-tab="${GIT_TAB.branches}" role="tab">Branches</button>
        <button data-gw-tab="${GIT_TAB.local}" role="tab" title="Uncommitted work kept before it could be lost, and branch backups">Local history</button>
        <button data-gw-tab="${GIT_TAB.issues}" role="tab" title="The repository's issues on GitHub" hidden>Issues</button>
      </span>
    </div>
    <div class="cw-main">
      <div class="cw-side gw-side">
        <div class="cw-filter gw-search">
          <input class="field" placeholder="${SEARCH_REPO}" aria-label="Search the repository"
            title="Finds text in the files Claude changed here, changed files, commit messages, hashes and authors, the lines commits changed, and branch and tag names (Ctrl+F)"
            spellcheck="false" autocomplete="off">
        </div>
        <div class="pal-filters gw-filters" hidden></div>
        <div class="gw-issue-bar" hidden></div>
        <div class="gw-history-bar" hidden></div>
        <div class="gw-list" tabindex="0" role="listbox" aria-label="Files"></div>
        <div class="gw-commitbox" hidden></div>
      </div>
      <div class="cw-grip" title="Drag to resize"></div>
      <div class="gw-right" tabindex="-1"></div>
      <div class="gw-preview" hidden></div>
    </div>
  </div>`;
document.body.append(layer);

const box = find(layer, '.git-win');
// Its title bar starts with its toolbar button's icon, as the other windows of their own do.
find(box, '.gw-icon').innerHTML = /** @type {Element} */ (byId(GIT_BUTTON_ID).firstElementChild).outerHTML;

/** The elements the window's parts draw into. */
export const els = Object.freeze({
  box,
  repoEl: find(box, '.gw-repo'),
  previewEl: find(layer, '.gw-preview'),
  branchEl: find(layer, '.gw-branch'),
  searchEl: field(layer, '.gw-search input'),
  filtersEl: find(layer, '.gw-filters'),
  listEl: find(layer, '.gw-list'),
  sideEl: find(layer, '.gw-side'),
  rightEl: find(layer, '.gw-right'),
  actionsEl: find(layer, '.gw-actions'),
  issueBarEl: find(layer, '.gw-issue-bar'),
  historyBarEl: find(layer, '.gw-history-bar'),
  commitBoxEl: find(layer, '.gw-commitbox'),
});

resizeByGrip(find(box, GRIP), els.sideEl, SIDE_MIN_PX, SIDE_MAX_PX);

/** The window of its own the Git window always opens in (over the main window where there can be none). */
export const frame = ownWindow({
  key: WINDOW_KEY, title: GIT_TITLE, layer, box, header: /** @type {HTMLElement} */ (box.firstElementChild),
  close: () => ui.close(),
  onShown: win => {
    // Coming back to the window, as to the main one, looks at the working tree again.
    win?.addEventListener('focus', () => ui.refreshSoon());
    els.listEl.focus();
  },
  onGone: () => ui.closed(),
});
export const isOpen = frame.isOpen;

/**
 * What the title bar says after Git, as Schedules says its count: the repository's name, or what it shows without
 * one; the window's own title (the taskbar's) starts with it.
 * @param {string} text
 */
export function showTitle(text) {
  const shown = text === GIT_TITLE ? '' : text;
  els.repoEl.textContent = shown;
  frame.setTitle(shown ? `${shown} - ${GIT_TITLE}` : GIT_TITLE);
}

/**
 * Which right side shows: the change preview (Agent changes and their search hits), or the window's own.
 * @param {boolean} preview
 */
export function useRight(preview) {
  els.rightEl.hidden = preview;
  els.previewEl.hidden = !preview;
  hostPreview(preview ? els.previewEl : null);
}

export function showNothing() {
  useRight(false);
  els.rightEl.innerHTML = '';
}

/**
 * Whether the repository is on GitHub, so the Issues tab shows (gh runs on this PC only). When GitHub can't be used
 * (gh missing, signed out, no answer), the tab says why rather than going away.
 */
export const onGitHub = () => !gw.server && !!gw.github
  && (gw.github.available || (!!gw.github.reason && gw.github.reason !== GITHUB_UNAVAILABLE.notGitHub));

/**
 * git's own words when an action failed, in a popup over the window; the window keeps the keyboard after.
 * @param {string} text
 */
export async function showGitError(text) {
  await modal('git-error', `
    <h3>Git didn't do that</h3>
    <pre class="git-error-text">${escapeHtml(text)}</pre>
    <div class="dialog-actions"><button class="btn primary" data-ok autofocus>OK</button></div>`, (dialog, close) => {
    return { submit: () => close(true) };
  });
  els.listEl.focus();
}
