// @ts-check
// A floating scratch terminal (Ctrl+Shift+`): a shell above the layout, in no workspace, for a quick command.
// Hiding it keeps it running; it comes back as it was. And stacking: a workspace's terminals in one column, the
// focused one open and the others as title bars that still show what their agents are doing.

import { state, on, newId, defaultProfile, EVENTS } from './store.js';
import { createView, focusTab, restoreFocus } from './panes.js';
import { openTerminal, scheduleFit } from './terminals.js';
import { byId, targetOf, WORKSPACE_ID, dragFloating } from './dom.js';


/** @type {Tab | null} */
let scratch = null; // the tab
const float = document.createElement('div');
float.className = 'scratch-float';
float.hidden = true;
byId(WORKSPACE_ID).append(float);

export const isScratchOpen = () => !float.hidden;

// Closed (its X, or `exit`): the next Ctrl+Shift+` starts a new one.
on(EVENTS.scratchClosed, () => {
  float.hidden = true;
  scratch = null;
});

export function toggleScratch() {
  if (!float.hidden) {
    float.hidden = true;
    restoreFocus();
    return;
  }
  float.hidden = false;
  if (!scratch || !state.tabs.has(scratch.id)) {
    // In no workspace (wsId null, which Tab doesn't allow for), so it's cast through unknown.
    scratch = /** @type {Tab} */ (/** @type {unknown} */ ({
      id: newId('t'), wsId: null, profile: defaultProfile(), name: 'Scratch', tags: [], noHistory: true,
      attention: false, startedAt: Date.now(), view: null,
    }));
    state.tabs.set(scratch.id, scratch);
    createView(scratch, { draggable: false });
    float.replaceChildren(/** @type {TabView} */ (scratch.view).el);
    /** @type {TabView} */ (scratch.view).el.classList.add('focused');
    wireMove(/** @type {TabView} */ (scratch.view).header);
    openTerminal(scratch);
  }
  scheduleFit();
  focusTab(scratch);
}

/**
 * Dragging the scratch terminal's title bar moves it around the window.
 * @param {HTMLElement} header
 */
function wireMove(header) {
  header.addEventListener('pointerdown', e => {
    if (e.button !== 0 || targetOf(e).closest('button, input')) return;
    e.preventDefault();
    dragFloating(float, e, /** @type {HTMLElement} */ (float.parentElement).getBoundingClientRect());
  });
}
