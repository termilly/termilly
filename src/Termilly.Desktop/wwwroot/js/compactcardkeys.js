// @ts-check
// The keys of the compact view's card (js/compactcard.js draws it, js/compact.js wires it), from the prompt box while
// it's empty: Up and Down move along the card's choices, Enter picks the one they're on, and a choice's number picks it
// at once. The card keeps its own place for the keys rather than following the agent's pointer, which it reads off the
// screen and can miss (a prompt drawn in a way it doesn't know), so the keys always do what the card shows.

/** The card, its choices (data-choice holds the key that picks one), and the class of the one the keys are on. */
const CARD = '.cv-card';
const CHOICE = '[data-choice]';
const KEYED = 'keyed';
/** The choice the agent's pointer was on when the card was drawn (compactcard.js). */
const PICKED = 'picked';
/** The keys that move along the choices, and by how much. */
const STEP = Object.freeze({ ArrowDown: 1, ArrowUp: -1 });

/**
 * A key from the empty prompt box, for the card: true when it was the card's (the caller stops it there).
 * @param {HTMLElement} view the compact view
 * @param {KeyboardEvent} e
 * @param {(key: string, menu: string) => void} press picks a choice of the card's menu, as its button does
 */
export function cardKey(view, e, press) {
  if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return false;
  const card = /** @type {HTMLElement | null} */ (view.querySelector(`${CARD}[data-menu]`));
  const menu = card?.dataset.menu ?? '';
  const choices = card && menu ? /** @type {HTMLElement[]} */ ([...card.querySelectorAll(CHOICE)]) : [];
  if (!choices.length) return false;
  const numbered = choices.find(c => c.dataset.choice === e.key);
  if (numbered) {
    press(e.key, menu);
    return true;
  }
  const keyed = choices.findIndex(c => c.classList.contains(KEYED));
  const at = keyed >= 0 ? keyed : Math.max(0, choices.findIndex(c => c.classList.contains(PICKED)));
  if (e.key === 'Enter') {
    press(/** @type {string} */ (choices[at].dataset.choice), menu);
    return true;
  }
  const step = /** @type {Record<string, number>} */ (STEP)[e.key];
  if (!step) return false;
  const next = (at + step + choices.length) % choices.length;
  choices.forEach((c, i) => {
    c.classList.toggle(KEYED, i === next);
    c.setAttribute('aria-current', String(i === next));
  });
  return true;
}
