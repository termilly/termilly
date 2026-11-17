// @ts-check
// The Git window's clicks and keys (js/gitwindow.js): a row opens on a click; the arrows, Home and End move along the
// list (a file or a commit shows as they reach it), Agent changes' tree opens and closes with Right and Left; a tab
// or a head button on a click; and the window's own keys, which stay in it: Escape (lines picked first, then the
// window), F5 or Ctrl+R to refresh, Ctrl+F to search.

import { PAGE } from './protocol.js';
import { send } from './host.js';
import { targetOf } from './dom.js';
import { searching } from './gitsearch.js';
import { AGENT_ITEM, agent, toggleFolder, forgetAgentFile } from './gitagent.js';
import { WRITE_BUTTON, openPush, openPullRequest } from './gitwrite.js';
import { stagingKey, clearPicked } from './gitstage.js';
import { gw, ui } from './gitwindowstate.js';
import { els, layer, ROW, HEAD_BUTTON } from './gitwindowparts.js';
import { writeContext } from './gitcontexts.js';
import { renderList, openItem, markCursor } from './gitlist.js';
import { PREVIEWED, stepSearchView } from './gitsearchui.js';

const { box, listEl, searchEl } = els;

listEl.addEventListener('click', e => {
  const row = /** @type {HTMLElement | null} */ (targetOf(e).closest(ROW));
  if (row) openItem(Number(row.dataset.i));
});

/**
 * Agent changes' own keys: Right opens a folder, Left closes it (or goes to the folder a file is in), Delete takes
 * a file off the terminal's list. True when it was one.
 * @param {KeyboardEvent} e
 */
function agentTreeKey(e) {
  const item = gw.items[gw.cursor];
  if (!item || (item.kind !== AGENT_ITEM.folder && item.kind !== AGENT_ITEM.file)) return false;
  if ((e.key === 'Delete' || e.key === 'Backspace') && item.kind === AGENT_ITEM.file) {
    forgetAgentFile(item.file.path);
  } else if (e.key === 'ArrowRight' && item.kind === AGENT_ITEM.folder) {
    toggleFolder(item.folder, true);
    renderList();
  } else if (e.key === 'ArrowLeft' && item.kind === AGENT_ITEM.folder && !agent.collapsed.has(item.folder.key)) {
    toggleFolder(item.folder, false);
    renderList();
  } else if (e.key === 'ArrowLeft') {
    // To the folder it's in.
    for (let i = gw.cursor - 1; i >= 0; i--) {
      const up = gw.items[i];
      if (up.kind === AGENT_ITEM.folder && up.depth < item.depth) {
        gw.cursor = i;
        markCursor();
        break;
      }
    }
  } else {
    return false;
  }
  return true;
}

listEl.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = gw.cursor + (e.key === 'ArrowDown' ? 1 : -1);
    if (next < 0 || next >= gw.items.length) return;
    gw.cursor = next;
    // Moving onto a file or a commit shows it, as in a file explorer's preview.
    if (PREVIEWED.has(gw.items[next].kind)) openItem(next); else markCursor();
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openItem(gw.cursor);
  } else if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault();
    openItem(e.key === 'Home' ? 0 : gw.items.length - 1);
  } else if (e.key === 'Tab' && searching()) {
    e.preventDefault();
    stepSearchView(e.shiftKey ? -1 : 1);
  } else if (agentTreeKey(e)) {
    e.preventDefault();
  } else if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.altKey && !e.metaKey) {
    // Typing goes to the search box (the key lands there).
    searchEl.focus();
  }
});

box.addEventListener('click', e => {
  const t = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-gw-tab]'));
  if (t) return void ui.switchTab(/** @type {string} */ (t.dataset.gwTab));
  const button = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-gw]'));
  const action = button?.dataset.gw;
  const ctx = writeContext();
  if (action === HEAD_BUTTON.close) ui.close();
  else if (action === HEAD_BUTTON.refresh) ui.refreshAll();
  else if (action === WRITE_BUTTON.push && ctx) openPush(ctx);
  else if (action === WRITE_BUTTON.pr && ctx) openPullRequest(ctx);
  else if (action === WRITE_BUTTON.openPr && button?.dataset.url) send(PAGE.openUrl, { url: button.dataset.url });
});

layer.addEventListener('mousedown', e => {
  if (e.target === layer) ui.close();
});

/**
 * Escape, Refresh and search: the window's own keys. True when the key was one.
 * @param {KeyboardEvent} e
 */
function windowKey(e) {
  const shown = gw.diffState;
  if (e.key === 'Escape' && !e.defaultPrevented && shown?.rows && shown.target.querySelector('.picked')) {
    // The first Escape lets go of the lines picked; the next one closes the window.
    clearPicked(/** @type {HTMLElement} */ (shown.target), shown.request.side ?? '');
  } else if (e.key === 'Escape' && !e.defaultPrevented) {
    ui.close();
  } else if (e.key === 'F5' || (e.ctrlKey && e.key.toLowerCase() === 'r')) {
    ui.refreshAll();
  } else if (e.ctrlKey && e.key.toLowerCase() === 'f') {
    searchEl.focus();
    searchEl.select();
  } else {
    return false;
  }
  return true;
}

// Keys in the window stay in it (no app shortcuts, no terminal).
box.addEventListener('keydown', e => {
  const shown = gw.diffState;
  const staging = !!shown?.rows && stagingKey(e, /** @type {HTMLElement} */ (shown.target), shown.request.side ?? '');
  if (!staging && windowKey(e)) e.preventDefault();
  e.stopPropagation();
});
