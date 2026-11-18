// @ts-check
// Only the opt-in host driver sends test:eval. Importing this module never evaluates test code.
import { onHost, send } from './host.js';
import { HOST, PAGE } from './protocol.js';
import { openDocuments, hereDoc } from './windows.js';

/** @typedef {{ button?: number, shift?: boolean, ctrl?: boolean, alt?: boolean }} Modifiers */
/** @typedef {{ text?: string, gone?: boolean, timeoutMs?: number }} WaitOptions */
const WAIT_MS = 10000;
const POLL_MS = 25;
const RIGHT_BUTTON = 2;
const MIDDLE_BUTTON = 1;
const MIDDLE_BUTTONS = 4;
const HIDDEN = 'hidden';
const NONE = 'none';
const INSERT_TEXT = 'insertText';

/** @param {string} selector */
const all = selector => openDocuments().flatMap(doc => [...doc.querySelectorAll(selector)]);
/** @param {string} selector */
const first = selector => all(selector)[0] ?? null;
/** @param {string} selector */
function required(selector) {
  const el = first(selector);
  if (!el) throw new Error(`No element matches ${selector}`);
  return /** @type {HTMLElement} */ (el);
}

/** @param {Element} el */
function shown(el) {
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  return !!el.getClientRects().length && style?.visibility !== HIDDEN && style?.display !== NONE;
}

/** @param {HTMLElement} el @param {string} type @param {Modifiers} options @param {number} detail */
function mouse(el, type, options, detail) {
  const rect = el.getBoundingClientRect();
  const button = options.button ?? 0;
  const buttons = button === RIGHT_BUTTON ? RIGHT_BUTTON : button === MIDDLE_BUTTON ? MIDDLE_BUTTONS : 1;
  const realm = /** @type {Window & typeof globalThis} */ (el.ownerDocument.defaultView);
  const init = { bubbles: true, cancelable: true, view: el.ownerDocument.defaultView,
    button, buttons: type.endsWith('down') ? buttons : 0,
    shiftKey: options.shift, ctrlKey: options.ctrl, altKey: options.alt, detail,
    clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
  const EventType = type.startsWith('pointer') && typeof realm.PointerEvent !== 'undefined' ? realm.PointerEvent : realm.MouseEvent;
  return el.dispatchEvent(new EventType(type, init));
}

/** @param {string} selector @param {Modifiers} [options] @param {number} [detail] */
function click(selector, options = {}, detail = 1) {
  const el = required(selector);
  mouse(el, 'pointerdown', options, detail);
  if (mouse(el, 'mousedown', options, detail)) el.focus();
  mouse(el, 'pointerup', options, detail);
  mouse(el, 'mouseup', options, detail);
  mouse(el, 'click', options, detail);
}

/** @param {string} selector @param {Modifiers} [options] */
function dblclick(selector, options = {}) {
  click(selector, options);
  click(selector, options, 2);
  mouse(required(selector), 'dblclick', options, 2);
}

/** @param {string} selector */
function contextmenu(selector) {
  const el = required(selector);
  const options = { button: RIGHT_BUTTON };
  mouse(el, 'pointerdown', options, 1);
  mouse(el, 'mousedown', options, 1);
  mouse(el, 'pointerup', options, 1);
  mouse(el, 'mouseup', options, 1);
  mouse(el, 'contextmenu', options, 1);
}

/** @param {string} selector @param {string} text */
function type(selector, text) {
  const el = required(selector);
  el.focus();
  if ('value' in el) /** @type {HTMLInputElement} */ (el).value = text;
  else if (el.isContentEditable) el.textContent = text;
  else throw new Error(`Cannot type into ${selector}`);
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: INSERT_TEXT, data: text }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** @param {string | null} selector @param {string} key @param {Modifiers} [options] */
function pressKey(selector, key, options = {}) {
  const el = selector === null ? hereDoc().activeElement ?? hereDoc().body : required(selector);
  const code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key;
  const init = { key, code, bubbles: true, cancelable: true,
    ctrlKey: options.ctrl, shiftKey: options.shift, altKey: options.alt };
  el.dispatchEvent(new KeyboardEvent('keydown', init));
  el.dispatchEvent(new KeyboardEvent('keyup', init));
}

/** @param {string} selector @param {WaitOptions} [options] */
async function waitFor(selector, { text, gone = false, timeoutMs = WAIT_MS } = {}) {
  const end = Date.now() + timeoutMs;
  let seen;
  do {
    const elements = all(selector);
    const matches = elements.filter(el => shown(el) && (text === undefined || el.textContent?.includes(text)));
    if (gone ? !matches.length : matches.length) return gone ? null : matches[0];
    seen = elements.map(el => `${shown(el) ? 'visible' : HIDDEN}: ${el.textContent}`).join('\n');
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  } while (Date.now() < end);
  throw new Error(`Timed out waiting for ${selector} (text=${text}, gone=${gone}). Saw: ${seen || 'no matches'}`);
}

const helpers = Object.freeze({
  $: first, $$: all,
  /** @param {string} selector */
  text: selector => first(selector)?.textContent ?? '',
  /** @param {string} selector */
  visible: selector => all(selector).some(shown),
  click, dblclick, contextmenu, type, key: pressKey, waitFor,
  /** @param {string} path */
  import: path => import(new URL(path, import.meta.url).href),
});

onHost(HOST.testEval, async ({ id, code }) => {
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const value = await new AsyncFunction('t', code)(helpers);
    // Round-trip before sending so undefined, cycles and non-JSON values cannot strand an HTTP request.
    const json = JSON.stringify(value ?? null);
    send(PAGE.testResult, { id, value: JSON.parse(json) });
  } catch (error) {
    const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    send(PAGE.testResult, { id, error: message });
  }
});
