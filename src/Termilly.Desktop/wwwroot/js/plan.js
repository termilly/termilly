// @ts-check
// The Claude account's plan and its usage limits, as the host reports them: the plan's name ('claude auth status')
// and the 5-hour and weekly windows from Claude Code's status line. They're the account's, so every Claude terminal
// shows the latest; EVENTS.planChanged says they moved.

import { HOST } from './protocol.js';
import { onHost } from './host.js';
import { emit, EVENTS } from './store.js';

/** The plan's usage windows: the 5-hour one and the weekly one. */
export const PLAN_WINDOW = Object.freeze({ fiveHour: 'fiveHour', sevenDay: 'sevenDay' });

/** @typedef {{ used: number, resetsAt: number | null }} PlanWindow */
/** @typedef {{ fiveHour: PlanWindow | null, sevenDay: PlanWindow | null, at: number }} PlanLimits */
/** @typedef {{ subscription: string | null, authMethod: string | null }} Plan */

/** @type {PlanLimits | null} */
let limits = null;
/** @type {Plan | null} */
let plan = null;

onHost(HOST.claudeLimits, m => {
  limits = { fiveHour: m.fiveHour ?? null, sevenDay: m.sevenDay ?? null, at: Date.now() };
  emit(EVENTS.planChanged);
});

onHost(HOST.claudePlan, m => {
  plan = { subscription: m.subscription ?? null, authMethod: m.authMethod ?? null };
  emit(EVENTS.planChanged);
});

/** The plan's limits ({ fiveHour, sevenDay }, and when they came: at), or null before any came. */
export const planLimits = () => limits;

/** The plan ({ subscription, authMethod }), or null before Termilly asked. */
export const currentPlan = () => plan;

/** Whether the account is on a Pro or Max plan (its limits or plan name came): costs are then "API value". */
export const isSubscription = () => !!(plan?.subscription || limits?.fiveHour || limits?.sevenDay);
