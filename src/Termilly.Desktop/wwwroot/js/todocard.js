// @ts-check
// Implement's card, under a task's Implement button: which agent does the work, which agents review it (offered only when more
// than one agent is installed), for how many rounds at most, and whether it runs in a new terminal or silently. It opens with
// the list's own plan, or the one for every list. Start runs what the card shows; with "Use for this list from now on" ticked,
// that is also kept as the list's plan, which the card opens with next time (ticked again with another choice, it's replaced).

import { openPopover, closePopover } from './popups.js';
import { escapeHtml } from './ui.js';
import { RUN_NAMES } from './todoplan.js';
import { planRowsHtml, planClicked } from './planrows.js';

/** @typedef {import('./todoplan.js').ImplementPlan} ImplementPlan */

/** What a control on the card does. */
const CARD = Object.freeze({ run: 'run', keep: 'keep', start: 'start' });
/**
 * What the card is opened with.
 * @typedef {object} CardOptions
 * @property {string} title the task's text, or its step's
 * @property {ImplementPlan} plan the plan it opens with
 * @property {readonly string[]} agents the agents that can do the work
 * @property {readonly string[]} reviewers the agents that can review (empty: nobody is offered)
 * @property {boolean} keep whether "Use for this list from now on" starts ticked
 * @property {string} [where] where it runs, when that isn't this computer: an SSH host's name
 * @property {(plan: ImplementPlan, keep: boolean) => void} start
 */

/**
 * The card's inside, for a plan.
 * @param {CardOptions} options
 * @param {ImplementPlan} plan
 * @param {boolean} keep
 */
function cardHtml(options, plan, keep) {
  return `<div class="tc-head"><b>Implement${options.where ? ` on ${escapeHtml(options.where)}` : ''}</b><span>${escapeHtml(options.title)}</span></div>
    ${planRowsHtml(plan, options)}
    <div class="tc-row"><span class="tc-label">Run</span><div><span class="seg">${RUN_NAMES.map(([run, label]) => `<button type="button" data-card="${CARD.run}" data-run="${run}" class="${plan.run === run ? 'on' : ''}" aria-pressed="${plan.run === run}">${label}</button>`).join('')}</span></div></div>
    <div class="tc-foot"><label class="tc-keep" title="Start then also keeps this as the list’s plan: the card opens with it next time. Without it, only this run uses it."><input type="checkbox" data-card="${CARD.keep}"${keep ? ' checked' : ''}> Use for this list from now on</label>
      <button type="button" class="btn small primary" data-card="${CARD.start}">Start</button></div>`;
}

/**
 * Opens Implement's card at a task's Implement button.
 * @param {HTMLElement} at
 * @param {CardOptions} options
 */
export function openImplementCard(at, options) {
  const card = at.ownerDocument.createElement('div');
  card.className = 'popover td-card';
  card.hidden = true;
  let plan = options.plan;
  let { keep } = options;
  /** @param {string} [focus] the control the keyboard stays on */
  const draw = focus => {
    card.innerHTML = cardHtml(options, plan, keep);
    const at = focus ? `[data-card="${focus}"]:not(:disabled), [data-plan="${focus}"]:not(:disabled)` : `[data-card="${CARD.start}"]`;
    /** @type {HTMLElement | null} */ (card.querySelector(at) ?? card.querySelector(`[data-card="${CARD.start}"]`))?.focus();
  };
  card.addEventListener('click', e => {
    const picked = planClicked(e, plan, options, (next, control) => {
      plan = next;
      draw(control);
    }, { nested: true });
    const control = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-card]'));
    const what = control?.dataset.card;
    if (picked || !control || !what) return;
    if (what === CARD.keep) keep = /** @type {HTMLInputElement} */ (control).checked;
    else if (what === CARD.run) {
      plan = { ...plan, run: control.dataset.run ?? plan.run };
      draw(what);
    } else if (what === CARD.start) {
      closePopover(card);
      options.start(plan, keep);
    }
  });
  openPopover(card, at, { dynamic: true, refocus: () => at.focus() });
  draw();
}
