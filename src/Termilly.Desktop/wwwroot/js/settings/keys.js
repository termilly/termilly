// @ts-check
// Choosing keys in Settings (Actions, Keyboard): a button waits for them. Esc or leaving the button keeps the old ones,
// Backspace or Delete removes them; the keys are taken before anything else sees them, so Termilly's own shortcuts
// don't run meanwhile.

import { chordOf } from '../keymap.js';

const CLEAR_KEYS = ['Backspace', 'Delete'];
const CANCEL_KEY = 'Escape';

/**
 * @param {HTMLButtonElement} button
 * @param {{ chosen: (chord: string) => void, cleared: () => void, cancelled: () => void }} then
 */
export function captureKeys(button, then) {
  button.textContent = 'Press the keys';
  button.classList.add('capturing');
  const stop = () => {
    window.removeEventListener('keydown', onKey, true);
    button.removeEventListener('blur', cancel);
  };
  const cancel = () => { stop(); then.cancelled(); };
  /** @param {KeyboardEvent} e */
  function onKey(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === CANCEL_KEY) return cancel();
    if (CLEAR_KEYS.includes(e.key) && !e.ctrlKey && !e.altKey) {
      stop();
      return then.cleared();
    }
    const chord = chordOf(e);
    if (!chord) return; // a modifier on its own: wait for the key
    stop();
    then.chosen(chord);
  }
  window.addEventListener('keydown', onKey, true);
  button.addEventListener('blur', cancel);
}
