// @ts-check
// Implement's card, under a task's Implement button: which agent does the work, which agents review it (offered only when more
// than one agent is installed), for how many rounds at most, and whether it runs in a new terminal or silently. It opens with
// the list's own plan, or the one for every list. Start runs what the card shows; with "Use for this list from now on" ticked,
// that is also kept as the list's plan, which the card opens with next time (ticked again with another choice, it's replaced).

import { openPopover, closePopover, showMenu } from './popups.js';
import { escapeHtml, badgeHtml, ICONS } from './ui.js';
import { agentKind } from './agentkinds.js';
import { RUN, ROUNDS, fitPlan, reviewersFor, namesOf } from './todoplan.js';

/** @typedef {import('./todoplan.js').ImplementPlan} ImplementPlan */

/** What a control on the card does. */
const CARD = Object.freeze({ by: 'by', add: 'add', drop: 'drop', more: 'more', fewer: 'fewer', run: 'run', keep: 'keep', start: 'start' });
/** The step buttons' arrows, drawn at the size they show. */
const ARROW = Object.freeze({
  up: '<svg viewBox="0 0 10 10"><path d="M2.5 6.5L5 4l2.5 2.5"/></svg>',
  down: '<svg viewBox="0 0 10 10"><path d="M2.5 3.5L5 6l2.5-2.5"/></svg>',
});

/** An agent, as the card names it: its badge and name. @param {string} kind */
const agentHtml = kind => `${badgeHtml({ icon: agentKind(kind).icon })}<span>${escapeHtml(agentKind(kind).name)}</span>`;

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
 * The row choosing who does the work: a button that opens the agents, or with one agent, just its name.
 * @param {ImplementPlan} plan
 * @param {readonly string[]} agents
 */
function byHtml(plan, agents) {
  if (agents.length < 2) return `<span class="tc-one">${agentHtml(plan.by)}</span>`;
  return `<button type="button" class="field dropdown tc-by" data-card="${CARD.by}" aria-haspopup="menu">${agentHtml(plan.by)}<span class="dropdown-chevron">${ICONS.chevronDown}</span></button>`;
}

/**
 * The rows for reviewers and rounds: nothing when nobody can review, and no rounds until somebody does.
 * @param {ImplementPlan} plan
 * @param {readonly string[]} can the agents that can review this plan's work
 */
function reviewHtml(plan, can) {
  if (!can.length) return '';
  const chips = plan.reviewers.map(kind => `<span class="tc-chip">${agentHtml(kind)}<button type="button" data-card="${CARD.drop}" data-kind="${escapeHtml(kind)}" title="Don’t have ${escapeHtml(agentKind(kind).name)} review it">×</button></span>`).join('');
  const add = plan.reviewers.length < can.length ? `<button type="button" class="tc-add" data-card="${CARD.add}">${ICONS.plus}<span>Add reviewer</span></button>` : '';
  const by = agentKind(plan.by).name;
  const who = namesOf(plan.reviewers);
  const hint = plan.rounds > 1
    ? `What ${who} ${plan.reviewers.length > 1 ? 'find' : 'finds'} goes back to ${by}, ${plan.rounds} rounds at most. Then it comes to you.`
    : `${who} ${plan.reviewers.length > 1 ? 'review' : 'reviews'} once. What ${plan.reviewers.length > 1 ? 'they find' : 'it finds'} comes to you with the work.`;
  const rounds = plan.reviewers.length ? `<div class="tc-row"><span class="tc-label">Rounds</span><div>
      <span class="tc-step"><output aria-live="polite">${plan.rounds}</output><span class="tc-arrows">
        <button type="button" data-card="${CARD.more}" title="One more round" ${plan.rounds >= ROUNDS.max ? 'disabled' : ''}>${ARROW.up}</button>
        <button type="button" data-card="${CARD.fewer}" title="One round fewer" ${plan.rounds <= ROUNDS.min ? 'disabled' : ''}>${ARROW.down}</button>
      </span></span>
      <p class="tc-hint">${escapeHtml(hint)}</p></div></div>` : '';
  return `<div class="tc-row top"><span class="tc-label">Reviewed by</span><div class="tc-pick">${chips}${add}</div></div>${rounds}`;
}

/**
 * The card's inside, for a plan.
 * @param {CardOptions} options
 * @param {ImplementPlan} plan
 * @param {boolean} keep
 */
function cardHtml(options, plan, keep) {
  const runs = [[RUN.terminal, 'In a new terminal'], [RUN.silent, 'Silent']];
  return `<div class="tc-head"><b>Implement${options.where ? ` on ${escapeHtml(options.where)}` : ''}</b><span>${escapeHtml(options.title)}</span></div>
    <div class="tc-row"><span class="tc-label">By</span><div>${byHtml(plan, options.agents)}</div></div>
    ${reviewHtml(plan, reviewersFor(plan.by, options.reviewers))}
    <div class="tc-row"><span class="tc-label">Run</span><div><span class="seg">${runs.map(([run, label]) => `<button type="button" data-card="${CARD.run}" data-run="${run}" class="${plan.run === run ? 'on' : ''}" aria-pressed="${plan.run === run}">${label}</button>`).join('')}</span></div></div>
    <div class="tc-foot"><label class="tc-keep" title="Start then also keeps this as the list’s plan: the card opens with it next time. Without it, only this run uses it."><input type="checkbox" data-card="${CARD.keep}"${keep ? ' checked' : ''}> Use for this list from now on</label>
      <button type="button" class="btn small primary" data-card="${CARD.start}">Start</button></div>`;
}

/**
 * What a click on the card changes in its plan; null for what isn't a change to it.
 * @type {Readonly<Record<string, (plan: ImplementPlan, control: HTMLElement) => Partial<ImplementPlan>>>}
 */
const CHANGES = Object.freeze({
  [CARD.drop]: (plan, control) => ({ reviewers: plan.reviewers.filter(kind => kind !== control.dataset.kind) }),
  [CARD.more]: plan => ({ rounds: plan.rounds + 1 }),
  [CARD.fewer]: plan => ({ rounds: plan.rounds - 1 }),
  [CARD.run]: (_plan, control) => ({ run: control.dataset.run ?? RUN.terminal }),
});

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
    /** @type {HTMLElement | null} */ (card.querySelector(focus ? `[data-card="${focus}"]:not(:disabled)` : `[data-card="${CARD.start}"]`))?.focus();
  };
  /** @param {Partial<ImplementPlan>} change */
  const change = change => {
    // Another agent doing the work: it can't review itself, so it leaves the reviewers.
    plan = fitPlan({ ...plan, ...change }, [...new Set([...options.agents, ...options.reviewers])]);
  };
  /**
   * The agents to pick from, as a menu on top of the card.
   * @param {HTMLElement} control
   * @param {readonly string[]} kinds
   * @param {(kind: string) => Partial<ImplementPlan>} pick
   */
  const pickAgent = (control, kinds, pick) => {
    showMenu(kinds.map(kind => ({ label: agentKind(kind).name, icon: badgeHtml({ icon: agentKind(kind).icon }), checked: kind === plan.by && control.dataset.card === CARD.by,
      action: () => { change(pick(kind)); draw(control.dataset.card); } })), control, { nested: true });
  };
  card.addEventListener('click', e => {
    const control = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-card]'));
    const what = control?.dataset.card;
    if (!control || !what) return;
    if (what === CARD.keep) keep = /** @type {HTMLInputElement} */ (control).checked;
    else if (what === CARD.by) pickAgent(control, options.agents, kind => ({ by: kind }));
    else if (what === CARD.add) {
      const left = reviewersFor(plan.by, options.reviewers).filter(kind => !plan.reviewers.includes(kind));
      if (left.length > 1) return pickAgent(control, left, kind => ({ reviewers: [...plan.reviewers, kind] }));
      change({ reviewers: [...plan.reviewers, ...left] });
      draw(CARD.start);
    } else if (what === CARD.start) {
      closePopover(card);
      options.start(plan, keep);
    } else if (CHANGES[what]) {
      change(CHANGES[what](plan, control));
      draw(what);
    }
  });
  openPopover(card, at, { dynamic: true, refocus: () => at.focus() });
  draw();
}
