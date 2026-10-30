// @ts-check
// The phone's terminal view (design A): one terminal live, drawn by xterm.js at the PC's size (readable text that
// scrolls sideways, or Fit to see the whole width), first with what it printed lately and then as it prints
// (PhoneLive). With Settings › Phone › Allow typing on,
// the phone's keyboard types into it, and a key bar adds what a phone lacks: Esc, Tab, Ctrl, the arrows and Paste.

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
/**
 * The font sizes: readable (the box scrolls sideways when the PC's terminal is wider than the phone), and the range Fit
 * picks from to show the whole width; how wide a monospace character is per point until xterm has drawn one.
 */
const FONT = Object.freeze({ readable: 13, min: 3, max: 14, charWidth: 0.6, tenths: 10, tries: 6 });
/** The sizes pinching goes between, in half points. */
const PINCH = Object.freeze({ min: 6, max: 28, step: 2 });
/** Where the phone keeps whether Fit is on, and the size pinched to. */
const FIT_KEY = 'termilly.terminal.fit';
const SIZE_KEY = 'termilly.terminal.size';
/** A finger lifted, which ends a tap or a pinch. */
const TOUCH_END = 'touchend';
/** The terminal's box: its element, its side padding together, and the narrowest width it's fitted to. */
const BOX = '.tv-box';
const BOX_SPACE = Object.freeze({ padding: 16, least: 200 });
/** What the view asks of the live connection, and its header's buttons (data-tv). */
const OP = Object.freeze({ watch: 'watch', unwatch: 'unwatch', input: 'input' });
const TV = Object.freeze({ back: 'back', answer: 'answer', fit: 'fit' });
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
/** The PC's size when it hasn't said yet. */
const DEFAULT_SIZE = Object.freeze({ cols: 80, rows: 24 });
/** Messages from the PC about the terminal watched (PhoneLive.Kinds). */
const LIVE = Object.freeze({ screen: 'screen', output: 'output' });
const DARK = { background: '#0a0a0c', foreground: '#d7d7de', cursor: '#d7d7de', selectionBackground: '#3a3a55' };

/** @typedef {{ id: string, title: string, ws: string, icon: string, badge: string, waiting: unknown, production: boolean, cols: number | null, rows: number | null }} Shown */

/** @param {unknown} text */
const esc = text => String(text ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/** @param {TouchList} touches */
const spread = touches => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);

/**
 * Two fingers on the element pinch a size (in half points, between PINCH's) instead of zooming the page.
 * @param {HTMLElement} element
 * @param {() => number} current
 * @param {(size: number) => void} change
 * @param {() => void} done
 */
function pinchOn(element, current, change, done) {
  /** @type {{ distance: number, size: number } | null} */
  let start = null;
  element.addEventListener('touchstart', e => {
    if (e.touches.length === 2) start = { distance: spread(e.touches), size: current() };
  }, { passive: true });
  element.addEventListener('touchmove', e => {
    if (!start || e.touches.length !== 2) return;
    e.preventDefault();
    const size = Math.round(start.size * (spread(e.touches) / start.distance) * PINCH.step) / PINCH.step;
    change(Math.max(PINCH.min, Math.min(PINCH.max, size)));
  }, { passive: false });
  element.addEventListener(TOUCH_END, e => {
    if (!start || e.touches.length === 2) return;
    start = null;
    done();
  });
  // iOS zooms the page on its own gesture events too.
  element.addEventListener('gesturestart', e => e.preventDefault());
}

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

  /** Whether the whole width is shown (small text) rather than readable text that scrolls sideways. */
  let fit = localStorage.getItem(FIT_KEY) === '1';
  /** The size without Fit: readable, or what the user pinched to. */
  let readable = Number(localStorage.getItem(SIZE_KEY)) || FONT.readable;

  /** Readable, or with Fit the size that shows all the PC's columns, measured from what xterm drew. */
  function fitFont() {
    if (!term) return;
    if (!fit) {
      term.options.fontSize = readable;
      return;
    }
    const width = Math.max(view.clientWidth - BOX_SPACE.padding, BOX_SPACE.least);
    // xterm rounds its cells to the screen's pixels, so the size is measured again until the screen fits.
    for (let tries = 0; tries < FONT.tries; tries++) {
      const drawn = /** @type {HTMLElement | null} */ (term.element?.querySelector('.xterm-screen'))?.offsetWidth;
      if (drawn && drawn <= width && tries > 0) break;
      const perPoint = drawn ? drawn / term.cols / term.options.fontSize : FONT.charWidth;
      const size = Math.floor((width / (term.cols * perPoint)) * FONT.tenths) / FONT.tenths - (tries > 0 ? 1 / FONT.tenths : 0);
      term.options.fontSize = Math.max(FONT.min, Math.min(FONT.max, size));
    }
    const box = view.querySelector(BOX);
    if (box) box.scrollLeft = 0;
  }

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
    app.send({ op: OP.input, pane: shown.id, data });
  }

  /** @param {boolean} on */
  function setCtrl(on) {
    ctrl = on;
    view.querySelector(`[data-key="${CTRL}"]`)?.classList.toggle('on', on);
  }

  function head() {
    if (!shown) return '';
    return `<header class="tv-head"><button class="tv-back" data-tv="${TV.back}" aria-label="Back">‹</button>
      <span class="badge${shown.icon === 'claude' ? ' claude' : ''}" data-icon="${esc(shown.icon)}">${shown.icon === 'claude' ? '✻' : esc(shown.badge)}</span>
      <span class="tv-title">${esc(shown.title)}<span class="tv-ws"> · ${esc(app.wsName(shown.ws))}</span></span>
      <button class="btn tv-fit${fit ? ' on' : ''}" data-tv="${TV.fit}" aria-pressed="${fit}">Fit</button>
      ${shown.waiting ? `<button class="btn primary tv-answer" data-tv="${TV.answer}">Answer</button>` : ''}</header>`;
  }

  /** Draws the parts around the terminal (its header, the key bar or why typing is off), keeping xterm as it is. */
  function frame() {
    const box = view.querySelector(BOX);
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
   * @param {Shown} t
   * @param {boolean} canType
   */
  function open(t, canType) {
    close();
    shown = t;
    typing = canType;
    confirmed = false;
    view.hidden = false;
    document.body.classList.add(OPEN);
    view.innerHTML = '<div class="tv-box"></div>';
    frame();
    term = new Terminal({ cols: t.cols ?? DEFAULT_SIZE.cols, rows: t.rows ?? DEFAULT_SIZE.rows, fontSize: readable, scrollback: SCROLLBACK,
      fontFamily: 'ui-monospace, Menlo, Consolas, monospace', theme: DARK, disableStdin: !canType, convertEol: false, cursorBlink: false });
    term.open(view.querySelector(BOX));
    fitFont();
    term.onData(/** @param {string} data */ data => { if (!AUTOMATIC.test(data)) type(data); });
    app.send({ op: OP.watch, pane: t.id });
    fitViewport();
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
   * The PC's news about the terminal shown: gone, resized, waiting or not, typing allowed or not.
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
    const resized = t.cols !== shown.cols || t.rows !== shown.rows;
    const changed = !!t.waiting !== !!shown.waiting || canType !== typing;
    shown = t;
    if (resized && term) {
      term.resize(t.cols ?? DEFAULT_SIZE.cols, t.rows ?? DEFAULT_SIZE.rows);
      fitFont();
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
    pin();
    fitFont();
    term?.scrollToBottom();
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
    else if (action === TV.fit) {
      fit = !fit;
      localStorage.setItem(FIT_KEY, fit ? '1' : '0');
      fitFont();
      frame();
    }
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
  // Tapping the terminal brings up the keyboard when typing is allowed (not at the end of a pinch).
  let pinched = false;
  view.addEventListener(TOUCH_END, e => {
    if (pinched) pinched = e.touches.length > 0;
    else if (typing && /** @type {HTMLElement} */ (e.target).closest(BOX)) term?.focus();
  });
  // Pinching sizes the terminal's font, not the page; it leaves Fit, and the phone remembers the size.
  pinchOn(view, () => term?.options.fontSize ?? readable, size => {
    pinched = true;
    if (!term || size === term.options.fontSize) return;
    readable = size;
    term.options.fontSize = size;
    if (fit) {
      fit = false;
      localStorage.setItem(FIT_KEY, '0');
      frame();
    }
  }, () => localStorage.setItem(SIZE_KEY, String(readable)));

  /** Back after the connection dropped: the terminal shown starts over with what it printed lately. */
  const rewatch = () => { if (shown) app.send({ op: OP.watch, pane: shown.id }); };

  return {
    open, close, update, message, rewatch,
    /** The terminal shown, or null. */
    get viewing() { return shown?.id ?? null; },
  };
}
