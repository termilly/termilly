// @ts-check
// A tool that always opens in a window of its own (the Git window): its element moves out of the main page into a
// detached window (js/windows.js) as it opens, with Minimize, Maximize, Close and the pin in its header, and comes back
// into the page as it closes. Where Termilly can't open a window of its own, it shows over the main window, in its
// layer, as it always did. The window opens where it was last left; the first time, centred on the main window.

import { detach, closeWindow, focusWindow, isDetached, setWindowTitle } from './windows.js';

/** How much of the main window it takes the first time. */
const FIRST_SHARE = 0.8;

/**
 * What the tool gives: its key (the window's name and its remembered place), its title, the page's layer it shows in
 * without a window, the element that moves, its header (the window's title bar), what closing it does (asking first,
 * when it has to), what runs once it shows (with the window it's in, or null in the main page), and what runs when the
 * window went without close being asked (its host closed it).
 * @typedef {{ key: string, title: string, layer: HTMLElement, box: HTMLElement, header: HTMLElement,
 *   close: () => unknown, onShown: (win: Window | null) => void, onGone: () => void }} OwnWindowParts
 */

/**
 * @typedef {{ isOpen: () => boolean, show: () => void, hide: () => void, setTitle: (title: string) => void }} OwnWindow
 */

/**
 * @param {OwnWindowParts} parts
 * @returns {OwnWindow}
 */
export function ownWindow({ key, title, layer, box, header, close, onShown, onGone }) {
  const hideLayer = () => {
    layer.hidden = true;
    layer.style.visibility = '';
  };
  const moveOut = () => {
    const w = Math.round(innerWidth * FIRST_SHARE), h = Math.round(innerHeight * FIRST_SHARE);
    return detach(key, {
      el: box, title, askClose: close, close, header, remember: true, returnable: false,
      firstPlace: { x: Math.round(screenX + (innerWidth - w) / 2), y: Math.round(screenY + (innerHeight - h) / 2), w, h },
      onClosed: () => {
        layer.append(box);
        hideLayer();
        onGone();
      },
      onMoved: () => {
        hideLayer();
        onShown(box.ownerDocument.defaultView);
      },
    });
  };
  return {
    isOpen: () => !layer.hidden || isDetached(key),
    show() {
      if (isDetached(key)) return focusWindow(key);
      if (!layer.hidden) return;
      // Laid out (unseen) at the size it has in the page while its window opens, then moved in.
      layer.hidden = false;
      layer.style.visibility = 'hidden';
      if (moveOut()) return;
      layer.style.visibility = '';
      onShown(null);
    },
    hide() {
      if (isDetached(key)) {
        closeWindow(key, { quiet: true });
        layer.append(box);
      }
      hideLayer();
    },
    setTitle: text => setWindowTitle(key, text),
  };
}
