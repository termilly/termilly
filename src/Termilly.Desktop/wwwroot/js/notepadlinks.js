// @ts-check
// The Notepad's links (js/notepad.js): web addresses, and paths that lead to a file or folder (found from the focused
// terminal's folder, as in a terminal), coloured in its text. A text box can't colour part of its text, so the text
// shows in a layer under it (the box's own text is clear; its caret and selection still show). While Ctrl is held the
// layer takes the mouse: Ctrl+click opens a link, and Ctrl+C copies the one under the mouse, as in a terminal.

import { PAGE } from './protocol.js';
import { send } from './host.js';
import { focusedTab } from './panes.js';
import { realPaths, openChange } from './changes.js';
import { findWebLinks } from './webaddress.js';
import { COPY_HINT } from './termlinks.js';
import { escapeHtml } from './ui.js';
import { showToast } from './toasts.js';
import { debounce } from './util.js';
import { targetOf } from './dom.js';

/** A link in the page: where it is, its text, whether it's a web address, its tooltip and what Ctrl+click does. */
/** @typedef {{ start: number, end: number, text: string, web: boolean, title: string, open: () => void }} PadLink */

const LF = '\n';
/** How long typing pauses before the paths are looked for again (each one is asked of the host). */
const FIND_AFTER_MS = 300;
const LINK_CLASS = 'np-link';
/** On the editor while Ctrl is held: the layer takes the mouse. */
const CTRL_CLASS = 'np-ctrl';
const COPY_KEY = 'KeyC';

/** The Notepad's text box, the editor around it and the layer under it (padLinks sets them). */
let area = /** @type {HTMLTextAreaElement} */ (/** @type {unknown} */ (null));
let editor = /** @type {HTMLElement} */ (/** @type {unknown} */ (null));
const layer = document.createElement('div');
layer.className = 'np-layer';
layer.setAttribute('aria-hidden', 'true');
let on = () => false;
/** @type {PadLink[]} */
let links = [];
/** @type {PadLink | null} */
let hovered = null;
/** The text the links were placed in, to move them along as it's edited. */
let last = '';
let run = 0;

/**
 * @param {{ start: number, end: number, text: string }} w a web address in a line
 * @param {number} from where the line starts in the page
 * @returns {PadLink}
 */
const webLink = (w, from) => ({
  start: from + w.start, end: from + w.end, text: w.text, web: true,
  title: `${w.text}\nCtrl+click to open in your browser\n${COPY_HINT}`,
  open: () => send(PAGE.openUrl, { url: w.text }),
});

/**
 * Each line of a page and where it starts.
 * @param {string} text
 */
function linesOf(text) {
  let at = 0;
  return text.split(LF).map(line => {
    const from = at;
    at += line.length + LF.length;
    return { line, from };
  });
}

/** @param {string} text */
const webLinks = text => linesOf(text).flatMap(({ line, from }) => findWebLinks(line).map(w => webLink(w, from)));

/**
 * The web addresses, then the paths that don't overlap one, in the page's order.
 * @param {PadLink[]} web
 * @param {PadLink[]} paths
 */
const merged = (web, paths) => [...web, ...paths.filter(p => !web.some(w => p.start < w.end && p.end > w.start))].sort((a, b) => a.start - b.start);

/** The layer over the box's text area (not its scroll bars), scrolled as it is. */
function fit() {
  layer.style.width = `${area.clientWidth}px`;
  layer.style.height = `${area.clientHeight}px`;
  layer.scrollTop = area.scrollTop;
  layer.scrollLeft = area.scrollLeft;
}

function draw() {
  const text = area.value;
  let html = '';
  let at = 0;
  links.forEach((l, i) => {
    html += `${escapeHtml(text.slice(at, l.start))}<span class="${LINK_CLASS}" data-link="${i}" title="${escapeHtml(l.title)}">${escapeHtml(text.slice(l.start, l.end))}</span>`;
    at = l.end;
  });
  // A space after the last line: a last empty line still takes a line in the box.
  layer.innerHTML = `${html}${escapeHtml(text.slice(at))} `;
  last = text;
  fit();
}

/**
 * The paths in the page that lead somewhere, from the focused terminal's folder (the host checks each).
 * @param {string} text
 * @returns {Promise<PadLink[]>}
 */
async function pathLinks(text) {
  const tab = focusedTab();
  if (!tab) return [];
  const found = await Promise.all(linesOf(text).filter(l => l.line.trim()).map(async ({ line, from }) =>
    (await realPaths(tab, line)).map(p => ({
      start: from + p.start, end: from + p.end, text: p.text, web: false, title: `${p.text}\n${p.title}`, open: () => openChange(tab, p.text),
    }))));
  return found.flat();
}

const findAll = debounce(async () => {
  const mine = ++run;
  const text = area.value;
  const paths = await pathLinks(text);
  if (mine !== run || area.value !== text || !on()) return;
  links = merged(webLinks(text), paths);
  draw();
}, FIND_AFTER_MS);

/** After typing: the addresses found again, the paths kept where their text still is (moved by what was typed). */
function edited() {
  if (!on()) return;
  const text = area.value;
  const delta = text.length - last.length;
  const caret = area.selectionStart;
  const paths = links.filter(l => !l.web).flatMap(l => {
    const at = l.start >= caret - Math.max(delta, 0) ? l.start + delta : l.start;
    return text.slice(at, at + l.text.length) === l.text ? [{ ...l, start: at, end: at + l.text.length }] : [];
  });
  links = merged(webLinks(text), paths);
  draw();
  findAll();
}

/** A page shown, or links turned on or off: drawn from scratch. */
function refresh() {
  editor.classList.remove(CTRL_CLASS);
  hovered = null;
  links = [];
  if (!on()) {
    layer.textContent = '';
    return;
  }
  links = webLinks(area.value);
  draw();
  findAll();
}

/** @param {Event} e */
const linkAt = e => {
  const el = /** @type {HTMLElement | null} */ (targetOf(e).closest(`.${LINK_CLASS}`));
  return el ? links[Number(el.dataset.link)] ?? null : null;
};

/** @param {KeyboardEvent} e */
function copyHovered(e) {
  if (!e.ctrlKey || e.shiftKey || e.altKey || e.code !== COPY_KEY || area.selectionStart !== area.selectionEnd) return;
  if (!hovered || !editor.classList.contains(CTRL_CLASS)) return;
  e.preventDefault();
  navigator.clipboard.writeText(hovered.text).catch(() => {});
  showToast({ text: `Copied ${hovered.text}` });
}

function wire() {
  area.addEventListener('scroll', fit, { passive: true });
  new ResizeObserver(fit).observe(area);
  /** @param {KeyboardEvent} e */
  const ctrl = e => editor.classList.toggle(CTRL_CLASS, on() && e.ctrlKey);
  window.addEventListener('keydown', ctrl, true);
  window.addEventListener('keyup', ctrl, true);
  window.addEventListener('blur', () => editor.classList.remove(CTRL_CLASS));
  layer.addEventListener('pointerover', e => { hovered = linkAt(e); });
  layer.addEventListener('mouseout', e => { if (!layer.contains(/** @type {Node | null} */ (e.relatedTarget))) hovered = null; });
  layer.addEventListener('mousedown', e => {
    const link = linkAt(e);
    if (!link || e.button !== 0) return;
    e.preventDefault(); // the text box keeps the focus
    link.open();
  });
  // Ctrl+C with nothing selected copies the link under the mouse.
  area.addEventListener('keydown', copyHovered);
}

/**
 * Links for the Notepad's text box, while `when` says so.
 * @param {HTMLTextAreaElement} box
 * @param {() => boolean} when
 */
export function padLinks(box, when) {
  area = box;
  editor = /** @type {HTMLElement} */ (box.parentElement);
  on = when;
  box.before(layer);
  wire();
  return { refresh, edited };
}
