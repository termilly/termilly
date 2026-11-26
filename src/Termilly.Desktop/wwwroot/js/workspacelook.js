// @ts-check
// How workspaces look (Settings › Appearance › Layout): their colour dots (the sidebar's in Normal, the dock's in
// Minimal) and the line that ties a workspace's terminals to it in the sidebar. Off, the page's classes hide them
// (css/sidebar.css, css/minimal.css).

import { state, on, EVENTS } from './store.js';

/** The body's classes for what's turned off. */
const NO_DOTS = 'no-ws-dots';
const NO_LINES = 'no-tree-lines';

/** Whether workspaces show their colour dots. */
export const showsWorkspaceDots = () => state.settings.interface.workspaceDots !== false;

function apply() {
  document.body.classList.toggle(NO_DOTS, !showsWorkspaceDots());
  document.body.classList.toggle(NO_LINES, state.settings.interface.treeLines === false);
}

apply();
on(EVENTS.settings, apply);
