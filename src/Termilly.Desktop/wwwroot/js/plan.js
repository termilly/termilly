// @ts-check
// The agents' accounts and their usage limits, as the host reports them: the Claude plan's name ('claude auth status')
// and the 5-hour and weekly windows from Claude Code's status line, and Codex's from its session files. They're the
// account's, so every terminal of that agent shows the latest; EVENTS.planChanged says they moved.

import { HOST } from './protocol.js';
import { onHost } from './host.js';
import { emit, EVENTS } from './store.js';
import { AGENT_KIND } from './constants.js';

/** The plan's usage windows: the 5-hour one and the weekly one. */
export const PLAN_WINDOW = Object.freeze({ fiveHour: 'fiveHour', sevenDay: 'sevenDay' });

/** @typedef {{ used: number, resetsAt: number | null }} PlanWindow */
/** @typedef {{ fiveHour: PlanWindow | null, sevenDay: PlanWindow | null, at: number }} PlanLimits */
/** @typedef {{ subscription: string | null, authMethod: string | null }} Plan */

/** @type {PlanLimits | null} */
let limits = null;
/** @type {PlanLimits | null} */
let codexLimits = null;
/** @type {Plan | null} */
let plan = null;

/** @param {{ fiveHour?: PlanWindow | null, sevenDay?: PlanWindow | null }} m */
const limitsOf = m => ({ fiveHour: m.fiveHour ?? null, sevenDay: m.sevenDay ?? null, at: Date.now() });

onHost(HOST.claudeLimits, m => {
  limits = limitsOf(m);
  emit(EVENTS.planChanged);
});

onHost(HOST.codexLimits, m => {
  codexLimits = limitsOf(m);
  emit(EVENTS.planChanged);
});

onHost(HOST.claudePlan, m => {
  plan = { subscription: m.subscription ?? null, authMethod: m.authMethod ?? null };
  emit(EVENTS.planChanged);
});

/**
 * An agent's plan limits ({ fiveHour, sevenDay }, and when they came: at), or null before any came.
 * @param {string} [kind] the agent (AGENT_KIND); Claude Code when not said
 */
export const planLimits = (kind = AGENT_KIND.claude) => (kind === AGENT_KIND.codex ? codexLimits : limits);

/** Whether limits came for any agent (so the figures' age is worth redrawing). */
export const anyLimits = () => !!(limits || codexLimits);

/** The plan ({ subscription, authMethod }), or null before Termilly asked. */
export const currentPlan = () => plan;

/** Whether the account is on a Pro or Max plan (its limits or plan name came): costs are then "API value". */
export const isSubscription = () => !!(plan?.subscription || limits?.fiveHour || limits?.sevenDay);
