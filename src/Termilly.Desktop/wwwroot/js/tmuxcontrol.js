// @ts-check
// tmux control mode (tmux -C), the protocol iTerm2's tmux integration speaks: tmux writes one line per event and
// wraps each command's answer in %begin … %end (or %error). Pure functions and a small parser, with no page state, so
// they can be tested on their own (tests/js/tmuxcontrol.test.mjs). js/tmux.js puts it on screen.

/**
 * A cell of a tmux window layout (parseLayout): a pane has `pane`, a split has `dir` and `children`.
 * @typedef {{ pane?: number, dir?: 'row' | 'column', w: number, h: number, x: number, y: number,
 *   children?: TmuxLayout[] }} TmuxLayout
 */

/**
 * The callback for a command's answer: its lines, and whether tmux answered %error.
 * @typedef {(lines: string[], error: boolean) => void} AnswerCallback
 */

/** The notifications tmux sends (%output, %window-add…), by name. */
export const NOTIFICATION = Object.freeze({
  output: 'output', layoutChange: 'layout-change', windowAdd: 'window-add', windowClose: 'window-close',
  unlinkedWindowClose: 'unlinked-window-close', windowRenamed: 'window-renamed', exit: 'exit',
});

/** Which way a layout's split goes, as store.js's SPLIT says it (this module doesn't import the page's modules). */
const LAYOUT_DIR = Object.freeze({ row: 'row', column: 'column' });

/** The bases of %output's octal escapes and of send-keys -H's hex bytes. */
const OCTAL = 8;
const HEX = 16;

/** Where %begin's flags are: "%begin <time> <command number> <flags>". */
const BEGIN_FLAGS_FIELD = 3;

/** How many bytes one send-keys command carries. */
const SEND_KEYS_CHUNK = 200;

/**
 * %output's data: characters below 32 and backslashes come as \ooo (octal).
 * @param {string} text
 */
export function unescapeOutput(text) {
  return text.replace(/\\([0-7]{3})/g,
    (/** @type {string} */ _, /** @type {string} */ octal) => String.fromCharCode(parseInt(octal, OCTAL)));
}

/**
 * A window layout (#{window_layout}, "a87d,212x50,0,0{106x50,0,0,1,105x50,107,0,2}") as a tree: a pane is
 * { pane: 1, w, h, x, y }; a split is { dir: 'row' | 'column', w, h, x, y, children }. {…} lays its children
 * side by side (a row), […] one above another (a column).
 * @param {unknown} layout
 */
export function parseLayout(layout) {
  let s = String(layout);
  const comma = s.indexOf(',');
  if (/^[0-9a-f]{4}$/.test(s.slice(0, comma))) s = s.slice(comma + 1); // the checksum
  let i = 0;
  const number = () => {
    const start = i;
    while (i < s.length && /[0-9]/.test(s[i])) i++;
    return Number(s.slice(start, i));
  };
  /** @returns {TmuxLayout} */
  const cell = () => {
    const w = number(); i++; // x
    const h = number(); i++; // ,
    const x = number(); i++; // ,
    const y = number();
    if (s[i] === ',') {
      i++;
      return { pane: number(), w, h, x, y };
    }
    const open = s[i];
    const close = open === '{' ? '}' : ']';
    i++;
    const children = [];
    while (i < s.length && s[i] !== close) {
      children.push(cell());
      if (s[i] === ',') i++;
    }
    i++;
    return { dir: open === '{' ? LAYOUT_DIR.row : LAYOUT_DIR.column, w, h, x, y, children };
  }
  return cell();
}

/**
 * The pane ids in a layout, in order.
 * @param {TmuxLayout} node
 * @returns {number[]}
 */
export const panesOf = node => (node.children ? node.children.flatMap(panesOf) : [/** @type {number} */ (node.pane)]);

/**
 * Feeds a tmux client's output in and calls back per line: `onNotification(name, args, line)` for %output,
 * %window-add and the like, and the pending command's callback with its answer lines when its %end (or %error)
 * comes. Commands are answered in the order they were sent.
 */
export class ControlParser {
  /** @param {{ onNotification: (name: string, args: string[], line: string) => void }} options */
  constructor({ onNotification }) {
    this.onNotification = onNotification;
    this.partial = '';
    /** @type {{ lines: string[], flags: string } | null} */
    this.block = null;
    /** @type {AnswerCallback[]} */
    this.pending = [];
  }

  /**
   * A command was sent: its answer goes to `callback(lines, error)`.
   * @param {AnswerCallback} callback
   */
  expect(callback) {
    this.pending.push(callback);
  }

  /** @param {string} text */
  feed(text) {
    const lines = (this.partial + text).split('\n');
    this.partial = /** @type {string} */ (lines.pop());
    for (const raw of lines) this.line(raw.replace(/\r$/, ''));
  }

  /** @param {string} line */
  line(line) {
    if (this.block) {
      if (/^%(end|error) /.test(line)) {
        const done = this.block;
        this.block = null;
        // tmux answers its own startup command (the one on its command line) first: flag 0, nobody waits for it.
        if (done.flags === '0') return;
        const callback = this.pending.shift();
        callback?.(done.lines, line.startsWith('%error'));
      } else {
        this.block.lines.push(line);
      }
      return;
    }
    if (line.startsWith('%begin ')) {
      this.block = { lines: [], flags: line.split(' ')[BEGIN_FLAGS_FIELD] ?? '1' };
      return;
    }
    if (!line.startsWith('%')) return; // anything before control mode starts (a shell, ssh's banner)
    const space = line.indexOf(' ');
    const name = space < 0 ? line.slice(1) : line.slice(1, space);
    const rest = space < 0 ? '' : line.slice(space + 1);
    if (name === NOTIFICATION.output) {
      const at = rest.indexOf(' ');
      this.onNotification(NOTIFICATION.output, [rest.slice(0, at), unescapeOutput(rest.slice(at + 1))], line);
    } else {
      this.onNotification(name, rest ? rest.split(' ') : [], line);
    }
  }
}

/**
 * send-keys for text typed in a pane: its UTF-8 bytes as hex (-H), so any key, Enter and escapes included, gets there.
 * @param {string} pane
 * @param {string} text
 * @param {number} [chunk]
 */
export function sendKeysCommands(pane, text, chunk = SEND_KEYS_CHUNK) {
  const bytes = [...new TextEncoder().encode(text)].map(b => b.toString(HEX).padStart(2, '0'));
  const commands = [];
  for (let i = 0; i < bytes.length; i += chunk) commands.push(`send-keys -t ${pane} -H ${bytes.slice(i, i + chunk).join(' ')}`);
  return commands;
}
