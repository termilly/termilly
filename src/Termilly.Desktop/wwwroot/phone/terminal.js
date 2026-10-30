// @ts-check
// The phone's terminal view (design A): one terminal live, drawn by xterm.js at the PC's size (fitted to the phone's
// width), first with what it printed lately and then as it prints (PhoneLive). With Settings › Phone › Allow typing on,
// the phone's keyboard types into it, and a key bar adds what a phone lacks: Esc, Tab, Ctrl, the arrows and Paste.

/* global Terminal */

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
/** The font sizes the view fits the PC's width with, and how wide a monospace character is per point. */
const FONT = Object.freeze({ min: 6, max: 14, charWidth: 0.6 });
/** Lines kept above the screen. */
const SCROLLBACK = 3000;
/** The PC's size when it hasn't said yet. */
const DEFAULT_SIZE = Object.freeze({ cols: 80, rows: 24 });
/** Messages from the PC about the terminal watched (PhoneLive.Kinds). */
const LIVE = Object.freeze({ screen: 'screen', output: 'output' });
const DARK = { background: '#0a0a0c', foreground: '#d7d7de', cursor: '#d7d7de', selectionBackground: '#3a3a55' };

/** @typedef {{ id: string, title: string, ws: string, icon: string, badge: string, waiting: unknown, production: boolean, cols: number | null, rows: number | null }} Terminal */

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
  /** @type {Terminal | null} */
  let shown = null;
  let typing = false;
  let ctrl = false;
  /** Whether typing into this production terminal was confirmed already. */
  let confirmed = false;

  /** @param {Terminal} t */
  const fontFor = t => {
    const width = Math.max(view.clientWidth - 16, 200);
    return Math.max(FONT.min, Math.min(FONT.max, Math.floor((width / ((t.cols ?? DEFAULT_SIZE.cols) * FONT.charWidth)) * 10) / 10));
  };

  /** @param {string} data */
  function type(data) {
    if (!shown || !typing) return;
    if (shown.production && !confirmed) {
      if (!window.confirm(`${shown.title} is tagged prod. Type into it from this phone?`)) return;
      confirmed = true;
    }
    if (ctrl && data.length === 1 && /[a-z@[\\\]^_]/i.test(data)) {
      data = String.fromCharCode(data.toUpperCase().charCodeAt(0) - CTRL_OFFSET);
      setCtrl(false);
    }
    app.send({ op: 'input', pane: shown.id, data });
  }

  /** @param {boolean} on */
  function setCtrl(on) {
    ctrl = on;
    view.querySelector(`[data-key="${CTRL}"]`)?.classList.toggle('on', on);
  }

  function head() {
    if (!shown) return '';
    return `<header class="tv-head"><button class="tv-back" data-tv="back" aria-label="Back">‹</button>
      <span class="badge${shown.icon === 'claude' ? ' claude' : ''}" data-icon="${esc(shown.icon)}">${shown.icon === 'claude' ? '✻' : esc(shown.badge)}</span>
      <span class="tv-title">${esc(shown.title)}<span class="tv-ws"> · ${esc(app.wsName(shown.ws))}</span></span>
      ${shown.waiting ? '<button class="btn primary tv-answer" data-tv="answer">Answer</button>' : ''}</header>`;
  }

  /** Draws the parts around the terminal (its header, the key bar or why typing is off), keeping xterm as it is. */
  function frame() {
    const box = view.querySelector('.tv-box');
    const headEl = view.querySelector('.tv-head');
    if (headEl) headEl.outerHTML = head();
    else view.insertAdjacentHTML('afterbegin', head());
    view.querySelector('.tv-foot')?.remove();
    box?.insertAdjacentHTML('afterend', typing
      ? `<div class="tv-foot keybar">${BAR.map(([key, label]) => `<button data-key="${key}">${label}</button>`).join('')}</div>`
      : '<p class="tv-foot tv-note">Typing from the phone is off: Settings › Phone › Allow typing, on the PC.</p>');
  }

  /**
   * Opens a terminal: the PC sends what it printed lately, then what it prints.
   * @param {Terminal} t
   * @param {boolean} canType
   */
  function open(t, canType) {
    close();
    shown = t;
    typing = canType;
    confirmed = false;
    view.hidden = false;
    view.innerHTML = '<div class="tv-box"></div>';
    frame();
    term = new Terminal({ cols: t.cols ?? DEFAULT_SIZE.cols, rows: t.rows ?? DEFAULT_SIZE.rows, fontSize: fontFor(t), scrollback: SCROLLBACK,
      fontFamily: 'ui-monospace, Menlo, Consolas, monospace', theme: DARK, disableStdin: !canType, convertEol: false, cursorBlink: false });
    term.open(view.querySelector('.tv-box'));
    term.onData(type);
    app.send({ op: 'watch', pane: t.id });
    fitViewport();
  }

  function close() {
    if (shown) app.send({ op: 'unwatch' });
    term?.dispose();
    term = null;
    shown = null;
    setCtrl(false);
    view.hidden = true;
    view.innerHTML = '';
  }

  /**
   * The PC's news about the terminal shown: gone, resized, waiting or not, typing allowed or not.
   * @param {Terminal | undefined} t
   * @param {boolean} canType
   */
  function update(t, canType) {
    if (!shown) return;
    if (!t) {
      close();
      app.toast('That terminal was closed on the PC.');
      return;
    }
    const resized = t.cols !== shown.cols || t.rows !== shown.rows;
    const changed = !!t.waiting !== !!shown.waiting || canType !== typing;
    shown = t;
    if (resized && term) {
      term.resize(t.cols ?? DEFAULT_SIZE.cols, t.rows ?? DEFAULT_SIZE.rows);
      term.options.fontSize = fontFor(t);
    }
    if (changed) {
      typing = canType;
      if (term) term.options.disableStdin = !canType;
      frame();
    }
  }

  /** @param {{ type: string, pane: string, data: string }} m */
  function message(m) {
    if (!term || m.pane !== shown?.id) return;
    if (m.type === LIVE.screen) {
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
    term?.scrollToBottom();
  }
  window.visualViewport?.addEventListener('resize', fitViewport);

  view.addEventListener('click', async e => {
    const target = /** @type {HTMLElement} */ (e.target);
    const key = target.closest('[data-key]')?.getAttribute('data-key');
    const action = target.closest('[data-tv]')?.getAttribute('data-tv');
    if (action === 'back') close();
    else if (action === 'answer' && shown) app.answer(shown.id);
    else if (key === CTRL) setCtrl(!ctrl);
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
  // Tapping the terminal brings up the keyboard when typing is allowed.
  view.addEventListener('touchend', e => {
    if (typing && /** @type {HTMLElement} */ (e.target).closest('.tv-box')) term?.focus();
  });

  return {
    open, close, update, message,
    /** The terminal shown, or null. */
    get viewing() { return shown?.id ?? null; },
  };
}
