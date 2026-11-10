// @ts-check
// Links in a terminal's text that Termilly finds itself (the files the agent changed, web addresses): read one logical
// line at a time, so a link that wraps onto the next row is one link. Under the mouse it's underlined and coloured;
// Ctrl+click opens it (or a plain click, where the kind of link says so) and Ctrl+C copies it.

/**
 * A kind of link: how to find it in a line, whether it's on, how it opens and what its tooltip says.
 * @typedef {object} LinkKind
 * @property {(text: string) => FoundLink[] | Promise<FoundLink[]>} find Its links in a line; a link may bring its own tooltip.
 * @property {() => boolean} active Off (a setting), it gives no links.
 * @property {() => boolean} [plainClick] A click opens it, and it's underlined without Ctrl.
 * @property {(text: string) => string} title
 * @property {(text: string) => void} open
 */

/** @typedef {{ underline: boolean, pointerCursor: boolean }} Decorations */

const LEFT_BUTTON = 0;
/** @typedef {{ start: number, end: number, text: string, title?: string }} FoundLink */

let ctrlHeld = false;
/**
 * The link under the mouse, so holding Ctrl can underline it.
 * @type {{ link: { text: string, decorations: Decorations }, kind: LinkKind } | null}
 */
let hovered = null;

/**
 * The text of the link under the mouse (a web address or a path, or a link a program marked), for the right-click
 * menu; null when none.
 */
export const linkUnderMouse = () => hovered?.link.text ?? marked ?? null;

/** A link's tooltip line about copying it (termclipboard.js copies it). */
export const COPY_HINT = 'Ctrl+C to copy it';

/** A link a program marked itself (OSC 8, terminals.js) under the mouse, which xterm underlines. */
let marked = /** @type {string | null} */ (null);

/** @param {string | null} uri the marked link the mouse is over, or null when it left */
export function hoverMarkedLink(uri) {
  marked = uri;
}

/**
 * The link Ctrl+C copies: the one under the mouse while Ctrl holds it underlined; null when there's none, so Ctrl+C
 * copies the selection or stops the program as usual.
 */
export function underlinedLink() {
  if (!ctrlHeld) return null;
  if (hovered && hovered.kind.active()) return hovered.link.text;
  return marked;
}

/**
 * xterm shows these only while the link is under the mouse: always underlined there, with the hand when a click opens
 * it (Ctrl held, or a kind that opens on a plain click).
 * @param {LinkKind} kind
 */
const decorations = kind => ({ underline: true, pointerCursor: !!kind.plainClick?.() || ctrlHeld });

/**
 * How a link is coloured under the mouse: a patch of the SSH badges' cyan over its characters, blended with them so
 * only the text takes the colour (xterm's DOM renderer doesn't recolour text itself). On a dark terminal it multiplies
 * (light text turns cyan, the dark background stays dark); on a light one it screens a darker teal (dark text turns
 * teal, the light background stays light).
 */
const HOVER = Object.freeze({
  dark: { color: '#76e3ea', blend: 'multiply' },
  light: { color: '#1b7c83', blend: 'screen' },
});
/** How the eye weighs red, green and blue, and the brightness above which a terminal counts as light. */
const LUMA = [0.2126, 0.7152, 0.0722];
const LIGHT_ABOVE = 0.5;
const HEX = 16;
const CHANNEL_MAX = 255;
/** Where #rrggbb keeps red, green and blue. */
const CHANNELS = [1, 3, 5];

/** @param {any} term xterm */
function hoverStyle(term) {
  const background = term.options.theme?.background;
  if (!background) return HOVER.dark; // xterm's own default is black
  const light = CHANNELS.reduce((sum, at, i) => sum + LUMA[i] * parseInt(background.slice(at, at + 2), HEX) / CHANNEL_MAX, 0) > LIGHT_ABOVE;
  return light ? HOVER.light : HOVER.dark;
}

/**
 * Colours a link's characters, row by row where it wraps; returns what takes the colour off again.
 * @param {any} term xterm
 * @param {{ start: { x: number, y: number }, end: { x: number, y: number } }} range 1-based, as xterm gives it
 */
function paint(term, range) {
  const { baseY, cursorY } = term.buffer.active;
  const style = hoverStyle(term);
  /** @type {Array<{ dispose: () => void }>} */
  const made = [];
  for (let y = range.start.y; y <= range.end.y; y++) {
    const from = y === range.start.y ? range.start.x - 1 : 0;
    const to = y === range.end.y ? range.end.x : term.cols;
    const marker = term.registerMarker(y - 1 - (baseY + cursorY));
    if (!marker) continue;
    const decoration = term.registerDecoration({ marker, x: from, width: to - from, layer: 'top' });
    decoration?.onRender((/** @type {HTMLElement} */ el) => {
      el.style.background = style.color;
      el.style.mixBlendMode = style.blend;
      el.style.pointerEvents = 'none'; // the link stays under the mouse
    });
    // The decoration goes before its marker: a marker's end takes its decoration with it, but not out of xterm's list.
    if (decoration) made.push(decoration);
    made.push(marker);
  }
  return () => { for (const d of made) d.dispose(); };
}

/**
 * The link coloured now. Colouring repaints the terminal, a repaint makes xterm ask for the links again, and that
 * leaves the link and enters it again: it keeps its colour then, and loses it only once the mouse stays away.
 * @type {{ term: any, key: string, off: () => void, leaving: number } | null}
 */
let painted = null;
/** How long a left link keeps its colour, for xterm to come back to it (a path's link takes a moment to be found). */
const LEAVE_GRACE_MS = 150;

/**
 * @param {any} term xterm
 * @param {{ start: { x: number, y: number }, end: { x: number, y: number } }} range
 */
function hoverPaint(term, range) {
  const key = `${range.start.x},${range.start.y},${range.end.x},${range.end.y}`;
  if (painted && painted.term === term && painted.key === key) {
    clearTimeout(painted.leaving);
    return;
  }
  if (painted) { clearTimeout(painted.leaving); painted.off(); }
  painted = { term, key, off: paint(term, range), leaving: 0 };
}

function hoverUnpaint() {
  const was = painted;
  if (!was) return;
  clearTimeout(was.leaving);
  was.leaving = setTimeout(() => {
    if (painted !== was) return;
    was.off();
    painted = null;
  }, LEAVE_GRACE_MS);
}

/**
 * Shows a hovered link as its kind and Ctrl say. xterm redraws through setters it puts on the link's decorations
 * object, so its fields change in place; a new object wouldn't be seen.
 * @param {{ decorations: Decorations }} link
 * @param {LinkKind} kind
 */
function restyle(link, kind) {
  const wanted = decorations(kind);
  link.decorations.underline = wanted.underline;
  link.decorations.pointerCursor = wanted.pointerCursor;
}

/** @param {boolean} held */
function setCtrl(held) {
  if (held === ctrlHeld) return;
  ctrlHeld = held;
  if (hovered) restyle(hovered.link, hovered.kind);
}
window.addEventListener('keydown', e => setCtrl(e.ctrlKey), true);
window.addEventListener('keyup', e => setCtrl(e.ctrlKey), true);
window.addEventListener('blur', () => setCtrl(false));

/** A program (Claude Code, a pager) that breaks long lines itself writes the rest in the next row after a real line
 * break: a row that ends this near the right edge, on a character, went on mid-word (a long path or address); a row
 * the next one's first word wouldn't have fitted on went on at a space (a path with spaces). */
const EDGE = 4;
/** How a row goes on in the next: mid-word, or at a space (put back between them). */
const GOES_ON = Object.freeze({ no: '', word: 'word', space: 'space' });
/** How many rows a line is looked for in, each way. */
const MAX_ROWS = 24;

/**
 * The whole line row y (1-based) is part of, and where each of its characters is on screen (1-based): the rows the
 * terminal wrapped, and the rows a program broke (the next one's indent left out). A path or a link broken any of these
 * ways is found whole.
 * @param {any} term xterm
 * @param {number} y
 */
function logicalLine(term, y) {
  const buffer = term.buffer.active;
  const cols = term.cols;
  const textOf = (/** @type {number} */ row) => buffer.getLine(row)?.translateToString(true) ?? '';
  const wrapped = (/** @type {number} */ row) => !!buffer.getLine(row)?.isWrapped;
  const groupStart = (/** @type {number} */ row) => { while (row > 0 && wrapped(row)) row--; return row; };
  const groupEnd = (/** @type {number} */ row) => { while (wrapped(row + 1)) row++; return row; };
  // Row end (the last of its group) goes on in row end + 1, which starts a group of its own.
  const goesOn = (/** @type {number} */ end) => {
    if (!buffer.getLine(end + 1)) return GOES_ON.no;
    const t = textOf(end);
    const next = textOf(end + 1).trimStart();
    if (!/\S$/.test(t) || !next) return GOES_ON.no;
    if (t.length >= cols - EDGE) return GOES_ON.word;
    return t.length + 1 + next.split(' ')[0].length > cols - EDGE ? GOES_ON.space : GOES_ON.no;
  };
  /** @type {Map<number, string>} the rows that went on at a space */
  const spaced = new Map();
  /** @param {number} end */
  const joins = end => {
    const how = goesOn(end);
    if (how === GOES_ON.space) spaced.set(end + 1, ' ');
    return how !== GOES_ON.no;
  };
  let first = groupStart(y - 1);
  while (first > 0 && first > y - 1 - MAX_ROWS && joins(first - 1)) first = groupStart(first - 1);
  let last = groupEnd(y - 1);
  while (last < y - 1 + MAX_ROWS && joins(last)) last = groupEnd(last + 1);
  let text = '';
  /** @type {{ x: number, y: number }[]} */
  const where = [];
  for (let row = first; row <= last; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const soft = wrapped(row + 1) && row !== last;
    let part = line.translateToString(!soft);
    if (soft) part = part.padEnd(cols);
    // A row a program went on in: its indent isn't part of the line.
    const skip = row > first && !line.isWrapped ? part.length - part.trimStart().length : 0;
    if (spaced.has(row) && where.length) {
      // The space the line was broken at, where the row before ends.
      const end = where[where.length - 1];
      where.push({ x: Math.min(end.x + 1, cols), y: end.y });
      text += ' ';
    }
    for (let i = skip; i < part.length; i++) where.push({ x: i + 1, y: row + 1 });
    text += part.slice(skip);
  }
  return { text, at: (/** @type {number} */ offset) => where[Math.min(offset, where.length - 1)] ?? { x: 1, y } };
}

/**
 * One link xterm can show: underlined and opened as its kind says, its tooltip on the terminal while hovered.
 * @param {{ range: { start: { x: number, y: number }, end: { x: number, y: number } }, text: string, title: string }} found where it is on screen, its text and tooltip
 * @param {LinkKind} kind
 * @param {HTMLElement} body
 * @param {any} term xterm, for the hover colour
 */
function makeLink({ range, text, title }, kind, body, term) {
  const link = {
    range,
    text,
    decorations: decorations(kind),
    /** @param {MouseEvent} e */
    activate(e) {
      // xterm activates on any button; a right-click is for the menu (js/actions.js offers the link's actions there).
      if (e.button !== LEFT_BUTTON) return;
      if ((e.ctrlKey || kind.plainClick?.()) && kind.active()) kind.open(text);
    },
    hover() {
      hovered = { link, kind };
      restyle(link, kind);
      hoverPaint(term, range);
      body.title = title;
    },
    leave() {
      if (hovered?.link === link) hovered = null;
      hoverUnpaint();
      body.title = '';
    },
  };
  return link;
}

/**
 * Makes a kind of link clickable in a terminal.
 * @param {any} term xterm
 * @param {HTMLElement} body the terminal's element, whose tooltip names the link
 * @param {LinkKind} kind
 */
export function registerLinks(term, body, kind) {
  term.registerLinkProvider({
    /**
     * xterm asks for the links on a row (1-based); a kind may need a moment to say which are real.
     * @param {number} y
     * @param {(links: object[] | undefined) => void} callback
     */
    provideLinks(y, callback) {
      if (!kind.active()) return callback(undefined);
      const { text, at } = logicalLine(term, y);
      Promise.resolve(kind.find(text)).then(found => {
        const links = found
          .map(f => ({ range: { start: at(f.start), end: at(f.end - 1) }, text: f.text, title: f.title ?? kind.title(f.text) }))
          .filter(l => l.range.start.y <= y && l.range.end.y >= y)
          .map(l => makeLink(l, kind, body, term));
        callback(links.length ? links : undefined);
      }, () => callback(undefined));
    },
  });
}
