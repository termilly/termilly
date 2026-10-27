// @ts-check
// Links in a terminal's text that Termilly finds itself (the files Claude changed, web addresses): read one logical
// line at a time, so a link that wraps onto the next row is one link; underlined under the mouse while Ctrl is held
// and opened with Ctrl+click, or underlined and opened with a plain click where the kind of link says so.

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

/** The text of the link under the mouse (a web address or a path), for the right-click menu; null when none. */
export const linkUnderMouse = () => hovered?.link.text ?? null;

/** @param {LinkKind} kind */
const decorations = kind => {
  const on = !!kind.plainClick?.() || ctrlHeld;
  return { underline: on, pointerCursor: on };
};

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

/**
 * The whole logical line row y (1-based) is part of, and where a character offset in it is on screen (1-based).
 * @param {any} term xterm
 * @param {number} y
 */
function logicalLine(term, y) {
  const buffer = term.buffer.active;
  const cols = term.cols;
  let first = y - 1;
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
  let last = y - 1;
  while (buffer.getLine(last + 1)?.isWrapped) last++;
  let text = '';
  for (let row = first; row <= last; row++) {
    const line = buffer.getLine(row);
    text += line ? line.translateToString(row !== last).padEnd(row !== last ? cols : 0) : '';
  }
  return { text, at: (/** @type {number} */ offset) => ({ x: (offset % cols) + 1, y: first + Math.floor(offset / cols) + 1 }) };
}

/**
 * One link xterm can show: underlined and opened as its kind says, its tooltip on the terminal while hovered.
 * @param {{ range: object, text: string, title: string }} found where it is on screen, its text and tooltip
 * @param {LinkKind} kind
 * @param {HTMLElement} body
 */
function makeLink({ range, text, title }, kind, body) {
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
      body.title = title;
    },
    leave() {
      if (hovered?.link === link) hovered = null;
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
          .map(l => makeLink(l, kind, body));
        callback(links.length ? links : undefined);
      }, () => callback(undefined));
    },
  });
}
