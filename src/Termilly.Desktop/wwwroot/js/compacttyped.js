// @ts-check
// The keys typed into an agent's terminal since its last Enter, for the compact view (js/compact.js): what they spell
// is the prompt waiting in the agent's input line, exactly, where the screen can't tell a line break from a wrap. Only
// as long as nothing was typed that moves or edits elsewhere (an arrow, Esc, Tab): then it's unknown, until the next
// Enter.

/** Enter, as a terminal sends it. */
const ENTER = '\r';
/** A new line in the input: Alt+Enter, Ctrl+J. */
const NEW_LINES = Object.freeze(['\x1b\r', '\n']);
/** Backspace, as terminals send it. */
const BACKSPACES = Object.freeze(['\x7f', '\b']);
/** Bracketed paste around what's pasted, and the line ends in it. */
const PASTE = /^\x1b\[200~([\s\S]*)\x1b\[201~$/;
const LINE_ENDS = /\r\n?/g;
/** A key that types itself: no control character in it. */
const PRINTABLE = /^[^\x00-\x1f\x7f]+$/;
/** Whitespace, which the screen shows differently (wraps, row ends). */
const SPACES = /\s+/g;

/**
 * @typedef {{ draft: string | null, enteredAt: number, dispose: () => void }} TypedKeys
 *   draft: what the keys since the last Enter spell, or null once a key made it unknown; enteredAt: when Enter was
 *   last typed (ms since the epoch), 0 if never
 */

/**
 * Follows the keys typed into a terminal.
 * @param {any} term xterm's Terminal
 * @param {() => number} now the clock
 * @param {(data: string) => boolean} isReply whether data from xterm is its answer to the console (focus, cursor
 *   position), which isn't typing
 * @returns {TypedKeys}
 */
export function followKeys(term, now, isReply) {
  /** @type {TypedKeys} */
  const keys = { draft: '', enteredAt: 0, dispose: () => listener.dispose() };
  const listener = term.onData((/** @type {string} */ data) => {
    if (isReply(data)) return;
    if (data === ENTER) {
      keys.draft = '';
      keys.enteredAt = now();
    } else if (keys.draft !== null) keys.draft = typed(keys.draft, data);
  });
  return keys;
}

/**
 * The draft after one key (or one paste), or null when the key makes it unknown.
 * @param {string} draft
 * @param {string} data
 */
function typed(draft, data) {
  const paste = PASTE.exec(data);
  if (paste) return draft + paste[1].replace(LINE_ENDS, '\n');
  if (NEW_LINES.includes(data)) return `${draft}\n`;
  if (BACKSPACES.includes(data)) return [...draft].slice(0, -1).join(''); // a whole character, an emoji too
  return PRINTABLE.test(data) ? draft + data : null;
}

/**
 * The keys' draft when it's what the screen shows (but for how a run of whitespace shows), so the exact text; else
 * the screen's.
 * @param {TypedKeys | undefined} keys
 * @param {string} screen the text read off the screen
 */
export function exactText(keys, screen) {
  const draft = keys?.draft;
  return draft && spaced(draft) === spaced(screen) ? draft : screen;
}

/**
 * A text with each run of whitespace as one space, and none at its end (the screen shows no spaces there).
 * @param {string} text
 */
const spaced = text => text.replace(SPACES, ' ').trimEnd();

/**
 * Forgets the draft: the input line was cleared by other means than keys (the compact view moved it to its box).
 * @param {TypedKeys | undefined} keys
 */
export function forgetDraft(keys) {
  if (keys) keys.draft = '';
}
