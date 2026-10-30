// @ts-check
// The phone's terminal view (design A): one terminal live, drawn by xterm.js to fill the phone's screen (the PC's
// wide lines wrap; pinching sizes the font, and the keyboard coming up shortens it), first with what it printed lately
// and then as it prints (PhoneLive). With Settings › Phone › Allow typing on, the phone's keyboard types into it, and a
// key bar adds what a phone lacks: Esc, Tab, Ctrl, the arrows and Paste. A terminal running Claude Code opens on its
// conversation instead (chat.js), which reads better than the PC's screen squeezed onto a phone.

import { chatView } from './chat.js';
import { SCREEN, terminalTouch } from './gestures.js';

/** What the key bar sends (data-key), as a terminal reads it. */
const KEYS = Object.freeze({
  esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', enter: '\r',
});
/** The key bar's buttons, in order: what each sends and shows. Ctrl and Paste are handled apart. */
const BAR = [['esc', 'esc'], ['tab', 'tab'], ['ctrl', 'ctrl'], ['up', '↑'], ['down', '↓'], ['left', '←'], ['right', '→'], ['enter', '⏎'], ['paste', 'paste']];
const CTRL = 'ctrl';
const PASTE = 'paste';
/** Ctrl with a letter: its code is the letter's minus 64 (Ctrl+C is 3). */
const CTRL_OFFSET = 64;
/** The font size before anything is pinched, and where the phone keeps the size pinched to. */
const READABLE = 13;
const SIZE_KEY = 'termilly.terminal.size';
/** The terminal's box, and its padding (both sides together, px). */
const BOX = '.tv-box';
const BOX_PADDING = Object.freeze({ width: 16, height: 12 });
/** The smallest grid the terminal is given, however little room the keyboard leaves. */
const LEAST = Object.freeze({ cols: 20, rows: 4 });
/** What the view asks of the live connection, and its header's buttons (data-tv). */
const OP = Object.freeze({ watch: 'watch', unwatch: 'unwatch', input: 'input' });
const TV = Object.freeze({ back: 'back', answer: 'answer', mode: 'mode' });
/** What the view shows: a Claude terminal's conversation, or the terminal itself. */
const MODE = Object.freeze({ chat: 'chat', terminal: 'terminal' });
const MODE_LABEL = Object.freeze({ chat: 'Chat', terminal: 'Terminal' });
/**
 * What xterm.js answers on its own (to the programs' queries in the output it draws: who are you, where's the cursor,
 * what colours) and reports (focus, the mouse). The PC's terminal answers those already; from the phone they'd only
 * reach the shell as junk, so only typing goes through.
 */
const AUTOMATIC = /^\x1b(?:\[\??[\d;]*[cnRIO]|\[[<M]|\][\s\S]*(?:\x07|\x1b\\)$|P[\s\S]*\x1b\\$)/;
/** Lines kept above the screen. */
const SCROLLBACK = 3000;
/** On the page while the view is open: the home underneath doesn't scroll. */
const OPEN = 'tv-open';
/** The grid before the box is measured. */
const DEFAULT_SIZE = Object.freeze({ cols: 80, rows: 24 });
/** Messages from the PC about the terminal watched (PhoneLive.Kinds). */
const LIVE = Object.freeze({ screen: 'screen', output: 'output', chat: 'chat' });
const DARK = { background: '#0a0a0c', foreground: '#d7d7de', cursor: '#d7d7de', selectionBackground: '#3a3a55' };
const TYPING_OFF = '<p class="tv-foot tv-note">Typing from the phone is off: Settings › Phone › Allow typing, on the PC.</p>';

/** @typedef {{ id: string, title: string, ws: string, icon: string, badge: string, waiting: unknown, production: boolean, session: string | null }} Shown */

/** @param {unknown} text */
const esc = text => String(text ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/**
 * The terminal view, over the home screen while it's open.
 * @param {{ send: (message: object) => void, toast: (text: string) => void, answer: (id: string) => void, wsName: (id: string) => string }} app
 */
export function terminalView(app) {
  const view = document.createElement('div');
  view.className = 'tv';
  view.hidden = true;
  document.body.append(view);
  /** @type {any} */
  let term = null;
  /** @type {Shown | null} */
  let shown = null;
  let typing = false;
  let ctrl = false;
  /** Whether typing into this production terminal was confirmed already. */
  let confirmed = false;
  /** The size pinched to. */
  let fontSize = Number(localStorage.getItem(SIZE_KEY)) || READABLE;
  /** @type {string} */
  let mode = MODE.terminal;

  /** Gives the terminal as many columns and rows as fit its box at its font size; what it printed wraps to them. */
  function fitGrid() {
    const box = /** @type {HTMLElement | null} */ (view.querySelector(BOX));
    const screen = /** @type {HTMLElement | null} */ (term?.element?.querySelector(SCREEN));
    if (!term || !box || box.hidden || !screen?.offsetWidth) return;
    const cell = { width: screen.offsetWidth / term.cols, height: screen.offsetHeight / term.rows };
    const cols = Math.max(LEAST.cols, Math.floor((box.clientWidth - BOX_PADDING.width) / cell.width));
    const rows = Math.max(LEAST.rows, Math.floor((box.clientHeight - BOX_PADDING.height) / cell.height));
    if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
    term.scrollToBottom();
  }

  /**
   * Types into the terminal; false when it didn't (typing is off, or typing into production wasn't confirmed).
   * @param {string} data
   */
  function type(data) {
    if (!shown || !typing) return false;
    if (shown.production && !confirmed) {
      if (!window.confirm(`${shown.title} is tagged prod. Type into it from this phone?`)) return false;
      confirmed = true;
    }
    if (ctrl && data.length === 1 && /[a-z@[\\\]^_]/i.test(data)) {
      data = String.fromCharCode(data.toUpperCase().charCodeAt(0) - CTRL_OFFSET);
      setCtrl(false);
    }
    app.send({ op: OP.input, pane: shown.id, data });
    return true;
  }
  const chat = chatView({ type });

  /** @param {boolean} on */
  function setCtrl(on) {
    ctrl = on;
    view.querySelector(`[data-key="${CTRL}"]`)?.classList.toggle('on', on);
  }

  function head() {
    if (!shown) return '';
    const modes = shown.session
      ? `<nav class="tv-modes">${Object.values(MODE).map(m => `<button data-tv="${TV.mode}" data-mode="${m}"${m === mode ? ' class="on"' : ''}>${/** @type {Record<string, string>} */ (MODE_LABEL)[m]}</button>`).join('')}</nav>`
      : '';
    return `<header class="tv-head"><button class="tv-back" data-tv="${TV.back}" aria-label="Back">‹</button>
      <span class="badge${shown.icon === 'claude' ? ' claude' : ''}" data-icon="${esc(shown.icon)}">${shown.icon === 'claude' ? '✻' : esc(shown.badge)}</span>
      <span class="tv-title">${esc(shown.title)}<span class="tv-ws"> · ${esc(app.wsName(shown.ws))}</span></span>
      ${shown.waiting ? `<button class="btn primary tv-answer" data-tv="${TV.answer}">Answer</button>` : ''}</header>${modes}`;
  }

  /**
   * Draws what's around the terminal and the chat (the header, the tabs, and the key bar, the box to message Claude or
   * why typing is off), keeping both as they are, and shows the one picked.
   */
  function frame() {
    const box = /** @type {HTMLElement} */ (view.querySelector(BOX));
    view.querySelectorAll('.tv-head, .tv-modes, .tv-foot').forEach(el => el.remove());
    view.insertAdjacentHTML('afterbegin', head());
    const chatting = mode === MODE.chat;
    box.hidden = chatting;
    chat.list.hidden = !chatting;
    const foot = chatting ? chat.compose(typing)
      : typing ? `<div class="tv-foot keybar">${BAR.map(([key, label]) => `<button data-key="${key}">${label}</button>`).join('')}</div>`
      : TYPING_OFF;
    chat.list.insertAdjacentHTML('afterend', foot);
    if (!chatting) requestAnimationFrame(fitGrid);
  }

  /**
   * Opens a terminal: the PC sends what it printed lately, then what it prints (and a Claude terminal's conversation).
   * @param {Shown} t
   * @param {boolean} canType
   */
  function open(t, canType) {
    close();
    shown = t;
    typing = canType;
    confirmed = false;
    mode = t.session ? MODE.chat : MODE.terminal;
    view.hidden = false;
    document.body.classList.add(OPEN);
    view.innerHTML = '<div class="tv-box"></div>';
    view.append(chat.list);
    chat.add([], true);
    term = new Terminal({ cols: DEFAULT_SIZE.cols, rows: DEFAULT_SIZE.rows, fontSize, scrollback: SCROLLBACK,
      fontFamily: 'ui-monospace, Menlo, Consolas, monospace', theme: DARK, disableStdin: !canType, convertEol: false, cursorBlink: false });
    const box = /** @type {HTMLElement} */ (view.querySelector(BOX));
    term.open(box);
    frame();
    touch(box);
    term.onData(/** @param {string} data */ data => { if (!AUTOMATIC.test(data)) type(data); });
    app.send({ op: OP.watch, pane: t.id });
    fitViewport();
  }

  /**
   * One finger scrolls back, two pinch the font (the grid follows; the size is remembered), and a tap brings up the
   * keyboard when typing is allowed.
   * @param {HTMLElement} box
   */
  function touch(box) {
    terminalTouch(box, {
      term: () => term,
      size: () => fontSize,
      resize: size => {
        if (!term || size === fontSize) return;
        fontSize = size;
        term.options.fontSize = size;
        requestAnimationFrame(fitGrid);
      },
      sized: () => localStorage.setItem(SIZE_KEY, String(fontSize)),
      tap: () => { if (typing) term?.focus(); },
    });
  }

  function close() {
    if (shown) app.send({ op: OP.unwatch });
    term?.dispose();
    term = null;
    shown = null;
    setCtrl(false);
    view.hidden = true;
    document.body.classList.remove(OPEN);
    view.innerHTML = '';
  }

  /**
   * The PC's news about the terminal shown: gone, waiting or not, typing allowed or not, a Claude session or not.
   * @param {Shown | undefined} t
   * @param {boolean} canType
   */
  function update(t, canType) {
    if (!shown) return;
    if (!t) {
      close();
      app.toast('That terminal was closed on the PC.');
      return;
    }
    const changed = !!t.waiting !== !!shown.waiting || canType !== typing || !!t.session !== !!shown.session;
    shown = t;
    if (!t.session) mode = MODE.terminal;
    if (changed) {
      typing = canType;
      if (term) term.options.disableStdin = !canType;
      frame();
    }
  }

  /** @param {{ type: string, pane: string, data: string, entries: { role: string, text: string }[], reset: boolean }} m */
  function message(m) {
    if (!term || m.pane !== shown?.id) return;
    if (m.type === LIVE.chat) {
      chat.add(m.entries, m.reset);
    } else if (m.type === LIVE.screen) {
      term.reset();
      term.write(m.data);
    } else if (m.type === LIVE.output) {
      term.write(m.data);
    }
  }

  /** The view fills what the keyboard leaves of the screen, so the key bar sits right above it. */
  function fitViewport() {
    if (view.hidden || !window.visualViewport) return;
    view.style.height = `${window.visualViewport.height}px`;
    pin();
    fitGrid();
  }
  /** Keeps the view on what the phone shows: iOS moves the page under the keyboard, which would carry the header away. */
  function pin() {
    if (!view.hidden && window.visualViewport) view.style.transform = `translateY(${window.visualViewport.offsetTop}px)`;
  }
  window.visualViewport?.addEventListener('resize', fitViewport);
  window.visualViewport?.addEventListener('scroll', pin);

  view.addEventListener('click', async e => {
    const target = /** @type {HTMLElement} */ (e.target);
    const key = target.closest('[data-key]')?.getAttribute('data-key');
    const action = target.closest('[data-tv]')?.getAttribute('data-tv');
    if (action === TV.back) close();
    else if (action === TV.answer && shown) app.answer(shown.id);
    else if (action === TV.mode) {
      mode = target.closest('[data-mode]')?.getAttribute('data-mode') ?? mode;
      frame();
    } else if (key === CTRL) setCtrl(!ctrl);
    else if (key === PASTE) {
      try {
        const text = await navigator.clipboard.readText();
        if (text) type(text);
      } catch {
        app.toast('The phone didn\'t allow pasting.');
      }
    } else if (key) type(/** @type {Record<string, string>} */ (KEYS)[key]);
    if (key) term?.focus();
  });
  view.addEventListener('submit', e => {
    e.preventDefault();
    chat.submit(/** @type {HTMLFormElement} */ (e.target));
  });
  // Enter in the box sends; Shift+Enter (a hardware keyboard) starts a new line.
  view.addEventListener('keydown', e => {
    const box = /** @type {HTMLElement} */ (e.target);
    if (e.key !== 'Enter' || e.shiftKey || !box.matches('.chat-compose textarea')) return;
    e.preventDefault();
    chat.submit(/** @type {HTMLFormElement} */ (box.closest('form')));
  });

  /** Back after the connection dropped: the terminal shown starts over with what it printed lately. */
  const rewatch = () => { if (shown) app.send({ op: OP.watch, pane: shown.id }); };

  return {
    open, close, update, message, rewatch,
    /** The terminal shown, or null. */
    get viewing() { return shown?.id ?? null; },
  };
}
