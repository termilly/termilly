// @ts-check
// Minimal (Settings › Appearance › Layout): the title bar thins to a strip (the workspace, how many terminals, the
// ones set aside, who needs you, the window's buttons), the sidebar goes, the toolbar floats in a dock (js/dock.js), and
// each terminal's header becomes a quiet line or a bar shown when the mouse nears its top (js/panebar.js picks its
// parts). Normal is left exactly as it was. Only the main window: detached ones keep their own look.

import { state, on, wsById, tabsOf, EVENTS } from './store.js';
import { showMenu } from './popups.js';
import { bringBack, switchWorkspace } from './panes.js';
import { arriveAt } from './arrived.js';
import { shownName } from './rename.js';
import { scheduleFit } from './terminals.js';
import { showDock, needsYou, showWorkspaceList, CHEVRON } from './dock.js';
import { isMinimal, PANE_HEADER } from './panebar.js';
import { find, byId, targetOf, refreshDockedPanels, CRUMB_ID } from './dom.js';
import { SIDE } from './popups.js';
import { SETTING_VALUES } from './constants.js';

/** How near a terminal's top the mouse has to be for its bar to show, on hover (px). */
const BAR_NEAR_PX = 36;
/**
 * A file preview's bar is long and its top holds the preview's tabs: it shows only from a square in its top right
 * corner, where the bar's Close is, so the tabs stay in reach. Its size is minimal.css's, where the tabs end before it.
 */
const PREVIEW_CORNER = '--preview-corner';
/** The file preview pane (js/preview.js), and one of its file tabs. */
const PREVIEW_PANE = 'preview-pane';
const FILE_TAB = '.pv-tab';
/** A terminal's class while its bar shows (app.css). */
const BAR_NEAR = 'bar-near';
const { paneNames, layout } = SETTING_VALUES;

const body = document.body;
const left = find(document, '#titlebar .tb-left');
left.insertAdjacentHTML('beforeend', `<button class="mini-aside" hidden><svg viewBox="0 0 16 16"><path d="M3.5 12.5h9"/><path d="M8 3.5v6M5.5 7l2.5 2.5L10.5 7"/></svg><span></span></button>`);
// Who needs you: on the right, before the window's buttons (at the start of their side: on macOS they've moved left).
find(document, '#titlebar .tb-right').insertAdjacentHTML('afterbegin', '<button class="mini-needs" hidden><span class="mini-needs-dot"></span><span></span></button>');
// The workspace on screen (js/sidebar.js fills it in) opens the list of them all, as the dock's does; a button only in
// Minimal, as Normal shows it just as a label while the sidebar is closed.
const crumb = byId(CRUMB_ID);
crumb.insertAdjacentHTML('beforeend', CHEVRON);
/** What makes the crumb a button that opens a menu, in Minimal. */
const CRUMB_BUTTON = /** @type {const} */ ([['role', 'button'], ['tabindex', '0'], ['aria-haspopup', 'menu'], ['title', 'Workspaces']]);
const asideButton = find(left, '.mini-aside');
const needsButton = find(document, '#titlebar .mini-needs');
/** The terminal "needs you" names, which a click on it goes to. @type {Tab | null} */
let needsShown = null;

/** The workspace's terminals set aside. */
const asideTabs = () => {
  const ws = wsById(state.activeId);
  return ws ? tabsOf(ws).filter(t => t.setAside) : [];
};

/** The strip's own parts: how many are set aside, and who needs you (with how many more). */
function drawStrip() {
  const aside = asideTabs();
  asideButton.hidden = !aside.length;
  find(asideButton, 'span').textContent = `${aside.length} set aside`;
  const needing = [...state.tabs.values()].filter(needsYou);
  needsShown = needing[0] ?? null;
  needsButton.hidden = !needsShown;
  if (needsShown) {
    const more = needing.length > 1 ? `, ${needing.length - 1} more` : '';
    find(needsButton, 'span:last-child').textContent = `${shownName(needsShown)} needs you${more}`;
    needsButton.title = `Go to ${shownName(needsShown)}`;
  }
}

/** Applies the layout and how terminal names show; Normal changes nothing that was there before. */
function applyLayout() {
  const minimal = isMinimal();
  const names = state.settings.interface.paneNames ?? paneNames.default;
  const now = minimal ? layout.minimal : layout.normal;
  const changed = body.dataset.layout !== now || body.dataset.paneNames !== names;
  body.dataset.layout = now;
  body.dataset.paneNames = names;
  for (const [name, value] of CRUMB_BUTTON) {
    if (minimal) crumb.setAttribute(name, value); else crumb.removeAttribute(name);
  }
  showDock(minimal);
  drawStrip();
  // The terminals' room changes with the title bar, sidebar and headers, and the docked tools' with the gap beside them.
  if (!changed) return;
  refreshDockedPanels();
  scheduleFit();
}

const openWorkspaceList = () => {
  if (isMinimal()) showWorkspaceList(crumb, SIDE.below);
};
crumb.addEventListener('click', openWorkspaceList);
crumb.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  openWorkspaceList();
});

asideButton.addEventListener('click', () => {
  showMenu(asideTabs().map(tab => ({ label: shownName(tab), hint: 'Bring back', action: () => bringBack(tab) })), asideButton);
});
// To the terminal it names (not the inbox's next, which counts finished and failed ones too).
needsButton.addEventListener('click', () => {
  if (!needsShown) return;
  if (needsShown.wsId !== state.activeId) switchWorkspace(needsShown.wsId);
  arriveAt(needsShown);
});

/** The terminal whose bar shows now, on hover. @type {HTMLElement | null} */
let barShown = null;

/** @param {HTMLElement | null} pane */
function showBarOn(pane) {
  if (pane === barShown) return;
  barShown?.classList.remove(BAR_NEAR);
  barShown = pane;
  pane?.classList.add(BAR_NEAR);
}

// On hover, a terminal's bar shows while the mouse is near its top (or on the bar), and goes as soon as you type.
document.addEventListener('mousemove', e => {
  if (body.dataset.layout !== layout.minimal || body.dataset.paneNames !== paneNames.hover) return;
  const pane = /** @type {HTMLElement | null} */ (targetOf(e).closest('.pane'));
  const onBar = !!targetOf(e).closest(PANE_HEADER);
  showBarOn(pane && (onBar || nearTop(pane, e)) ? pane : null);
}, { passive: true });

/** The preview's corner size, once read (px). */
let previewCorner = 0;

/**
 * Whether the mouse is where a pane's bar shows from: near its top, or for a file preview, its top right corner when
 * not on a file tab (one scrolled into the corner by hand).
 * @param {HTMLElement} pane
 * @param {MouseEvent} e
 */
function nearTop(pane, e) {
  const box = pane.getBoundingClientRect();
  if (!pane.classList.contains(PREVIEW_PANE)) return e.clientY - box.top < BAR_NEAR_PX;
  // Read once: it's minimal.css's, the same while the bar shows on hover (the only time this is asked).
  previewCorner ||= parseFloat(getComputedStyle(pane).getPropertyValue(PREVIEW_CORNER)) || 0;
  return e.clientY - box.top < previewCorner && box.right - e.clientX < previewCorner && !targetOf(e).closest(FILE_TAB);
}

document.addEventListener('keydown', () => showBarOn(null), { capture: true });

on(EVENTS.settings, applyLayout);
on(EVENTS.workspaces, drawStrip);
on(EVENTS.tab, drawStrip);
on(EVENTS.agent, drawStrip);

/** Applies the saved layout (main.js, once the settings and saved state are in). */
export const initMinimal = applyLayout;
