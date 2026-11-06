// @ts-check
// Finding the page's own elements, typed for the checker. These are for elements the markup always has: a missing one
// is a bug in the markup, so nothing checks for it here (using it fails, as it would without these). Where an element
// may well be missing, query for it and check. Also dragging with the pointer, which several panels do the same way.

/** The id of index.html's element the workspace's panes are in. */
export const WORKSPACE_ID = 'workspace';
/** xterm's element the cells are drawn in: its size over the terminal's columns and rows is a cell's. */
export const XTERM_SCREEN = '.xterm-screen';
/** The mouse coming over an element (it bubbles, unlike mouseenter). */
export const MOUSE_OVER = 'mouseover';
/** What a file or folder dragged from the Files panel carries: its path (a terminal types it where it's dropped). */
export const PATH_DRAG = 'application/x-termilly-path';
/** What a clip dragged from Clipboard carries: its id. */
export const CLIP_DRAG = 'application/x-termilly-clip';

/**
 * Says changes to an element's text to a screen reader when it's idle (the tour's card, notes at the bottom).
 * @param {HTMLElement} el
 */
export const announce = el => el.setAttribute('aria-live', 'polite');
/** The mouse's middle button (its wheel), which closes a tab. */
const MIDDLE_BUTTON = 1;

/**
 * Runs fn when the middle button clicks el (closing a tab, as browsers do).
 * @param {HTMLElement} el
 * @param {(e: MouseEvent) => void} fn
 */
export function onMiddleClick(el, fn) {
  // Over something that scrolls, a middle press starts auto-scrolling on Windows, and then no auxclick comes.
  el.addEventListener('mousedown', e => { if (e.button === MIDDLE_BUTTON) e.preventDefault(); });
  el.addEventListener('auxclick', e => { if (e.button === MIDDLE_BUTTON) fn(e); });
}

/**
 * An element of index.html, by its id.
 * @param {string} id
 */
export const byId = id => /** @type {HTMLElement} */ (document.getElementById(id));

/**
 * The start of a panel's title: its title bar button's icon.
 * @param {HTMLElement} button
 */
export const titleIconHtml = button => `<span class="title-icon">${/** @type {Element} */ (button.firstElementChild).outerHTML}</span>`;

/**
 * The element a selector finds in `root`.
 * @param {ParentNode} root
 * @param {string} selector
 */
export const find = (root, selector) => /** @type {HTMLElement} */ (root.querySelector(selector));

/**
 * The form field (an input) a selector finds in `root`, for its value or checked state.
 * @param {ParentNode} root
 * @param {string} selector
 */
export const field = (root, selector) => /** @type {HTMLInputElement} */ (root.querySelector(selector));

/**
 * The element an event happened on (clicks, keys and input on the page's elements).
 * @param {Event} e
 */
export const targetOf = e => /** @type {HTMLElement} */ (e.target);

/**
 * Shows what went wrong in a form's error line (a dialog's .dialog-error, the rename field's), which starts hidden.
 * @param {HTMLElement} el
 * @param {string} text
 */
export function showError(el, text) {
  el.textContent = text;
  el.hidden = false;
}

/**
 * Follows a drag that started on `el` (its pointerdown `e`): `move` for each move, `done` once the button is let go.
 * @param {HTMLElement} el
 * @param {PointerEvent} e
 * @param {(ev: PointerEvent) => void} move
 * @param {() => void} [done]
 */
export function dragPointer(el, e, move, done) {
  el.setPointerCapture(e.pointerId);
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    done?.();
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
}

/** The class of a docked panel's grip, on its left edge. */
export const DOCK_GRIP = 'files-grip';

/** The workspace's edges a panel can dock on. */
export const DOCK_SIDE = Object.freeze({ right: 'right', left: 'left', top: 'top', bottom: 'bottom' });
/** @param {string} side */
export const isAcross = side => side === DOCK_SIDE.top || side === DOCK_SIDE.bottom;

/**
 * A panel docked on an edge of the workspace, the right one unless `side` says otherwise (the Files panel, the
 * Notepad): the terminals end where it starts (its size and the gap between panes, in the CSS variable `dockVar` on
 * the workspace, with -left, -top or -bottom after it on those edges), and its grip resizes it, up to half the workspace.
 * @param {HTMLElement} panel
 * @param {{ dockVar: string, minWidth: number, minHeight?: number, side?: () => string, resized: () => void, dragged?: (size: number) => void }} how
 *   resized: after its size changed (it opened, closed, was dragged or squeezed); dragged: after a drag, its width
 *   (its height on the top or bottom edge)
 * @returns {() => void} what to call when it comes back from a window of its own (or leaves for one), or changes edge
 */
export function dockRight(panel, { dockVar, minWidth, minHeight = minWidth, side = () => DOCK_SIDE.right, resized, dragged }) {
  const workspace = byId(WORKSPACE_ID);
  const gap = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--gap')) || 0;
  // In a window of its own (js/windows.js), or hidden, it takes no room here.
  const refresh = () => {
    const docked = !panel.hidden && workspace.contains(panel);
    const now = side();
    const room = docked ? (isAcross(now) ? panel.offsetHeight : panel.offsetWidth) + gap() : 0;
    for (const edge of Object.values(DOCK_SIDE)) {
      workspace.style.setProperty(edge === DOCK_SIDE.right ? dockVar : `${dockVar}-${edge}`, `${edge === now ? room : 0}px`);
    }
    resized();
  };
  new ResizeObserver(refresh).observe(panel);
  panel.addEventListener('pointerdown', e => {
    if (!targetOf(e).classList.contains(DOCK_GRIP)) return;
    e.preventDefault();
    const now = side();
    const across = isAcross(now);
    const room = workspace.getBoundingClientRect();
    const box = panel.getBoundingClientRect();
    const half = (across ? room.height : room.width) / 2;
    const least = across ? minHeight : minWidth;
    /** @param {PointerEvent} ev */
    const wanted = ev => (now === DOCK_SIDE.right ? box.right - ev.clientX : now === DOCK_SIDE.left ? ev.clientX - box.left
      : now === DOCK_SIDE.top ? ev.clientY - box.top : box.bottom - ev.clientY);
    dragPointer(targetOf(e), e, ev => {
      const size = `${Math.round(Math.min(half, Math.max(least, wanted(ev))))}px`;
      if (across) panel.style.height = size;
      else panel.style.width = size;
    }, () => dragged?.(across ? panel.offsetHeight : panel.offsetWidth));
  });
  return refresh;
}

/**
 * Lets `grip` resize the panel to its left (a window's file list), from `min` to `max` pixels wide.
 * @param {HTMLElement} grip
 * @param {HTMLElement} side
 * @param {number} min
 * @param {number} max
 */
export function resizeByGrip(grip, side, min, max) {
  grip.addEventListener('pointerdown', e => {
    e.preventDefault();
    const left = side.getBoundingClientRect().left;
    dragPointer(grip, e, ev => { side.style.width = `${Math.min(max, Math.max(min, ev.clientX - left))}px`; });
  });
}

/**
 * Moves a floating panel with the pointer, from a drag on its header (`e`), keeping it inside `within`.
 * @param {HTMLElement} floating
 * @param {PointerEvent} e
 * @param {DOMRect} within
 */
export function dragFloating(floating, e, within) {
  const start = floating.getBoundingClientRect();
  const dx = e.clientX - start.left;
  const dy = e.clientY - start.top;
  dragPointer(/** @type {HTMLElement} */ (e.currentTarget), e, ev => {
    const left = Math.min(Math.max(0, ev.clientX - dx - within.left), within.width - start.width);
    const top = Math.min(Math.max(0, ev.clientY - dy - within.top), within.height - start.height);
    Object.assign(floating.style, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto' });
  });
}
