// @ts-check
// The Git window's search box (js/gitwindow.js; js/gitsearch.js does the searching): typing searches the repository
// a moment after the last key (or GitHub's issues on Issues), Enter goes to the first row, Tab steps through the
// search's views, Escape ends it, and the open tab's own list comes back.

import { debounce } from './util.js';
import { targetOf } from './dom.js';
import { found, searching, clearSearch, runSearch, stepView, setView, ITEM } from './gitsearch.js';
import { AGENT_ITEM, agent, remoteAgent } from './gitagent.js';
import { ISSUE_ITEM, issues } from './gitissues.js';
import { gw, ui, ask, GIT_TAB } from './gitwindowstate.js';
import { els, isOpen, showNothing } from './gitwindowparts.js';
import { renderList, openItem, selectFirst, searchChanged } from './gitlist.js';

/** How long the search waits after a key before it asks git. */
const SEARCH_DELAY = 300;
/** Rows a search's arrow keys show as they reach them (the rest, like "Show all", wait for Enter). */
/** @type {Set<string>} */
export const PREVIEWED = new Set([ITEM.file, ITEM.commit, ITEM.branch, ITEM.fileHit, ITEM.commitHit, ITEM.tag, ITEM.agentHit, AGENT_ITEM.file, ISSUE_ITEM.issue]);
const { searchEl, filtersEl, listEl } = els;

/** There's something to search: a repository, or a terminal's changes. */
const canSearch = () => !!gw.repo || !!agent.tab;

/** Where the search looks: the repository, and the terminal's changes when they're on this PC. */
export const searchScope = () => ({
  root: gw.repo?.root ?? null,
  agentId: agent.tab && !remoteAgent(agent.tab) ? agent.tab.id : null,
});

/** Searches a moment after the last key; an empty box ends the search at once. */
const searchLater = debounce(() => {
  if (!isOpen() || !canSearch() || gw.tab === GIT_TAB.issues) return;
  gw.cursor = -1;
  if (!searching()) {
    // What the tab showed has nothing to do with the search.
    gw.selection = null;
    showNothing();
  }
  runSearch(searchEl.value.trim(), searchScope(), ask, searchChanged);
}, SEARCH_DELAY);

/** Issues are searched on GitHub, a moment after the last key. */
const searchIssuesLater = debounce(() => {
  if (isOpen() && gw.tab === GIT_TAB.issues) ui.reloadIssues();
}, SEARCH_DELAY);

/** Ends the search: the box empties and the tab's own list comes back (the caller draws it). */
export function endSearch() {
  searchLater.cancel();
  searchIssuesLater.cancel();
  clearSearch();
  searchEl.value = '';
  // The issues GitHub found for the words: the whole list is loaded again.
  if (issues.filter.trim()) Object.assign(issues, { list: [], more: false, loaded: false });
  issues.filter = '';
  gw.selection = null;
  gw.cursor = -1;
  ui.renderTabs();
}

/** The open tab's list again, after a search. */
function showTab() {
  showNothing();
  if (gw.tab === GIT_TAB.agent) {
    ui.showAgentTab();
  } else if (gw.tab === GIT_TAB.issues && !issues.loaded) {
    ui.reloadIssues();
  } else if (gw.tab === GIT_TAB.changes || gw.tab === GIT_TAB.issues) {
    renderList();
    selectFirst();
  } else if (gw.tab === GIT_TAB.history && gw.commits.length) {
    renderList();
    openItem(0);
  } else {
    ui.refresh();
  }
}

/** @param {number} by */
export function stepSearchView(by) {
  stepView(by);
  gw.cursor = -1;
  renderList();
}

searchEl.addEventListener('input', () => {
  if (gw.tab === GIT_TAB.issues) {
    // GitHub searches the issues: the repository's search has nothing to add.
    issues.filter = searchEl.value;
    searchIssuesLater();
    return;
  }
  if (searchEl.value.trim()) {
    searchLater();
    return;
  }
  searchLater.cancel();
  endSearch();
  showTab();
});

filtersEl.addEventListener('click', e => {
  const chip = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-search-view]'));
  if (!chip) return;
  setView(/** @type {string} */ (chip.dataset.searchView));
  gw.cursor = -1;
  renderList();
});

searchEl.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'Enter') {
    e.preventDefault();
    listEl.focus();
    const typed = searchEl.value.trim();
    if (gw.tab !== GIT_TAB.issues && typed && typed !== found.text && canSearch()) {
      // Enter before the search started: it starts now (its rows open as usual once they're in).
      searchLater.cancel();
      runSearch(typed, searchScope(), ask, searchChanged);
      return;
    }
    const first = gw.items.findIndex(i => PREVIEWED.has(i.kind));
    if (first >= 0) openItem(first);
  } else if (e.key === 'Tab' && searching()) {
    e.preventDefault();
    stepSearchView(e.shiftKey ? -1 : 1);
  } else if (e.key === 'Escape' && searchEl.value) {
    // The first Escape ends the search; the next one closes the window.
    e.preventDefault();
    e.stopPropagation();
    endSearch();
    showTab();
  }
});
