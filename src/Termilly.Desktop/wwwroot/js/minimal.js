// @ts-check
// Minimal (Settings › Appearance › Layout): the title bar thins to a strip (the workspace, how many terminals, the
// ones set aside, who needs you, the window's buttons), the sidebar goes, the toolbar floats in a dock (js/dock.js), and
// each terminal's header becomes a quiet line or a bar shown when the mouse nears its top (js/panebar.js picks its
// parts). Normal is left exactly as it was. Only the main window: detached ones keep their own look.

import { state, on, wsById, tabsOf, EVENTS } from './store.js';
import { showMenu } from './popups.js';
import { bringBack } from './panes.js';
import { jumpToNext } from './inbox.js';
import { shownName } from './rename.js';
import { scheduleFit } from './terminals.js';
import { showDock } from './dock.js';
import { isMinimal, PANE_HEADER } from './panebar.js';
import { find, targetOf } from './dom.js';
import { SETTING_VALUES } from './constants.js';

/** How near a terminal's top the mouse has to be for its bar to show, on hover (px). */
const BAR_NEAR_PX = 36;
/** A terminal's class while its bar shows (app.css). */
const BAR_NEAR = 'bar-near';
const { paneNames, layout } = SETTING_VALUES;

const body = document.body;
const left = find(document, '#titlebar .tb-left');
left.insertAdjacentHTML('beforeend', `<button class="mini-aside" hidden><svg viewBox="0 0 16 16"><path d="M3.5 12.5h9"/><path d="M8 3.5v6M5.5 7l2.5 2.5L10.5 7"/></svg><span></span></button>
  <button class="mini-needs" hidden title="Go to the next terminal that needs you (Ctrl+Shift+J)"><span class="mini-needs-dot"></span><span></span></button>`);
const asideButton = find(left, '.mini-aside');
const needsButton = find(left, '.mini-needs');

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
  const needing = [...state.tabs.values()].filter(t => t.attention);
  needsButton.hidden = !needing.length;
  if (needing.length) {
    const more = needing.length > 1 ? `, ${needing.length - 1} more` : '';
    find(needsButton, 'span:last-child').textContent = `${shownName(needing[0])} needs you${more}`;
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
  showDock(minimal);
  drawStrip();
  // The terminals' room changes with the title bar, sidebar and headers.
  if (changed) scheduleFit();
}

asideButton.addEventListener('click', () => {
  showMenu(asideTabs().map(tab => ({ label: shownName(tab), hint: 'Bring back', action: () => bringBack(tab) })), asideButton);
});
needsButton.addEventListener('click', () => jumpToNext());

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
  const near = pane && (onBar || e.clientY - pane.getBoundingClientRect().top < BAR_NEAR_PX);
  showBarOn(near ? pane : null);
}, { passive: true });
document.addEventListener('keydown', () => showBarOn(null), { capture: true });

on(EVENTS.settings, applyLayout);
on(EVENTS.workspaces, drawStrip);
on(EVENTS.tab, drawStrip);

/** Applies the saved layout (main.js, once the settings and saved state are in). */
export const initMinimal = applyLayout;
