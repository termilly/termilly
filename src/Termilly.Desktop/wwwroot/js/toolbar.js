// @ts-check
// The title bar's buttons, New terminal to Settings, dock on any edge of the window. Dragged by any of them (past a few
// pixels, so a click stays a click) they follow the pointer to the nearest edge and slide along the free room there;
// right-click picks an edge. On the top edge they stay in the title bar, either side of the search box: on its right
// sliding between it and the window's buttons, on its left between the app's name and it, and the search box moves
// over to make room for them (app.css). On another edge they get a strip of their own beside the sidebar and the terminals. What opens
// from one of them opens away from its edge (data-side, read by js/popups.js and js/tooltips.js).

import { state, persist } from './store.js';
import { showMenu, closeAll } from './popups.js';
import { scheduleFit } from './terminals.js';
import { find, targetOf, isAcross, DOCK_SIDE, TOOLBAR } from './dom.js';

/** How far the pointer goes with a button held before it drags the bar instead of clicking the button (px). */
const DRAG_START_PX = 5;
/**
 * Where on an edge the bar goes when the edge is picked from its menu: 0 at its start (left or top), 1 at its end.
 * @type {Readonly<Record<string, number>>}
 */
const DEFAULT_AT = Object.freeze({
  [DOCK_SIDE.top]: 1, [DOCK_SIDE.left]: 0, [DOCK_SIDE.right]: 0, [DOCK_SIDE.bottom]: 0.5,
});
/** Which side of the search box it's on, on the top edge. */
const BESIDE = Object.freeze({ left: 'left', right: 'right' });
/** Where on the left of the search box it goes when that's picked from its menu: next to the app's name. */
const LEFT_AT = 0;
/**
 * The places its menu offers: an edge, which side of the search box on the top one, and what each is called there.
 * @type {readonly [string, string | undefined, string][]}
 */
const PLACES = Object.freeze([
  [DOCK_SIDE.top, BESIDE.left, 'Dock at the top, left of the search box'],
  [DOCK_SIDE.top, BESIDE.right, 'Dock at the top, right of the search box'],
  [DOCK_SIDE.left, undefined, 'Dock on the left'], [DOCK_SIDE.right, undefined, 'Dock on the right'],
  [DOCK_SIDE.bottom, undefined, 'Dock at the bottom'],
]);
/** The body's class while the bar is dragged (app.css), and the attribute that says which edge it's on. */
const MOVING = 'moving-bar';
/** The title bar's class when it has no room for the app's name beside the bar (app.css). */
const TIGHT = 'tight';

const toolbar = find(document, `#titlebar ${TOOLBAR}`);
/** Its places in the title bar: right of the search box, before the divider ahead of the window's buttons... */
const home = /** @type {HTMLElement} */ (toolbar.parentElement);
const homeNext = toolbar.nextElementSibling;
/** ...and left of it, after the app's name (before the workspace's name, shown while the sidebar is closed). */
const leftHome = find(document, '#titlebar .tb-left');
const brand = find(leftHome, '.brand');
const search = find(document, '#search-button');
/** The strips it docks in on the other edges (index.html), by edge. */
const strips = /** @type {Record<string, HTMLElement>} */ (Object.fromEntries(
  [.../** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.bar-dock'))].map(el => [el.dataset.side, el])));
/** How far it's moved along its edge from where the layout puts it (px). */
let shift = 0;

/** The edge it's on. */
function sideNow() {
  const side = state.toolbar.side;
  return side && /** @type {string[]} */ (Object.values(DOCK_SIDE)).includes(side) ? side : DOCK_SIDE.top;
}

/** Which side of the search box it's on, when it's on the top edge. */
const besideNow = () => (state.toolbar.beside === BESIDE.left ? BESIDE.left : BESIDE.right);

/** Its place in the title bar now. */
const homeNow = () => (besideNow() === BESIDE.left ? leftHome : home);

/** @param {number} n */
const fraction = n => Math.min(1, Math.max(0, n));

/** Where along its edge it is, from 0 to 1. */
function atNow() {
  const at = state.toolbar.at;
  if (typeof at === 'number' && Number.isFinite(at)) return fraction(at);
  return sideNow() === DOCK_SIDE.top && besideNow() === BESIDE.left ? LEFT_AT : DEFAULT_AT[sideNow()];
}

/** Into its strip on its edge, or back into the title bar. */
function put() {
  const side = sideNow();
  document.body.dataset.bar = side;
  // Which side of the search box, read by app.css: the title bar's columns make room for it there.
  document.body.dataset.barBeside = side === DOCK_SIDE.top ? besideNow() : '';
  toolbar.dataset.side = side;
  const parent = side === DOCK_SIDE.top ? homeNow() : strips[side];
  if (toolbar.parentElement === parent) return;
  if (parent === home) home.insertBefore(toolbar, homeNext);
  else if (parent === leftHome) brand.after(toolbar);
  else parent.append(toolbar);
  shift = 0;
  toolbar.style.transform = '';
  scheduleFit();
}

/**
 * Its edge's free room: where on it the bar can start and how far it can slide from there, where the layout puts it,
 * and its length, along the edge (page pixels). In the title bar the layout puts it at the end of the room.
 */
function track() {
  const across = isAcross(sideNow());
  const bar = toolbar.getBoundingClientRect();
  const natural = (across ? bar.left : bar.top) - shift;
  const length = across ? bar.width : bar.height;
  if (toolbar.parentElement === home) {
    // No room left of it in a narrow window: it stays where the layout puts it.
    const start = Math.min(natural, home.getBoundingClientRect().left);
    return { across, start, room: natural - start, natural, length };
  }
  if (toolbar.parentElement === leftHome) {
    // After the app's name, with the room up to the search box (none in a narrow window) to slide into.
    return { across, start: natural, room: Math.max(0, leftHome.getBoundingClientRect().right - (natural + length)), natural, length };
  }
  const strip = /** @type {HTMLElement} */ (toolbar.parentElement);
  return { across, start: natural, room: Math.max(0, (across ? strip.clientWidth : strip.clientHeight) - length), natural, length };
}

/**
 * Left of the search box in a window too narrow for the app's name too, the name goes (app.css), as it's covered when
 * they're on the right: the bar, the search box and the window's buttons keep their room.
 */
function fitTitle() {
  const bar = /** @type {HTMLElement} */ (leftHome.parentElement);
  bar.classList.remove(TIGHT);
  if (toolbar.parentElement === leftHome && bar.scrollWidth > bar.clientWidth) bar.classList.add(TIGHT);
}

/** Moves it to where along its edge it's kept, in whole pixels so its icons stay sharp. */
function place() {
  const t = track();
  shift = Math.round(t.start + atNow() * t.room - t.natural);
  toolbar.style.transform = shift ? `translate${t.across ? 'X' : 'Y'}(${shift}px)` : '';
}

/** Room for the app's name or not, then where along its edge. */
function slide() {
  fitTitle();
  place();
}

/**
 * Docks it on an edge, where its menu puts it there, and keeps that.
 * @param {string} side
 * @param {string} [beside] on the top edge, which side of the search box
 */
function dockBar(side, beside) {
  state.toolbar = { side, beside, at: beside === BESIDE.left ? LEFT_AT : DEFAULT_AT[side] };
  put();
  slide();
  persist();
}

/**
 * The window's edge nearest a point.
 * @param {number} x
 * @param {number} y
 */
function nearestEdge(x, y) {
  const edges = /** @type {[string, number][]} */ ([
    [DOCK_SIDE.top, y], [DOCK_SIDE.bottom, innerHeight - y], [DOCK_SIDE.left, x], [DOCK_SIDE.right, innerWidth - x],
  ]);
  return edges.reduce((near, edge) => (edge[1] < near[1] ? edge : near))[0];
}

/**
 * Follows the pointer while it's dragged: onto the nearest edge, the grabbed point (a fraction of its length, the
 * same button either way round) under the pointer as far as the room there allows.
 * @param {PointerEvent} ev
 * @param {number} grab
 */
function follow(ev, grab) {
  const side = nearestEdge(ev.clientX, ev.clientY);
  const box = search.getBoundingClientRect();
  const beside = ev.clientX < box.left + box.width / 2 ? BESIDE.left : BESIDE.right;
  if (side !== sideNow() || (side === DOCK_SIDE.top && beside !== besideNow())) {
    state.toolbar.side = side;
    if (side === DOCK_SIDE.top) state.toolbar.beside = beside;
    put();
  }
  const t = track();
  const wanted = (t.across ? ev.clientX : ev.clientY) - grab * t.length;
  state.toolbar.at = t.room ? fraction((wanted - t.start) / t.room) : DEFAULT_AT[side];
  slide();
}

/** The click that ends a drag on a button doesn't click it. */
function swallowClick() {
  /** @param {MouseEvent} e */
  const swallow = e => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', swallow, true));
}

toolbar.addEventListener('pointerdown', e => {
  if (e.button !== 0 || !targetOf(e).closest('button')) return;
  const from = { x: e.clientX, y: e.clientY };
  const t = track();
  const grab = t.length ? ((t.across ? e.clientX : e.clientY) - (t.natural + shift)) / t.length : 0;
  const body = document.body;
  /** @param {PointerEvent} ev */
  const move = ev => {
    if (!body.classList.contains(MOVING)) {
      if (Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < DRAG_START_PX) return;
      // Captured by the page, not the bar: the bar leaves its place in the page as it changes edge.
      body.setPointerCapture(e.pointerId);
      body.classList.add(MOVING);
      closeAll();
    }
    follow(ev, grab);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    if (!body.classList.contains(MOVING)) return;
    body.classList.remove(MOVING);
    swallowClick();
    persist();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
});

// Out of the title bar its buttons still mustn't take the keyboard focus from the terminal.
toolbar.addEventListener('mousedown', e => {
  if (targetOf(e).closest('button')) e.preventDefault();
});

toolbar.addEventListener('contextmenu', e => {
  e.preventDefault();
  const now = sideNow();
  const nowBeside = now === DOCK_SIDE.top ? besideNow() : undefined;
  showMenu(PLACES.map(([side, beside, label]) => ({ label, checked: side === now && beside === nowBeside, action: () => dockBar(side, beside) })),
    { x: e.clientX, y: e.clientY });
});

// The room on its edge changes with the window, the sidebar and the title bar's other parts.
// The app's name is let go or brought back a frame later: the title bar changing size while it's measured would make the
// observer report again before it's done.
const resized = new ResizeObserver(() => {
  place();
  requestAnimationFrame(slide);
});
for (const el of [home, leftHome, toolbar, ...Object.values(strips)]) resized.observe(el);

/** Puts it where it was left (main.js, once the saved state is in). */
export function initToolbar() {
  put();
  slide();
}
