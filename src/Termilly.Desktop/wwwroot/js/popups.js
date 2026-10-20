// @ts-check
// Anchored popovers and context menus. One stack: opening a top-level popover closes the others; a
// submenu opens on top of its parent. Clicking outside or pressing Escape closes from the top down.

/**
 * Where a popover shows: next to an element, a rectangle, or a point.
 * @typedef {Element | DOMRect | { x: number, y: number }} Anchor
 */

/**
 * One of a menu's entries, or 'separator'. `checked` makes it a checkbox; `submenu` opens more entries beside it.
 * @typedef {{ label: string, icon?: string, hint?: string, checked?: boolean, danger?: boolean, disabled?: boolean,
 *   title?: string, action?: () => unknown, submenu?: () => MenuEntry[] }} MenuItem
 * @typedef {MenuItem | typeof SEPARATOR} MenuEntry
 */

/** A menu entry that draws a line between groups of entries. */
export const SEPARATOR = 'separator';

/** Which side of its anchor a popover opens on: below it, or to its right (a submenu). */
export const SIDE = Object.freeze({ below: 'below', right: 'right' });

/** @type {Array<{ el: HTMLElement, anchorEl: Element | null, onClose?: () => void, dynamic: boolean }>} */
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
 * Options: side ('below' | 'right'), nested (keep the popovers under it open), onClose, dynamic (remove on close).
 * @param {HTMLElement} el
 * @param {Anchor} anchor
 * @param {{ side?: 'below' | 'right', nested?: boolean, onClose?: () => void, dynamic?: boolean }} [options]
 */
export function openPopover(el, anchor, { side = SIDE.below, nested = false, onClose, dynamic = false } = {}) {
  if (!nested) closeAll();
  if (dynamic && !el.isConnected) document.body.append(el);
  el.hidden = false;
  const anchorEl = anchor instanceof Element ? anchor : null;
  anchorEl?.classList.add('open');
  place(el, anchorEl ? anchorEl.getBoundingClientRect() : /** @type {DOMRect | { x: number, y: number }} */ (anchor), side);
  stack.push({ el, anchorEl, onClose, dynamic });
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
  if (!stack.length) restoreFocus();
}

/**
 * @param {HTMLElement} el
 * @param {DOMRect | { x: number, y: number }} rect
 * @param {'below' | 'right'} side
 */
function place(el, rect, side) {
  const r = RECT_EDGE in rect ? rect : { left: rect.x, right: rect.x, top: rect.y, bottom: rect.y };
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let left;
  let top;
  if (side === SIDE.right) {
    left = r.right + GAP_BESIDE;
    if (left + w > innerWidth - EDGE) left = r.left - w - GAP_BESIDE;
    top = r.top - GAP_BELOW;
  } else {
    left = r.left;
    top = r.bottom + GAP_BELOW;
    if (top + h > innerHeight - EDGE) top = r.top - h - GAP_BELOW;
  }
  // Whole pixels: an anchor at a fractional position would otherwise blur every icon and line in the popover.
  el.style.left = `${Math.round(Math.max(EDGE, Math.min(left, innerWidth - w - EDGE)))}px`;
  el.style.top = `${Math.round(Math.max(EDGE, Math.min(top, innerHeight - h - EDGE)))}px`;
}

document.addEventListener('mousedown', e => {
  if (!stack.length) return;
  const top = stack[stack.length - 1];
  const target = /** @type {Node | null} */ (e.target);
  if (stack.some(entry => entry.el.contains(target)) || top.anchorEl?.contains(target)) return;
  closeAll();
}, true);

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !stack.length) return;
  e.preventDefault();
  e.stopImmediatePropagation(); // a dialog under the menu stays open
  closeFrom(stack.length - 1);
}, true);

// ---- Context menus ----

// Drawn at the size the menu shows them (16px and 12px), so they stay sharp.
const CHECK = '<svg viewBox="0 0 16 16"><path d="M4 8.5l2.5 2.5L12 5.5"/></svg>';
const CHEVRON = '<svg viewBox="0 0 12 12"><path d="M4.5 3L7.5 6 4.5 9"/></svg>';

/**
 * Shows a menu at `anchor`. Items: { label, icon (svg markup), hint (markup), checked, danger, action,
 * submenu: () => items }, or 'separator'. Arrow keys move, Enter/Space run, Right opens a submenu.
 * @param {MenuEntry[]} items
 * @param {Anchor} anchor
 * @param {{ side?: 'below' | 'right', nested?: boolean, className?: string }} [options]
 */
export function showMenu(items, anchor, { side = SIDE.below, nested = false, className = '' } = {}) {
  const menu = document.createElement('div');
  menu.className = `popover menu context-menu ${className}`;
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  for (const item of items) {
    if (item === SEPARATOR) menu.insertAdjacentHTML('beforeend', '<div class="menu-separator"></div>');
    else menu.append(menuRow(menu, item));
  }

  menu.addEventListener('keydown', e => {
    const rows = [.../** @type {NodeListOf<HTMLButtonElement>} */ (menu.querySelectorAll(':scope > .menu-row:not(:disabled)'))];
    const i = rows.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      rows[(i + step + rows.length) % rows.length]?.focus();
    } else if (e.key === 'ArrowLeft' && nested) {
      e.preventDefault();
      closePopover(menu);
    }
  });

  openPopover(menu, anchor, { side, nested, dynamic: true });
  /** @type {HTMLButtonElement | null} */ (menu.querySelector('.menu-row:not(:disabled)'))?.focus();
  return menu;
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
      closeAll();
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

const CHEVRON_DOWN = '<svg viewBox="0 0 12 12"><path d="M3 4.5L6 7.5 9 4.5"/></svg>';

/**
 * Shows `select` as a button that opens the app's own menu instead of Windows' list. The <select> stays in the page,
 * hidden, and keeps the value: picking sets it and fires its change event. Optgroups become separated sections.
 * Safe to call again after the value changed in code; it just refreshes the button's label.
 * @param {HTMLSelectElement} select
 */
export function dropdown(select) {
  const next = select.nextElementSibling;
  let button = next instanceof HTMLButtonElement && next.classList.contains('dropdown') ? next : null;
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
  const menu = showMenu(items, button, { className: 'dropdown-menu' });
  menu.style.minWidth = `${button.offsetWidth}px`;
  /** @type {HTMLElement | null} */
  const current = menu.querySelector('[aria-checked="true"]');
  current?.focus();
  current?.scrollIntoView({ block: 'nearest' });
}
