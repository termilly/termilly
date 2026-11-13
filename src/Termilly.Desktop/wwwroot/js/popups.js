// @ts-check
// Anchored popovers and context menus. One stack: opening a top-level popover closes the others; a
// submenu opens on top of its parent. Clicking outside or pressing Escape closes from the top down. A popover made
// for the moment opens in the window it's for: its anchor's, else the one the user is in (js/windows.js).

import { hereDoc, inEachDocument } from './windows.js';
import { barSideOf, DOCK_SIDE } from './dom.js';

/**
 * Where a popover shows: next to an element, a rectangle, or a point.
 * @typedef {Element | DOMRect | { x: number, y: number }} Anchor
 */

/**
 * One of a menu's entries, or 'separator'. `checked` makes it a checkbox; `submenu` opens more entries beside it.
 * `key` picks it while its menu has the focus (a digit, shown as its hint).
 * @typedef {{ label: string, icon?: string, hint?: string, checked?: boolean, danger?: boolean, disabled?: boolean,
 *   title?: string, action?: () => unknown, submenu?: () => MenuEntry[], key?: string }} MenuItem
 * @typedef {MenuItem | typeof SEPARATOR} MenuEntry
 */

/** A menu entry that draws a line between groups of entries. */
export const SEPARATOR = 'separator';
/** The class of a menu a dropdown button opens (its items' width follows the button). */
export const DROPDOWN_MENU = 'dropdown-menu';

/**
 * Which side of its anchor a popover opens on: below it, or to its right (a submenu). Left and above are for the title
 * bar's buttons docked on the right or the bottom edge (awayFromBar).
 */
export const SIDE = Object.freeze({ below: 'below', right: 'right', left: 'left', above: 'above' });
/**
 * A popover below one of the title bar's buttons opens away from the edge they're docked on instead.
 * @type {Readonly<Record<string, string>>}
 */
const AWAY_FROM_BAR = Object.freeze({
  [DOCK_SIDE.top]: SIDE.below, [DOCK_SIDE.left]: SIDE.right, [DOCK_SIDE.right]: SIDE.left, [DOCK_SIDE.bottom]: SIDE.above,
});

/** @type {Array<{ el: HTMLElement, anchorEl: Element | null, onClose?: () => void, dynamic: boolean, refocus?: () => void, side?: string }>} */
const stack = [];
let restoreFocus = () => {};

/** How far a popover sits from its anchor: beside it, and below it. */
const GAP_BESIDE = 4;
const GAP_BELOW = 6;
/** How close a popover may come to the window's edges. */
const EDGE = 8;
/** The edge a rectangle has and a point { x, y } doesn't: how place() tells them apart. */
const RECT_EDGE = 'left';

/**
 * Called when the last popover closes, to give keyboard focus back (normally to the terminal).
 * @param {() => void} fn
 */
export function setFocusRestorer(fn) {
  restoreFocus = fn;
}

/**
 * Shows `el` (position: fixed) next to `anchor`: an element, a DOMRect, or a point { x, y }.
 * Options: side ('below' | 'right'), nested (keep the popovers under it open), onClose, dynamic (remove on close),
 * refocus (where the keyboard focus goes when it closes, instead of the terminal).
 * @param {HTMLElement} el
 * @param {Anchor} anchor
 * @param {{ side?: 'below' | 'right' | 'above', nested?: boolean, onClose?: () => void, dynamic?: boolean, refocus?: () => void }} [options]
 */
export function openPopover(el, anchor, { side = SIDE.below, nested = false, onClose, dynamic = false, refocus } = {}) {
  if (!nested) closeAll();
  // Not instanceof: an element made in a detached window is of that window's Element.
  const anchorEl = 'nodeType' in anchor ? /** @type {Element} */ (anchor) : null;
  if (dynamic && !el.isConnected) (anchorEl?.ownerDocument ?? hereDoc()).body.append(el);
  el.hidden = false;
  anchorEl?.classList.add('open');
  keepWheel(el);
  const where = anchorEl && side === SIDE.below ? AWAY_FROM_BAR[barSideOf(anchorEl)] ?? side : side;
  place(el, anchorEl ? anchorEl.getBoundingClientRect() : /** @type {DOMRect | { x: number, y: number }} */ (anchor), where);
  stack.push({ el, anchorEl, onClose, dynamic, refocus, side: where });
}

/**
 * Places an open popover against its element again, after what's in it changed size: one that opens upwards would
 * otherwise grow down past the window's edge.
 * @param {HTMLElement} el
 */
export function placeAgain(el) {
  const entry = stack.find(e => e.el === el);
  if (entry?.anchorEl?.isConnected) place(el, entry.anchorEl.getBoundingClientRect(), entry.side ?? SIDE.below);
}

/** The popovers whose wheel is kept to them (keepWheel). */
const wheelKept = new WeakSet();

/**
 * The wheel over a popover scrolls only what in it can scroll that way, never what's under it (the Files panel's
 * list under a popover's filter box scrolled). Its own handler also makes the browser find the scroller on the page,
 * not by where the pointer is.
 * @param {HTMLElement} el
 */
function keepWheel(el) {
  if (wheelKept.has(el)) return;
  wheelKept.add(el);
  el.addEventListener('wheel', e => {
    if (e.ctrlKey || !e.deltaY) return;
    for (let n = /** @type {Element | null} */ (e.target); n && n !== el.parentElement; n = n.parentElement) {
      if (canScroll(n, e.deltaY)) return;
      if (n === el) break;
    }
    e.preventDefault();
  }, { passive: false });
}

/**
 * Whether `n` can scroll further the way the wheel goes.
 * @param {Element} n
 * @param {number} deltaY
 */
function canScroll(n, deltaY) {
  if (n.scrollHeight <= n.clientHeight) return false;
  const { overflowY } = viewOf(n).getComputedStyle(n);
  if (overflowY !== 'auto' && overflowY !== 'scroll') return false;
  return deltaY < 0 ? n.scrollTop > 0 : n.scrollTop + n.clientHeight < n.scrollHeight - 1;
}

/**
 * Closes `el` and anything opened on top of it. Returns true if it was open.
 * @param {HTMLElement} el
 */
export function closePopover(el) {
  const i = stack.findIndex(entry => entry.el === el);
  if (i < 0) return false;
  closeFrom(i);
  return true;
}

export function closeAll() {
  closeFrom(0);
}

/** @param {HTMLElement} el */
export const isOpen = el => stack.some(entry => entry.el === el);
export const anyOpen = () => stack.length > 0;

/** @param {number} index */
function closeFrom(index) {
  if (index >= stack.length) return;
  const closing = stack.splice(index).reverse();
  for (const entry of closing) {
    entry.el.hidden = true;
    entry.anchorEl?.classList.remove('open');
    if (entry.dynamic) entry.el.remove();
    entry.onClose?.();
  }
  // The bottom popover says where the focus goes back to; the terminal unless it says otherwise.
  if (!stack.length) (closing[closing.length - 1].refocus ?? restoreFocus)();
}

/**
 * @param {HTMLElement} el
 * @param {DOMRect | { x: number, y: number }} rect
 * @param {string} side one of SIDE; where there's no room on that side, the opposite one
 */
function place(el, rect, side) {
  const r = RECT_EDGE in rect ? rect : { left: rect.x, right: rect.x, top: rect.y, bottom: rect.y };
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const { innerWidth, innerHeight } = viewOf(el);
  let left;
  let top;
  if (side === SIDE.right || side === SIDE.left) {
    const after = r.right + GAP_BESIDE;
    const before = r.left - w - GAP_BESIDE;
    if (side === SIDE.right) left = after + w > innerWidth - EDGE ? before : after;
    else left = before < EDGE ? after : before;
    top = r.top - GAP_BELOW;
  } else {
    left = r.left;
    const below = r.bottom + GAP_BELOW;
    const above = r.top - h - GAP_BELOW;
    if (side === SIDE.below) top = below + h > innerHeight - EDGE ? above : below;
    else top = above < EDGE ? below : above;
  }
  // Whole pixels: an anchor at a fractional position would otherwise blur every icon and line in the popover.
  el.style.left = `${Math.round(Math.max(EDGE, Math.min(left, innerWidth - w - EDGE)))}px`;
  el.style.top = `${Math.round(Math.max(EDGE, Math.min(top, innerHeight - h - EDGE)))}px`;
}

/**
 * The window an element is shown in (a detached one's, or the main page's).
 * @param {Element} el
 */
const viewOf = el => /** @type {Window} */ (el.ownerDocument.defaultView ?? window);

inEachDocument(doc => {
  doc.addEventListener('mousedown', e => {
    if (!stack.length) return;
    const top = stack[stack.length - 1];
    const target = /** @type {Node | null} */ (e.target);
    if (stack.some(entry => entry.el.contains(target)) || top.anchorEl?.contains(target)) return;
    closeAll();
  }, true);

  doc.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !stack.length) return;
    e.preventDefault();
    e.stopImmediatePropagation(); // a dialog under the menu stays open
    closeFrom(stack.length - 1);
  }, true);
});

// ---- Context menus ----

// Drawn at the size the menu shows them (16px and 12px), so they stay sharp.
const CHECK = '<svg viewBox="0 0 16 16"><path d="M4 8.5l2.5 2.5L12 5.5"/></svg>';
const CHEVRON = '<svg viewBox="0 0 12 12"><path d="M4.5 3L7.5 6 4.5 9"/></svg>';

/**
 * Shows a menu at `anchor`. Items: { label, icon (svg markup), hint (markup), checked, danger, action,
 * submenu: () => items }, or 'separator'. Arrow keys move, Enter/Space run, Right opens a submenu. keepFocus leaves the
 * keyboard focus where it is (a text box keeps showing its selection), and refocus says where it goes on closing. alone: picking
 * from it closes only it, not the popover it was opened over (a card it picks for stays put instead of closing and opening again).
 * @param {MenuEntry[]} items
 * @param {Anchor} anchor
 * @param {{ side?: 'below' | 'right' | 'above', nested?: boolean, alone?: boolean, className?: string, keepFocus?: boolean, refocus?: () => void }} [options]
 */
export function showMenu(items, anchor, { side = SIDE.below, nested = false, alone = false, className = '', keepFocus = false, refocus } = {}) {
  const menu = document.createElement('div');
  if (alone) menu.dataset.alone = '1';
  menu.className = `popover menu context-menu ${className}`;
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  for (const item of items) {
    if (item === SEPARATOR) menu.insertAdjacentHTML('beforeend', '<div class="menu-separator"></div>');
    else menu.append(menuRow(menu, item));
  }

  menu.addEventListener('keydown', e => {
    const rows = [.../** @type {NodeListOf<HTMLButtonElement>} */ (menu.querySelectorAll(':scope > .menu-row:not(:disabled)'))];
    const i = rows.indexOf(/** @type {HTMLButtonElement} */ (menu.ownerDocument.activeElement));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      rows[(i + step + rows.length) % rows.length]?.focus();
    } else if (e.key === 'ArrowLeft' && nested) {
      e.preventDefault();
      closePopover(menu);
    } else if (!e.ctrlKey && !e.altKey && !e.metaKey) {
      const keyed = rows.find(r => r.dataset.key === e.key);
      if (keyed) { e.preventDefault(); keyed.click(); }
    }
  });

  openPopover(menu, anchor, { side, nested, dynamic: true, refocus });
  fitAndScroll(menu);
  if (!keepFocus) /** @type {HTMLButtonElement | null} */ (menu.querySelector('.menu-row:not(:disabled)'))?.focus();
  return menu;
}

/** How far a scroll arrow moves the menu per step while the mouse rests on it (px), and how often (ms). */
const SCROLL_STEP = Object.freeze({ px: 6, ms: 16 });
const CHEVRON_DOWN = '<svg viewBox="0 0 12 12"><path d="M3 4.5L6 7.5 9 4.5"/></svg>';
const CHEVRON_UP = '<svg viewBox="0 0 12 12"><path d="M3 7.5L6 4.5 9 7.5"/></svg>';
/** Where a scroll arrow sits, and its icon. */
/** A scroll arrow at its end (nothing more that way): faded. */
const ARROW_END = 'off';
const SCROLL_ARROW = Object.freeze({ up: { cls: 'up', icon: CHEVRON_UP, dir: -1 }, down: { cls: 'down', icon: CHEVRON_DOWN, dir: 1 } });

/**
 * A menu taller than the window gets the window's height and scrolls: an arrow at its top and one at its bottom
 * scroll it while the mouse rests on them (a click goes a page); the wheel and the arrow keys scroll it too.
 * @param {HTMLElement} menu
 */
function fitAndScroll(menu) {
  const room = viewOf(menu).innerHeight - 2 * EDGE;
  if (menu.offsetHeight <= room) return;
  menu.classList.add('scrolls');
  menu.style.maxHeight = `${room}px`;
  menu.style.top = `${EDGE}px`;
  const arrows = [SCROLL_ARROW.up, SCROLL_ARROW.down].map(a => {
    const el = document.createElement('div');
    el.className = `menu-scroll ${a.cls}`;
    el.ariaHidden = String(true);
    el.innerHTML = a.icon;
    let timer = 0;
    const stop = () => clearInterval(timer);
    el.addEventListener('mouseenter', () => { stop(); timer = setInterval(() => menu.scrollBy(0, a.dir * SCROLL_STEP.px), SCROLL_STEP.ms); });
    el.addEventListener('mouseleave', stop);
    el.addEventListener('mousedown', e => { e.preventDefault(); menu.scrollBy({ top: a.dir * (menu.clientHeight - 2 * el.offsetHeight), behavior: 'smooth' }); });
    return el;
  });
  menu.prepend(arrows[0]);
  menu.append(arrows[1]);
  // An arrow fades at its end: nothing more to scroll that way.
  const ends = () => {
    arrows[0].classList.toggle(ARROW_END, menu.scrollTop <= 0);
    arrows[1].classList.toggle(ARROW_END, menu.scrollTop + menu.clientHeight >= menu.scrollHeight - 1);
  };
  menu.addEventListener('scroll', ends);
  ends();
}

/**
 * One of a menu's rows: its icon (or tick), label and hint (or a submenu's chevron), and what choosing it does.
 * @param {HTMLElement} menu
 * @param {MenuItem} item
 */
function menuRow(menu, item) {
  const button = document.createElement('button');
  const checkable = item.checked !== undefined;
  button.className = `menu-row${item.danger ? ' danger' : ''}`;
  button.setAttribute('role', checkable ? 'menuitemcheckbox' : 'menuitem');
  if (checkable) button.setAttribute('aria-checked', String(item.checked));
  button.innerHTML = `
      <span class="menu-icon">${checkable ? (item.checked ? CHECK : '') : item.icon ?? ''}</span>
      <span class="menu-label"></span>
      <span class="menu-hint">${item.submenu ? CHEVRON : item.hint ?? ''}</span>`;
  /** @type {HTMLElement} */ (button.querySelector('.menu-label')).textContent = item.label;
  // Shown but greyed out and not clickable (a disabled button gets no clicks); title says why.
  if (item.disabled) button.disabled = true;
  if (item.title) button.title = item.title;
  if (item.key) button.dataset.key = item.key;
  const closeSubmenus = () => { for (const other of menu.querySelectorAll('.menu-row.open')) closePopoverAt(other); };
  const { submenu } = item;
  if (submenu) {
    const openSub = () => {
      if (button.classList.contains('open')) return;
      closeSubmenus();
      showMenu(submenu(), button, { side: SIDE.right, nested: true });
    };
    button.addEventListener('mouseenter', openSub);
    button.addEventListener('click', openSub);
    button.addEventListener('keydown', e => {
      if (e.key === 'ArrowRight') { e.preventDefault(); openSub(); }
    });
  } else {
    button.addEventListener('mouseenter', closeSubmenus);
    button.addEventListener('click', () => {
      if (menu.dataset.alone) closePopover(menu);
      else closeAll();
      item.action?.();
    });
  }
  return button;
}

/**
 * Closes the submenu that was opened from `row`.
 * @param {Element} row
 */
function closePopoverAt(row) {
  const i = stack.findIndex(entry => entry.anchorEl === row);
  if (i >= 0) closeFrom(i);
}

// ---- Dropdowns ----


/**
 * Shows `select` as a button that opens the app's own menu instead of Windows' list. The <select> stays in the page,
 * hidden, and keeps the value: picking sets it and fires its change event. Optgroups become separated sections.
 * Safe to call again after the value changed in code; it just refreshes the button's label.
 * @param {HTMLSelectElement} select
 */
export function dropdown(select) {
  const next = select.nextElementSibling;
  // By tag, not instanceof: a select in a detached window is of that window's elements.
  let button = next?.tagName === 'BUTTON' && next.classList.contains('dropdown') ? /** @type {HTMLButtonElement} */ (next) : null;
  if (!button) {
    const made = document.createElement('button');
    button = made;
    made.type = 'button';
    made.className = `${select.className} dropdown`;
    made.innerHTML = `<span class="dropdown-label"></span><span class="dropdown-chevron">${CHEVRON_DOWN}</span>`;
    const label = select.getAttribute('aria-label');
    if (label) made.setAttribute('aria-label', label);
    made.setAttribute('aria-haspopup', 'menu');
    select.hidden = true;
    select.after(made);
    select.addEventListener('change', () => dropdown(select));
    made.addEventListener('click', () => openDropdown(select, made));
  }
  /** @type {HTMLElement} */ (button.querySelector('.dropdown-label')).textContent = select.selectedOptions[0]?.textContent ?? '';
}

/**
 * A dropdown's menu: the select's options (a section per optgroup), the chosen one ticked and in view.
 * @param {HTMLSelectElement} select
 * @param {HTMLButtonElement} button
 */
function openDropdown(select, button) {
  if (button.classList.contains('open')) return closeAll();
  /** @type {ParentNode[]} */
  const groups = select.querySelector('optgroup') ? [...select.querySelectorAll('optgroup')] : [select];
  const items = groups.filter(g => g.querySelector('option')).flatMap((group, i) => [
    ...(i ? /** @type {MenuEntry[]} */ ([SEPARATOR]) : []),
    ...[...group.querySelectorAll('option')].map(option => ({
      label: option.textContent ?? '',
      checked: option.value === select.value,
      action: () => {
        if (select.value === option.value) return;
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      },
    })),
  ]);
  const menu = showMenu(items, button, { className: DROPDOWN_MENU });
  menu.style.minWidth = `${button.offsetWidth}px`;
  /** @type {HTMLElement | null} */
  const current = menu.querySelector('[aria-checked="true"]');
  current?.focus();
  current?.scrollIntoView({ block: 'nearest' });
}
