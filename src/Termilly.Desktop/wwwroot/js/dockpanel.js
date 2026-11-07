// @ts-check
// A panel docked on an edge of the terminals' area that goes out into a window of its own and back (the Notepad and To
// do): dragged by its header it docks on any edge, or leaves. What it shows stays with its own module, which gives it
// what it keeps (`stored`) and calls it to show, hide and draw.

import { persist } from './store.js';
import { wireDragOut, systemDrag, dockDrop, restoreFocus } from './panes.js';
import { scheduleFit } from './terminals.js';
import { byId, dockRight, isAcross, edgeAt, DOCK_AWAY, DOCK_SIDE, WORKSPACE_ID } from './dom.js';
import { detach, closeWindow, focusWindow, isDetached } from './windows.js';
import { isShortcut } from './keymap.js';

/** The room the Notepad takes: To do docks just inside it. */
export const NOTEPAD_DOCK = '--notepad-dock';
/** Its narrowest width, and its width until it's dragged; its widest is half the terminals' area (app.css). */
const MIN_WIDTH_PX = 280;
const DEFAULT_WIDTH_PX = 360;
/** On the top or bottom edge: its lowest height, and its height until it's dragged (app.css). */
const MIN_HEIGHT_PX = 180;
const DEFAULT_HEIGHT_PX = 260;
/** How near an edge of the terminals' area a drag docks it there. */
const EDGE_BAND_PX = 120;

/**
 * What a docked panel keeps: open or closed, its edge, sizes, and whether it's in a window of its own.
 * @typedef {{ open: boolean, width?: number, height?: number, side?: string, detached?: boolean }} DockKept
 */

/**
 * @typedef {object} DockPanelOptions
 * @property {HTMLElement} panel
 * @property {HTMLElement} head its header: its title bar in a window of its own, and what drags it out into one
 * @property {string} key its window (js/windows.js)
 * @property {string} name that window's title
 * @property {string} icon its icon, for the drag's picture (markup)
 * @property {string} handle its handle in a window of its own on Linux: dragged back into the main window (js/panes.js)
 * @property {string} dockVar the CSS variable with the room it takes (dockRight)
 * @property {string} [inside] the CSS variable of a panel it docks just inside of: it lands past that one's room
 * @property {() => DockKept} stored
 * @property {HTMLElement} button its title bar button
 * @property {() => void} [showCount] shows what its button counts, if it counts anything
 * @property {(options?: { quiet?: boolean, here?: boolean }) => void} show opens it
 * @property {() => void} render draws what it shows
 * @property {() => void} focus the focus into it
 */

/** A panel that docks on an edge and goes out into a window of its own. */
class DockPanel {
  /** How wide it was docked when it went out into a window of its own (its width is kept only once it's dragged). */
  dockedWidth = 0;

  /** @param {DockPanelOptions} options */
  constructor(options) {
    this.o = options;
    const { panel, head, key, name, icon, handle, dockVar, stored } = options;
    // Its header dragged out of the app window takes it out into a window of its own, as a terminal's (js/panes.js).
    wireDragOut(head, panel, {
      name, icon, detach: (at, place) => this.detach(at, place), isDetached: () => isDetached(key), handle,
      side: () => this.side(), dockAt: (x, y) => this.dockAt(x, y), dockTo: side => this.dockTo(side),
    });
    this.refreshDock = dockRight(panel, {
      dockVar, minWidth: MIN_WIDTH_PX, minHeight: MIN_HEIGHT_PX, side: () => this.side(), resized: scheduleFit,
      dragged: size => {
        if (isAcross(this.side())) stored().height = size;
        else stored().width = size;
        persist();
      },
    });
  }

  /** The edge it docks on. */
  side() {
    const side = this.o.stored().side;
    return side && /** @type {string[]} */ (Object.values(DOCK_SIDE)).includes(side) ? side : DOCK_SIDE.right;
  }

  /** Its panel on its edge: a height of its own on the top or bottom one. */
  placeOnSide() {
    const { panel, stored } = this.o;
    const side = this.side();
    panel.dataset.side = side;
    panel.style.height = isAcross(side) && stored().height ? `${stored().height}px` : '';
  }

  /**
   * Whether it's in a window of its own, kept for the next start.
   * @param {boolean} detached
   */
  keepDetached(detached) {
    const { stored } = this.o;
    if (!!stored().detached === detached) return;
    stored().detached = detached;
    persist();
  }

  /** Seen docked again: its window couldn't open, or went before it got there. */
  dockHere() {
    this.o.panel.classList.remove(DOCK_AWAY);
    this.refreshDock();
  }

  /**
   * Back in its place, from its window, as it was.
   * @param {{ keepWindowed?: boolean }} [options] keepWindowed: only closed, it opens in its own window again next time
   */
  dockBack({ keepWindowed = false } = {}) {
    if (!keepWindowed) this.keepDetached(false);
    byId(WORKSPACE_ID).append(this.o.panel);
    this.dockHere();
    if (!this.o.panel.hidden) this.o.render();
  }

  /** The terminals' area, less the room of a panel it docks inside of. */
  dockArea() {
    const workspace = byId(WORKSPACE_ID);
    const { left, top, right, bottom } = workspace.getBoundingClientRect();
    /** @param {string} [edge] */
    const room = edge => {
      const { inside } = this.o;
      return inside ? parseFloat(workspace.style.getPropertyValue(edge ? `${inside}-${edge}` : inside)) || 0 : 0;
    };
    const [x, y] = [left + room(DOCK_SIDE.left), top + room(DOCK_SIDE.top)];
    return new DOMRect(x, y, right - room() - x, bottom - room(DOCK_SIDE.bottom) - y);
  }

  /**
   * Where it docks on an edge of the main window (in the page's pixels): that edge of the terminals' area, as big as it
   * was docked (at most half).
   * @param {string} side
   */
  dockZone(side) {
    const area = this.dockArea();
    const kept = this.o.stored();
    if (isAcross(side)) {
      const height = Math.min(area.height / 2, Math.max(MIN_HEIGHT_PX, kept.height ?? DEFAULT_HEIGHT_PX));
      return new DOMRect(area.left, side === DOCK_SIDE.top ? area.top : area.bottom - height, area.width, height);
    }
    const width = Math.min(area.width / 2, Math.max(MIN_WIDTH_PX, kept.width ?? (this.dockedWidth || DEFAULT_WIDTH_PX)));
    return new DOMRect(side === DOCK_SIDE.left ? area.left : area.right - width, area.top, width, area.height);
  }

  /**
   * Where a drag at this point would dock it: over where it docks now, or near any edge. Elsewhere, nowhere: it goes out
   * into a window of its own.
   * @param {number} x
   * @param {number} y
   * @returns {import('./panes.js').DockSpot | null}
   */
  dockAt(x, y) {
    const now = this.side();
    // Docked, its dock is where it is: another panel can be between it and the edge.
    const zone = this.isDetached() ? this.dockZone(now) : this.o.panel.getBoundingClientRect();
    const inZone = x >= zone.left && x <= zone.right && y >= zone.top && y <= zone.bottom;
    const side = inZone ? now : edgeAt(byId(WORKSPACE_ID).getBoundingClientRect(), x, y, EDGE_BAND_PX);
    return side ? { side, zone: this.dockZone(side), label: `Dock ${isAcross(side) ? 'at' : 'on'} the ${side}` } : null;
  }

  /**
   * Docks it on an edge, back from its window if it's in one.
   * @param {string} side
   */
  dockTo(side) {
    this.o.stored().side = side;
    persist();
    this.placeOnSide();
    if (this.isDetached()) closeWindow(this.o.key);
    else this.refreshDock();
  }

  isDetached() {
    return isDetached(this.o.key);
  }

  /**
   * Shows or hides it, and keeps which.
   * @param {boolean} open
   */
  setOpen(open) {
    const { panel, button, showCount, stored } = this.o;
    panel.hidden = !open;
    button.classList.toggle('open', open);
    showCount?.();
    if (stored().open !== open) {
      stored().open = open;
      persist();
    }
  }

  /** Closes it, and its window if it's in one. */
  hide() {
    const detached = this.isDetached();
    if (detached) closeWindow(this.o.key, { quiet: true });
    this.setOpen(false);
    // Back in the page, hidden; still one that opens in its own window next time.
    if (detached) this.dockBack({ keepWindowed: true });
    restoreFocus();
  }

  /**
   * Into a window of its own, opened first if it's closed; its header is the window's title bar, Close closes it, and
   * moved back over its dock in the main window it docks there. False when no window could be opened.
   * @param {{ x: number, y: number }} [at] where on the screen it opens (dragged out by its header), else over its place
   * @param {{ x: number, y: number }} [place] exactly where its picture was let go (its top left corner)
   */
  detach(at, place) {
    const { panel, head, key, name, handle, show, focus } = this.o;
    if (panel.hidden) show({ quiet: true, here: true });
    if (!this.isDetached() && !isAcross(this.side())) this.dockedWidth = panel.offsetWidth;
    // Its room here is given back once it's in its window, and as that window is resized.
    return detach(key, {
      el: panel, title: name, onClosed: () => this.dockBack(), onResize: () => this.refreshDock(),
      onMoved: () => {
        panel.classList.remove(DOCK_AWAY);
        this.keepDetached(true);
        focus();
      },
      at, place, remember: true,
      header: head, close: () => this.hide(),
      onDragged: dockDrop((x, y) => this.dockAt(x, y), side => this.dockTo(side)),
      dragHandle: systemDrag ? handle : undefined,
    });
  }

  /**
   * Its own keys while it has the focus: its shortcut closes it, and Escape goes back to the terminal, in the main window
   * (not from a window of its own). True when the key was one of them.
   * @param {KeyboardEvent} e
   * @param {string} shortcut
   */
  closeKeys(e, shortcut) {
    if (isShortcut(e, shortcut)) this.hide();
    else if (e.key === 'Escape' && !e.ctrlKey && !e.shiftKey && !e.altKey && !this.isDetached()) restoreFocus();
    else return false;
    return true;
  }

  /** Its size and edge as they were kept (main.js, once the saved state is in). */
  restorePlace() {
    const { panel, stored } = this.o;
    if (stored().width) panel.style.width = `${stored().width}px`;
    this.placeOnSide();
  }

  /**
   * Closed while in a window of its own, it opens in it again, where it was, unless it's on its way there (`here`).
   * Never seen docked meanwhile: its window can take a second to open (Linux). Call before showing it.
   * @param {boolean} here
   */
  reopensWindowed(here) {
    const reopens = !here && !!this.o.stored().detached && !this.isDetached();
    this.o.panel.classList.toggle(DOCK_AWAY, reopens);
    return reopens;
  }

  /** Opens its window once it's shown; docked when none could be opened. */
  reopenWindow() {
    if (!this.detach()) this.dockHere();
  }

  /** The panel on or off; in a window of its own, that window to the front. */
  toggle() {
    if (this.isDetached()) {
      focusWindow(this.o.key);
      this.o.focus();
    } else if (!this.o.panel.hidden) this.hide();
    else this.o.show();
  }
}

/**
 * Makes a panel dockable and detachable.
 * @param {DockPanelOptions} options
 */
export const dockPanel = options => new DockPanel(options);
