// @ts-check
// The rows that pick who does an agent's work, who reviews it and for how many rounds at most. Implement's card
// (js/todocard.js) and a schedule's agent prompt (js/scheduleview.js) show the same ones, built from the agents installed,
// so an agent Termilly learns to run is offered in both.

import { showMenu } from './popups.js';
import { escapeHtml, badgeHtml, ICONS } from './ui.js';
import { targetOf } from './dom.js';
import { agentKind } from './agentkinds.js';
import { ROUNDS, fitPlan, reviewersFor, namesOf } from './todoplan.js';

/** @typedef {import('./todoplan.js').ImplementPlan} ImplementPlan */

/** What a control in the rows does (its data-plan). */
export const PLAN = Object.freeze({ by: 'by', add: 'add', drop: 'drop', more: 'more', fewer: 'fewer' });
/** The step buttons' arrows, drawn at the size they show. */
const ARROW = Object.freeze({
  up: '<svg viewBox="0 0 10 10"><path d="M2.5 6.5L5 4l2.5 2.5"/></svg>',
  down: '<svg viewBox="0 0 10 10"><path d="M2.5 3.5L5 6l2.5-2.5"/></svg>',
});

/**
 * The agents the rows offer, and what they say about a review.
 * @typedef {object} PlanAgents
 * @property {readonly string[]} agents the agents that can do the work
 * @property {readonly string[]} reviewers the agents that can review (empty: nobody is offered)
 * @property {(plan: ImplementPlan) => string} [hint] what a review does, under the rounds; the card's own when left out
 */

/** An agent, as the rows name it: its badge and name. @param {string} kind */
const agentHtml = kind => `${badgeHtml({ icon: agentKind(kind).icon })}<span>${escapeHtml(agentKind(kind).name)}</span>`;

/**
 * What a review does, as Implement's card says it.
 * @param {ImplementPlan} plan
 */
function cardHint(plan) {
  const many = plan.reviewers.length > 1;
  const who = namesOf(plan.reviewers);
  return plan.rounds > 1
    ? `What ${who} ${many ? 'find' : 'finds'} goes back to ${agentKind(plan.by).name}, ${plan.rounds} rounds at most. Then it comes to you.`
    : `${who} ${many ? 'review' : 'reviews'} once. What ${many ? 'they find' : 'it finds'} comes to you with the work.`;
}

/**
 * The row choosing who does the work: a button that opens the agents, or with one agent, just its name.
 * @param {ImplementPlan} plan
 * @param {readonly string[]} agents
 */
function byHtml(plan, agents) {
  const pick = agents.length < 2 ? `<span class="tc-one">${agentHtml(plan.by)}</span>`
    : `<button type="button" class="field dropdown tc-by" data-plan="${PLAN.by}" aria-haspopup="menu">${agentHtml(plan.by)}<span class="dropdown-chevron">${ICONS.chevronDown}</span></button>`;
  return `<div class="tc-row"><span class="tc-label">By</span><div>${pick}</div></div>`;
}

/**
 * The rows for reviewers and rounds: nothing when nobody can review, and no rounds until somebody does.
 * @param {ImplementPlan} plan
 * @param {readonly string[]} can the agents that can review this plan's work
 * @param {(plan: ImplementPlan) => string} hint
 */
function reviewHtml(plan, can, hint) {
  if (!can.length) return '';
  const chips = plan.reviewers.map(kind => `<span class="tc-chip">${agentHtml(kind)}<button type="button" data-plan="${PLAN.drop}" data-kind="${escapeHtml(kind)}" title="Don’t have ${escapeHtml(agentKind(kind).name)} review it">×</button></span>`).join('');
  const add = plan.reviewers.length < can.length ? `<button type="button" class="tc-add" data-plan="${PLAN.add}">${ICONS.plus}<span>Add reviewer</span></button>` : '';
  const rounds = plan.reviewers.length ? `<div class="tc-row top"><span class="tc-label">Rounds</span><div>
      <span class="tc-step"><output aria-live="polite">${plan.rounds}</output><span class="tc-arrows">
        <button type="button" data-plan="${PLAN.more}" title="One more round" ${plan.rounds >= ROUNDS.max ? 'disabled' : ''}>${ARROW.up}</button>
        <button type="button" data-plan="${PLAN.fewer}" title="One round fewer" ${plan.rounds <= ROUNDS.min ? 'disabled' : ''}>${ARROW.down}</button>
      </span></span>
      <p class="tc-hint">${escapeHtml(hint(plan))}</p></div></div>` : '';
  return `<div class="tc-row top"><span class="tc-label">Reviewed by</span><div class="tc-pick">${chips}${add}</div></div>${rounds}`;
}

/**
 * The rows for a plan: By, then Reviewed by and Rounds where an agent can review.
 * @param {ImplementPlan} plan
 * @param {PlanAgents} options
 * @param {{ review?: boolean }} [show] review false: the By row only
 */
export function planRowsHtml(plan, options, { review = true } = {}) {
  return byHtml(plan, options.agents) + (review ? reviewHtml(plan, reviewersFor(plan.by, options.reviewers), options.hint ?? cardHint) : '');
}

/**
 * What a click on one of the rows changes in the plan.
 * @type {Readonly<Record<string, (plan: ImplementPlan, control: HTMLElement) => Partial<ImplementPlan>>>}
 */
const CHANGES = Object.freeze({
  [PLAN.drop]: (plan, control) => ({ reviewers: plan.reviewers.filter(kind => kind !== control.dataset.kind) }),
  [PLAN.more]: plan => ({ rounds: plan.rounds + 1 }),
  [PLAN.fewer]: plan => ({ rounds: plan.rounds - 1 }),
});

/**
 * The agents a control offers, and what picking one changes in the plan: who does the work (a reviewer picked for that changes
 * places with the agent that was doing it), or one more reviewer, from those not reviewing yet.
 * @type {Readonly<Record<string, (plan: ImplementPlan, options: PlanAgents) => { kinds: readonly string[], pick: (kind: string) => Partial<ImplementPlan> }>>}
 */
const PICKS = Object.freeze({
  [PLAN.by]: (plan, options) => ({ kinds: options.agents, pick: kind => ({ by: kind, reviewers: plan.reviewers.map(r => (r === kind ? plan.by : r)) }) }),
  [PLAN.add]: (plan, options) => ({
    kinds: reviewersFor(plan.by, options.reviewers).filter(kind => !plan.reviewers.includes(kind)),
    pick: kind => ({ reviewers: [...plan.reviewers, kind] }),
  }),
});

/**
 * A click in the rows: the plan it makes goes to `apply`, at once or once an agent is picked from a menu.
 * @param {Event} e
 * @param {ImplementPlan} plan
 * @param {PlanAgents} options
 * @param {(plan: ImplementPlan, control: string, fromMenu: boolean) => void} apply control: what was clicked, for the
 *   keyboard to stay on
 * @param {{ nested?: boolean }} [menu] nested: the menu opens over a popover, which it leaves open
 * @returns {boolean} whether the click was on the rows' controls
 */
export function planClicked(e, plan, options, apply, { nested = false } = {}) {
  const control = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-plan]'));
  const what = control?.dataset.plan;
  if (!control || !what) return false;
  // Another agent doing the work can't review itself, so it leaves the reviewers.
  /** @param {Partial<ImplementPlan>} change @param {boolean} fromMenu */
  const fit = (change, fromMenu) => apply(fitPlan({ ...plan, ...change }, [...new Set([...options.agents, ...options.reviewers])]), what, fromMenu);
  const agents = PICKS[what]?.(plan, options);
  if (agents && agents.kinds.length > 1) {
    showMenu(agents.kinds.map(kind => ({ label: agentKind(kind).name, icon: badgeHtml({ icon: agentKind(kind).icon }), checked: kind === plan.by && what === PLAN.by,
      action: () => fit(agents.pick(kind), true) })), control, { nested, className: 'dropdown-menu' }); // over the Schedules window too
  } else if (agents?.kinds.length) fit(agents.pick(agents.kinds[0]), false);
  else if (CHANGES[what]) fit(CHANGES[what](plan, control), false);
  return true;
}
