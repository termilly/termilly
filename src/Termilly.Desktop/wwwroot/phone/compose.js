// @ts-check
// The box under a Claude terminal for writing to Claude, as Settings › Message box says:
// - Messages (the default): a round field with the microphone in it; the send arrow shows once there's something to
//   send; a + holds paste, snippets, Claude's commands and changing its mode. The key bar stays under it while writing.
// - One bar: the key bar and the field share one row, with a switch between keys and a message to Claude.
// Other terminals get the key bar alone. terminal.js sends what's written (the words, then Enter).

/** Where the phone keeps the choice, and the choices. */
export const COMPOSE_STYLE = Object.freeze({ key: 'termilly.compose', messages: 'messages', bar: 'bar' });
/** One bar's mode, kept between terminals. */
const MODE_KEY = 'termilly.compose.mode';
const MODE = Object.freeze({ keys: 'keys', claude: 'claude' });
/** The box's form (terminal.js sends from it). */
export const COMPOSE = '.tv-compose';
/** What its own buttons do (data-c). */
const C = Object.freeze({ plus: 'plus', mic: 'mic', mode: 'mode', more: 'more', fill: 'fill', shiftTab: 'shift-tab', pasteIn: 'paste-in' });
/** Claude's commands the + offers: they go in the field, to send or change first. */
const COMMANDS = ['/compact', '/clear'];
/** Shift+Tab: Claude Code's next mode (accept edits, plan). */
const SHIFT_TAB = '\x1b[Z';
/** One bar's keys in keys mode, and the ones under its ⋯ (terminal.js BAR). */
const FEW_KEYS = ['esc', 'tab', 'ctrl', 'up', 'down', 'enter'];
const MORE_KEYS = ['left', 'right', 'paste', 'snip'];
/** Its send buttons (Messages' arrow, One bar's). */
const SEND = '.m-go, .b-go';
/** The key bar under it. */
const KEYBAR = '.keybar';
/** Its parts. */
const PART = Object.freeze({ menu: '.c-menu', mic: '.m-mic', go: '.m-go' });

const ICON = Object.freeze({
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v12M6 12h12"/></svg>',
  mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M6 11.5a6 6 0 0 0 12 0M12 17.5v3"/></svg>',
  up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
});

const FIELD = '<textarea rows="1" placeholder="Message Claude" enterkeyhint="send" autocapitalize="sentences"></textarea>';

/** How to dictate (Settings › Dictation): with the keyboard's microphone (the default; the box has none of its own and
 * iOS asks nothing; a page can't start the keyboard's) or Termilly's (no keyboard in the way, but iOS asks for the
 * microphone each time the app starts). */
export const DICTATION = Object.freeze({ key: 'termilly.dictation', keyboard: 'keyboard', termilly: 'termilly' });
/** @returns {string} */
export const dictation = () => (localStorage.getItem(DICTATION.key) === DICTATION.termilly ? DICTATION.termilly : DICTATION.keyboard);

/** @returns {string} */
export const composeStyle = () => (localStorage.getItem(COMPOSE_STYLE.key) === COMPOSE_STYLE.bar ? COMPOSE_STYLE.bar : COMPOSE_STYLE.messages);

/** The browser's speech recognition, where there is one (Safari has it as webkitSpeechRecognition). */
const Speech = /** @type {any} */ (window).SpeechRecognition ?? /** @type {any} */ (window).webkitSpeechRecognition;
/** Its errors that mean dictation can't work here (others: silence, a stop, a dropped network). */
const MIC_REFUSED = ['not-allowed', 'service-not-allowed', 'audio-capture'];

/**
 * @param {HTMLElement} view The terminal view.
 * @param {{ keys: [string, string][], type: (data: string) => boolean, toast: (text: string) => void, redraw: () => void }} app
 *   The key bar's keys ([data-key, label]), how to type into the terminal, and drawing the box again.
 */
export function composer(view, app) {
  /** @type {any} */
  let listening = null;

  const keyButtons = (/** @type {[string, string][]} */ keys) => keys.map(([key, label]) => `<button data-key="${key}">${label}</button>`).join('');
  const keybar = () => `<div class="tv-foot keybar">${keyButtons(app.keys)}</div>`;

  /** Messages: the round field with the + and the microphone, over the key bar. */
  const messagesHtml = () => `<form class="tv-foot tv-compose msg"><button type="button" class="m-plus" data-c="${C.plus}" aria-label="More">${ICON.plus}</button>
    <div class="m-pill">${FIELD}${dictation() === DICTATION.termilly ? `<button type="button" class="m-mic" data-c="${C.mic}" aria-label="Dictate">${ICON.mic}</button>` : ''}<button type="submit" class="m-go" aria-label="Send" hidden>${ICON.up}</button></div></form>${keybar()}`;

  /** One bar: the switch, then the keys or the field. The keys that don't fit wait under ⋯. */
  function barHtml() {
    const mode = localStorage.getItem(MODE_KEY) === MODE.claude ? MODE.claude : MODE.keys;
    const toggle = `<span class="b-mode"><button type="button" class="${mode === MODE.keys ? 'on' : ''}" data-c="${C.mode}" data-mode="${MODE.keys}" aria-label="Keys">⌨</button><button type="button" class="claude${mode === MODE.claude ? ' on' : ''}" data-c="${C.mode}" data-mode="${MODE.claude}" aria-label="Message Claude">✻</button></span>`;
    if (mode === MODE.claude) return `<form class="tv-foot tv-compose one-bar">${toggle}${FIELD}<button type="submit" class="b-go" aria-label="Send">${ICON.up}</button></form>`;
    const few = app.keys.filter(([key]) => FEW_KEYS.includes(key));
    return `<div class="tv-foot keybar one-bar">${toggle}${keyButtons(few)}<button data-c="${C.more}" aria-label="More keys">⋯</button></div>`;
  }

  /**
   * The parts under the terminal: for Claude, the box as Settings says; for the rest, the key bar.
   * @param {boolean} claude
   */
  const html = claude => (!claude ? keybar() : composeStyle() === COMPOSE_STYLE.bar ? barHtml() : messagesHtml());

  // ---- The + and ⋯ menus ----

  /** @param {string} items */
  function menu(items) {
    closeMenu();
    view.insertAdjacentHTML('beforeend', `<div class="c-menu">${items}</div>`);
  }
  const closeMenu = () => view.querySelector(PART.menu)?.remove();

  const field = () => /** @type {HTMLTextAreaElement | null} */ (view.querySelector(`${COMPOSE} textarea`));
  /** @param {string} text */
  function fill(text) {
    const f = field();
    if (!f) return;
    f.value = f.value ? `${f.value} ${text}` : text;
    f.focus();
    changed();
  }

  /** The arrow shows once there's something to send, in place of the microphone; while it listens, beside it. */
  function changed() {
    const has = !!field()?.value.trim();
    const go = /** @type {HTMLElement | null} */ (view.querySelector(PART.go));
    const mic = /** @type {HTMLElement | null} */ (view.querySelector(PART.mic));
    if (go) go.hidden = !has;
    if (mic) mic.hidden = has && !listening;
  }

  /** Stops listening, at once: the phone's microphone is let go. */
  function stopListening() {
    if (!listening) return;
    const was = listening;
    listening = null;
    was.onresult = null;
    was.onend = null;
    was.onerror = null; // aborting reports an "aborted" error: not a failure
    was.abort();
    view.querySelector(PART.mic)?.classList.remove('on');
    changed();
  }

  /** Dictation into the field: the browser's own when it has it, else the keyboard's microphone. */
  function dictate() {
    const mic = view.querySelector(PART.mic);
    if (listening) {
      stopListening();
      return;
    }
    if (!Speech) {
      field()?.focus();
      app.toast('Tap the microphone on the keyboard to dictate.');
      return;
    }
    const before = field()?.value ?? '';
    listening = new Speech();
    listening.interimResults = true;
    listening.continuous = false;
    listening.onresult = (/** @type {any} */ e) => {
      const said = [...e.results].map(r => r[0].transcript).join('');
      const f = field();
      if (f) f.value = before ? `${before} ${said}` : said;
      changed();
      // The words are final: done listening (a phone may otherwise keep its microphone on).
      if ([...e.results].every(r => r.isFinal)) stopListening();
    };
    listening.onend = () => { listening = null; mic?.classList.remove('on'); changed(); };
    // Only a refused or missing microphone is worth saying; silence or a stop isn't.
    listening.onerror = (/** @type {any} */ e) => {
      stopListening();
      if (MIC_REFUSED.includes(e?.error)) app.toast('Dictation didn\'t start: the keyboard\'s microphone works too.');
    };
    mic?.classList.add('on');
    listening.start();
  }

  /**
   * A tap on one of its buttons; false when it isn't one.
   * @param {HTMLElement} target
   */
  async function click(target) {
    const el = /** @type {HTMLElement | null} */ (target.closest('[data-c]'));
    if (!el) {
      closeMenu(); // a key in the menu, if that's what was tapped, is typed by terminal.js
      return false;
    }
    switch (el.dataset.c) {
      case C.plus:
        if (view.querySelector(PART.menu)) closeMenu();
        else menu(`<button data-c="${C.pasteIn}">Paste</button><button data-key="snip">Snippets</button>${COMMANDS.map(c => `<button data-c="${C.fill}" data-text="${c}">${c}</button>`).join('')}<button data-c="${C.shiftTab}">Change mode (Shift+Tab)</button>`);
        break;
      case C.more:
        if (view.querySelector(PART.menu)) closeMenu();
        else menu(app.keys.filter(([key]) => MORE_KEYS.includes(key)).map(([key, label]) => `<button data-key="${key}">${label}</button>`).join(''));
        break;
      case C.pasteIn:
        closeMenu();
        try {
          fill(await navigator.clipboard.readText());
        } catch {
          app.toast('The phone didn\'t allow pasting.');
        }
        break;
      case C.fill: closeMenu(); fill(el.dataset.text ?? ''); break;
      case C.shiftTab: closeMenu(); app.type(SHIFT_TAB); break;
      case C.mic: dictate(); break;
      case C.mode:
        localStorage.setItem(MODE_KEY, el.dataset.mode ?? MODE.keys);
        app.redraw();
        if (el.dataset.mode === MODE.claude) field()?.focus();
        break;
      default: return false;
    }
    return true;
  }

  // The send arrow, and a key bar key while writing, keep the keyboard where it is: losing it would shrink the view and
  // move the button away before the tap's click, so a first tap did nothing. Send goes as the finger lifts; the click
  // after finds the box empty.
  view.addEventListener('pointerdown', e => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.closest(SEND) || (target.closest(KEYBAR) && document.activeElement === field())) e.preventDefault();
  });
  view.addEventListener('pointerup', e => {
    /** @type {HTMLElement} */ (e.target).closest(SEND)?.closest(COMPOSE)?.requestSubmit();
  });

  view.addEventListener('input', e => { if (/** @type {HTMLElement} */ (e.target).closest(COMPOSE)) changed(); });

  // The app goes to the background: the microphone is let go.
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopListening(); });

  return { html, click, changed, field, stopListening };
}
