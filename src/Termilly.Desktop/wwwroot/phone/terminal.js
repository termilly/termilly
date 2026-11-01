// @ts-check
// The phone's terminal view (design A): one terminal live, filling the phone's screen. While the phone shows it, the
// terminal takes the phone's size on the PC too (PhoneLive), so what it prints fits the phone; pinching sizes the
// font, and the size follows. The keyboard doesn't: the terminal keeps the rows of the whole screen (resizing would
// push the text up, here and on the PC), and while the keyboard is up the view slides up to keep the cursor's line
// above it. First what it shows (the window's own terminal, drawn again at that size), then what it prints.
// With Settings › Phone › Allow typing on, the phone's keyboard types into it, and a key bar adds what a phone lacks:
// Esc, Tab, Ctrl, the arrows, Paste and the PC's snippets. A terminal running Claude Code also gets a box to message
// it: a plain text field, so the phone's keyboard can dictate into it, and what's said is checked before it goes.

import { SCREEN, terminalTouch } from './gestures.js';
import { snippetSheet, asTyped } from './snippets.js';
import { clipSheet } from './clips.js';
import { composer, COMPOSE, CLEAR_INPUT } from './compose.js';

/** What the key bar sends (data-key), as a terminal reads it. */
const KEYS = Object.freeze({
  esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', bksp: '\x7f', enter: '\r',
});
/** Ctrl+Backspace, as the PC's terminal sends it: a word back in Claude Code and PowerShell (one character in bash). */
const CTRL_BACKSPACE = '\x08';
/** Backspace held down repeats: after this long, this often. */
const REPEAT = Object.freeze({ after: 450, every: 70 });
const BACKSPACE = 'bksp';
/** The key bar's buttons, in order: what each sends and shows. Ctrl and Paste are handled apart. */
const BAR = [['esc', 'esc'], ['tab', 'tab'], ['ctrl', 'ctrl'], ['up', '↑'], ['down', '↓'], ['left', '←'], ['right', '→'], ['bksp', '⌫'], ['enter', '⏎'], ['paste', 'paste'], ['clips', 'clips'], ['snip', 'snip']];
const CTRL = 'ctrl';
const PASTE = 'paste';
const SNIP = 'snip';
/** Smart Clip's sheet: the PC's text clips to paste (clips.js). */
const CLIPS = 'clips';
/** The same from Claude's +: the clip's text goes to the message box. */
const CLIPS_BOX = 'clips-box';
/** A message to Claude goes in, then Enter after this (as the PC's own send does, api.js); one with lines is pasted. */
const ENTER_AFTER_MS = 200;
const PASTED = Object.freeze({ start: '\x1b[200~', end: '\x1b[201~' });
/** Ctrl with a letter: its code is the letter's minus 64 (Ctrl+C is 3). */
const CTRL_OFFSET = 64;
/** The font size before anything is pinched, and where the phone keeps the size pinched to (or set in Settings). */
export const TEXT_SIZE = Object.freeze({ readable: 13, key: 'termilly.terminal.size' });
const READABLE = TEXT_SIZE.readable;
const SIZE_KEY = TEXT_SIZE.key;
/** The terminal's box, and its padding (both sides together, px). */
const BOX = '.tv-box';
const BOX_PADDING = Object.freeze({ width: 16, height: 12 });
/** The smallest size asked for, however little room the keyboard leaves. */
const LEAST = Object.freeze({ cols: 20, rows: 4 });
/** The size goes to the PC once it has settled this long (pinching changes it many times a second). */
const SIZE_AFTER_MS = 150;
/** What the view asks of the live connection, and its header's buttons (data-tv). */
const OP = Object.freeze({ watch: 'watch', unwatch: 'unwatch', input: 'input', size: 'size', clip: 'clip', clipText: 'clipText' });
const TV = Object.freeze({ back: 'back', answer: 'answer', stop: 'stop' });
/** Claude Code's (and Codex's) interrupt, as the PC's stop button sends it (js/agentline.js stopAgent). */
const STOP = '\x1b';
/** Then the box cleared (compose.js CLEAR_INPUT): stopped before it answers, Claude Code puts the message back in it,
 * which takes it this long. */
const CLEAR_AFTER_MS = 800;
/** The agent states the stop button shows in (js/agentline.js isAgentWorking). */
const STOPPABLE = ['working', 'needs-input'];
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
/** On the view while the phone's keyboard is up: the screen is shorter than the page by more than this (px). */
const KEYBOARD = 'keyboard';
const KEYBOARD_LEAST = 120;
/** When to fit again after the focus moves (ms): iOS's keyboard takes about a third of a second to come or go. */
const SETTLE_MS = [50, 350, 700];
/** The PC's size when it hasn't said yet. */
const DEFAULT_SIZE = Object.freeze({ cols: 80, rows: 24 });
/** Messages from the PC about the terminal watched (PhoneLive.Kinds). */
const LIVE = Object.freeze({ screen: 'screen', output: 'output' });

/** @typedef {{ id: string, title: string, ws: string, icon: string, badge: string, waiting: unknown, production: boolean, cols: number | null, rows: number | null, activity: string | null, percent: number | null, hint: string | null }} Shown */

/** The activities the PC draws next to a terminal's title (store.js ACTIVITY); others ("exited") draw nothing. */
const ACTIVITIES = new Set(['needs', 'error', 'paused', 'done', 'percent', 'spin', 'hibernated']);
const FULL = 100;

/**
 * A terminal's activity as the PC draws it (ui.js activityHtml): a spinner, a progress ring, a pulsing dot or a tick;
 * empty when idle.
 * @param {{ activity: string | null, percent: number | null, hint: string | null }} t
 */
export function activityHtml(t) {
  if (!t.activity || !ACTIVITIES.has(t.activity)) return '';
  const percent = t.percent === null || t.percent === undefined ? '' : ` style="--p:${Math.max(0, Math.min(FULL, t.percent))}"`;
  return `<span class="activity ${t.activity}"${percent} role="img" aria-label="${esc(t.hint ?? '')}"></span>`;
}

/**
 * A character cell's size (px) at the terminal's font: xterm's own measure (its screen element is resized only when it
 * next draws, so measuring that right after a change gives the old size), or that element's when it has none.
 * @param {any} term
 * @returns {{ width: number, height: number } | null}
 */
function cellOf(term) {
  const cell = term._core?._renderService?.dimensions?.css?.cell;
  if (cell?.width && cell?.height) return cell;
  const screen = /** @type {HTMLElement | null} */ (term.element?.querySelector(SCREEN));
  return screen?.offsetWidth ? { width: screen.offsetWidth / term.cols, height: screen.offsetHeight / term.rows } : null;
}

/** @param {unknown} text */
const esc = text => String(text ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/**
 * The terminal view, over the home screen while it's open.
 * @param {{ send: (message: object) => void, toast: (text: string) => void, answer: (id: string) => void, wsName: (id: string) => string,
 *   snippets: () => import('./snippets.js').PhoneSnippet[], clips: () => import('./clips.js').PhoneClip[] }} app
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
  let sizeTimer = 0;
  /** The terminal's colours, as the app's look says (theme.js); the desktop's Dark until it has said. */
  /** @type {{ colors: Record<string, string>, contrast: number }} */
  let look = { colors: {}, contrast: 1 };

  /**
   * New colours (the look was chosen, or the PC's theme changed): on the terminal shown, and its box around it.
   * @param {{ colors: Record<string, string>, contrast: number }} next
   */
  function retheme(next) {
    look = next;
    const box = /** @type {HTMLElement | null} */ (view.querySelector(BOX));
    if (box) box.style.background = next.colors.background ?? '';
    if (!term) return;
    term.options.theme = next.colors;
    term.options.minimumContrastRatio = next.contrast;
  }

  /** As many columns and rows as fit the terminal's box at its font size, with the keyboard down. */
  function grid() {
    const box = /** @type {HTMLElement | null} */ (view.querySelector(BOX));
    const cell = term && cellOf(term);
    if (!box || !cell) return null;
    return {
      cols: Math.max(LEAST.cols, Math.floor((box.clientWidth - BOX_PADDING.width) / cell.width)),
      rows: Math.max(LEAST.rows, Math.floor((box.clientHeight + keyboardHeight() - BOX_PADDING.height) / cell.height)),
    };
  }

  /** How much of the screen the keyboard takes now (px), 0 when it's down. */
  const keyboardHeight = () => view.classList.contains(KEYBOARD) && window.visualViewport ? Math.max(0, full.height - window.visualViewport.height) : 0;

  /**
   * While the keyboard is up, the terminal slides up just enough that the cursor's line shows above it (the rows over
   * it go under the header); back down when the keyboard goes.
   */
  function lift() {
    const el = term?.element, box = /** @type {HTMLElement | null} */ (view.querySelector(BOX)), cell = term && cellOf(term);
    if (!el) return;
    if (!box || !cell || !keyboardHeight()) {
      el.style.transform = '';
      return;
    }
    const buffer = term.buffer.active;
    const at = buffer.cursorY + buffer.baseY - buffer.viewportY;
    const row = at >= 0 && at < term.rows ? at : term.rows - 1;
    const room = box.clientHeight - BOX_PADDING.height;
    const shift = Math.max(0, Math.min((row + 1) * cell.height, term.rows * cell.height) - room);
    el.style.transform = shift ? `translateY(-${Math.ceil(shift)}px)` : '';
  }

  /** Gives the terminal the size that fits now, and asks the PC for the same, so what it prints next fits. */
  function fitGrid() {
    const size = grid();
    if (!term || !size) return;
    if (size.cols !== term.cols || size.rows !== term.rows) term.resize(size.cols, size.rows);
    term.scrollToBottom();
    lift();
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(() => { if (shown && term) app.send({ op: OP.size, pane: shown.id, cols: term.cols, rows: term.rows }); }, SIZE_AFTER_MS);
  }

  /** Whether typing here is allowed, and, into a production terminal, confirmed (asked once per opening). */
  function mayType() {
    if (!shown || !typing) return false;
    if (shown.production && !confirmed) {
      if (!window.confirm(`${shown.title} is tagged prod. Type into it from this phone?`)) return false;
      confirmed = true;
    }
    return true;
  }

  /**
   * Types into the terminal; false when it didn't (typing is off, or typing into production wasn't confirmed).
   * @param {string} data
   */
  function type(data) {
    if (!mayType()) return false;
    if (ctrl && data === KEYS.bksp) {
      data = CTRL_BACKSPACE;
      setCtrl(false);
    } else if (ctrl && data.length === 1 && /[a-z@[\\\]^_]/i.test(data)) {
      data = String.fromCharCode(data.toUpperCase().charCodeAt(0) - CTRL_OFFSET);
      setCtrl(false);
    }
    app.send({ op: OP.input, pane: shown.id, data });
    return true;
  }

  // The box under a Claude terminal (compose.js): Messages or One bar, as Settings says.
  const compose = composer(view, { keys: BAR, type, toast: app.toast, redraw: () => frame() });

  // The terminal's workspace's snippets and the global ones.
  const snippets = snippetSheet(view, { list: () => app.snippets().filter(s => !s.ws || s.ws === shown?.ws), type });
  // Smart Clip: the PC pastes the clip picked (its text stays there).
  const clipsSheet = clipSheet(view, {
    list: app.clips,
    paste: id => { if (shown && mayType()) app.send({ op: OP.clip, pane: shown.id, id }); },
    fill: id => app.send({ op: OP.clipText, id }),
  });

  /** @param {boolean} on */
  function setCtrl(on) {
    ctrl = on;
    view.querySelector(`[data-key="${CTRL}"]`)?.classList.toggle('on', on);
  }

  /**
   * The spinner, and beside it, while an agent works and typing is allowed, a button that stops it (Esc).
   * @param {any} t
   */
  const slotHtml = t => activityHtml(t) + (typing && STOPPABLE.includes(t.agent)
    ? `<button class="tv-stop" data-tv="${TV.stop}" aria-label="Stop ${esc(t.title)}"></button>` : '');

  function head() {
    if (!shown) return '';
    return `<header class="tv-head"><button class="tv-back" data-tv="${TV.back}" aria-label="Back">‹</button>
      <span class="badge${shown.icon === 'claude' ? ' claude' : ''}" data-icon="${esc(shown.icon)}">${shown.icon === 'claude' ? '✻' : esc(shown.badge)}</span>
      <span class="tv-title">${esc(shown.title)}<span class="tv-ws"> · ${esc(app.wsName(shown.ws))}</span></span>
      <span class="activity-slot">${slotHtml(shown)}</span>
      ${shown.waiting ? `<button class="btn primary tv-answer" data-tv="${TV.answer}">Answer</button>` : ''}</header>`;
  }

  /** Draws the parts around the terminal (its header, the key bar or why typing is off), keeping xterm as it is. */
  function frame() {
    const box = view.querySelector(BOX);
    compose.stopListening(); // its box is drawn again
    view.querySelectorAll('.tv-head, .tv-foot, .c-menu').forEach(el => el.remove());
    view.insertAdjacentHTML('afterbegin', head());
    box?.insertAdjacentHTML('afterend', typing
      ? compose.html(shown?.icon === 'claude')
      : '<p class="tv-foot tv-note">Typing from the phone is off: Settings › Phone › Allow typing, on the PC.</p>');
    setCtrl(ctrl);
  }

  /**
   * Opens a terminal: the PC sends what it printed lately, then what it prints.
   * @param {Shown} t
   * @param {boolean} canType
   */
  function open(t, canType) {
    // Its Claude session is still resuming on the PC: opened now, what's typed could spoil it.
    if (t.resuming) {
      app.toast('Claude is resuming on the PC. Try again in a moment.');
      return;
    }
    close();
    shown = t;
    typing = canType;
    confirmed = false;
    fontSize = Number(localStorage.getItem(SIZE_KEY)) || READABLE; // Settings may have changed it
    view.hidden = false;
    document.body.classList.add(OPEN);
    view.innerHTML = '<div class="tv-box"></div>';
    view.append(snippets.element, clipsSheet.element);
    snippets.close();
    clipsSheet.close();
    frame();
    term = new Terminal({ cols: t.cols ?? DEFAULT_SIZE.cols, rows: t.rows ?? DEFAULT_SIZE.rows, fontSize, scrollback: SCROLLBACK,
      fontFamily: 'ui-monospace, Menlo, Consolas, monospace', theme: look.colors, minimumContrastRatio: look.contrast, disableStdin: !canType, convertEol: false, cursorBlink: false });
    const box = /** @type {HTMLElement} */ (view.querySelector(BOX));
    term.open(box);
    retheme(look);
    touch(box);
    term.onData(/** @param {string} data */ data => { if (!AUTOMATIC.test(data)) type(data); });
    term.onCursorMove(lift);
    term.onScroll(lift);
    fitViewport();
    app.send({ op: OP.watch, pane: t.id, cols: term.cols, rows: term.rows });
  }

  /**
   * One finger scrolls back, two pinch the font (the size follows; it's remembered), and a tap brings up the keyboard
   * when typing is allowed.
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
      // Under a Claude terminal the tap goes to the message box: the keyboard's dictation works there, while in the
      // terminal itself it garbles (it rewrites words already sent, so they come out twice).
      tap: () => {
        if (!typing) return false;
        const field = compose.field();
        if (!field) term?.focus();
        field?.focus();
        return !!field;
      },
    });
  }

  /** Closes the view; the PC gives the terminal its own size back. */
  function close() {
    clearTimeout(sizeTimer);
    compose.stopListening();
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
   * The PC's news about the terminal shown: gone, waiting or not, typing allowed or not. (Its size is the phone's.)
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
    const waitingChanged = !!t.waiting !== !!shown.waiting;
    const typingChanged = canType !== typing;
    shown = t;
    // Only when it changes, so the spinner doesn't start over with every update.
    const slot = view.querySelector('.tv-head .activity-slot'), activity = slotHtml(t);
    if (slot && slot.innerHTML !== activity) slot.innerHTML = activity;
    if (typingChanged) {
      typing = canType;
      if (term) term.options.disableStdin = !canType;
      frame();
    } else if (waitingChanged) {
      // Only the header's Answer button: the box under the terminal keeps what's being written (and dictated).
      view.querySelector('.tv-head')?.remove();
      view.insertAdjacentHTML('afterbegin', head());
    }
  }

  /** @param {{ type: string, pane: string, data: string }} m */
  function message(m) {
    if (!term || m.pane !== shown?.id) return;
    if (m.type === LIVE.screen) {
      // Drawn by the PC's terminal at this size already.
      term.reset();
      term.write(m.data);
    } else if (m.type === LIVE.output) {
      term.write(m.data);
    }
  }

  /** The tallest the visible screen has been at this width (turning the phone starts over): the keyboard is down then. */
  const full = { width: 0, height: 0 };

  /** The view fills what the keyboard leaves of the screen, so the key bar sits right above it. */
  function fitViewport() {
    const visible = window.visualViewport;
    if (view.hidden || !visible) return;
    // Not the page's height: in a Home Screen app iOS shrinks that with the keyboard too.
    if (visible.width !== full.width) Object.assign(full, { width: visible.width, height: 0 });
    full.height = Math.max(full.height, visible.height);
    // Nothing to type into, no keyboard: the whole screen, even when iOS still reports the height it had with one.
    const up = writing() && visible.height < full.height - KEYBOARD_LEAST;
    view.style.height = `${up ? visible.height : full.height}px`;
    view.classList.toggle(KEYBOARD, up);
    if (!up) window.scrollTo(0, 0); // iOS can leave the page where the keyboard pushed it
    pin();
    fitGrid();
  }
  /** Whether something that brings the keyboard has the focus (the message box, the terminal's own field). */
  const writing = () => !!document.activeElement?.matches('textarea, input');
  /** iOS reports the keyboard's coming and going late, or not at all: fit again as it settles. */
  function settle() {
    for (const ms of SETTLE_MS) setTimeout(fitViewport, ms);
  }
  view.addEventListener('focusin', settle);
  view.addEventListener('focusout', settle);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) settle(); });
  /** Keeps the view on what the phone shows: iOS moves the page under the keyboard, which would carry the header away. */
  function pin() {
    if (!view.hidden && window.visualViewport) view.style.transform = view.classList.contains(KEYBOARD) ? `translateY(${window.visualViewport.offsetTop}px)` : '';
  }
  window.visualViewport?.addEventListener('resize', fitViewport);
  window.visualViewport?.addEventListener('scroll', pin);

  /** Sends what's in the message box to Claude: the words, then Enter. */
  function sendMessage() {
    const field = /** @type {HTMLTextAreaElement | null} */ (view.querySelector(`${COMPOSE} textarea`));
    const text = field?.value.trim() ?? '';
    if (!field || !text) return;
    if (!type(text.includes('\n') ? PASTED.start + text + PASTED.end : text)) return;
    field.value = '';
    compose.stopListening(); // sent: no more dictation into it
    field.blur(); // and the keyboard goes, which ends the keyboard's own dictation (it listens while the box has it)
    compose.changed();
    setTimeout(() => type('\r'), ENTER_AFTER_MS);
  }
  view.addEventListener('submit', e => {
    e.preventDefault();
    if (/** @type {HTMLElement} */ (e.target).matches(COMPOSE)) sendMessage();
  });
  // Enter in the box sends (the keyboard's Send key); a hardware keyboard's Shift+Enter starts a new line.
  view.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.shiftKey || !/** @type {HTMLElement} */ (e.target).closest(COMPOSE)) return;
    e.preventDefault();
    sendMessage();
  });

  view.addEventListener('click', async e => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (await compose.click(target)) return;
    const key = target.closest('[data-key]')?.getAttribute('data-key');
    const action = target.closest('[data-tv]')?.getAttribute('data-tv');
    if (action === TV.back) close();
    else if (action === TV.answer && shown) app.answer(shown.id);
    else if (action === TV.stop && shown && typing && type(STOP)) {
      const stopped = shown.id;
      setTimeout(() => { if (shown?.id === stopped) type(CLEAR_INPUT); }, CLEAR_AFTER_MS);
    }
    else if (key === CTRL) setCtrl(!ctrl);
    else if (key === SNIP) snippets.open();
    else if (key === CLIPS) clipsSheet.open();
    else if (key === CLIPS_BOX) clipsSheet.open(true);
    else if (key === PASTE) {
      try {
        const text = await navigator.clipboard.readText();
        if (text) type(asTyped(text)); // lines in order, as a paste on the PC goes
      } catch {
        app.toast('The phone didn\'t allow pasting.');
      }
    } else if (key) type(/** @type {Record<string, string>} */ (KEYS)[key]);
    // The keyboard stays with the terminal after a key, except under a message box (see the tap).
    if (key && key !== SNIP && key !== CLIPS && key !== CLIPS_BOX && !compose.field()) term?.focus();
  });

  // Backspace held down goes on deleting, as a phone's keyboard does (the first press is the click's).
  let repeat = 0;
  const stopRepeat = () => {
    clearTimeout(repeat);
    clearInterval(repeat);
    repeat = 0;
  };
  view.addEventListener('pointerdown', e => {
    if (!/** @type {HTMLElement} */ (e.target).closest(`[data-key="${BACKSPACE}"]`)) return;
    stopRepeat();
    repeat = window.setTimeout(() => { repeat = window.setInterval(() => type(KEYS.bksp), REPEAT.every); }, REPEAT.after);
  });
  for (const end of ['pointerup', 'pointercancel']) view.addEventListener(end, stopRepeat);

  /** Back after the connection dropped: the terminal shown starts over with what it shows. */
  const rewatch = () => { if (shown && term) app.send({ op: OP.watch, pane: shown.id, cols: term.cols, rows: term.rows }); };

  return {
    open, close, update, message, rewatch, retheme,
    /** A clip's text the PC sent for the message box (Paste from Smart Clip in Claude's +). @param {string} text */
    fillBox: text => compose.fill(text),
    /** The terminal shown, or null. */
    get viewing() { return shown?.id ?? null; },
  };
}
