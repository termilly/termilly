// @ts-check
// Keeps the plans' 5-hour and weekly limits fresh in the status bar (Settings › Terminal › Status bar › Keep limits
// up to date): while Termilly is in front and a terminal runs the agent, its limits are asked for once they're old.
// Codex's cost nothing (its app server says them); Claude's take a tiny Haiku prompt, so they're asked for at most every
// 15 minutes, and Claude's own replies keep them fresh for free meanwhile (Features/PlanRefresh.cs).

import { PAGE } from './protocol.js';
import { send } from './host.js';
import { state, runningAgent, on, EVENTS } from './store.js';
import { planLimits } from './plan.js';
import { MINUTE_MS, SECOND_MS, debounce } from './util.js';
import { AGENT_KIND } from './constants.js';

/** How old an agent's limits may get before they're asked for again. */
/** @type {Readonly<Record<string, number>>} */
const MAX_AGE_MS = Object.freeze({ [AGENT_KIND.claude]: 15 * MINUTE_MS, [AGENT_KIND.codex]: 5 * MINUTE_MS });
/** How often the figures' age is looked at, and how soon after an agent starts in a terminal. */
const CHECK_MS = MINUTE_MS;
const SOON_MS = 2 * SECOND_MS;

/** When each agent's limits were last asked for. @type {Map<string, number>} */
const asked = new Map();

/** @param {string} kind */
const wanted = kind => {
  const a = state.settings.agents;
  return !!(state.settings.terminal.statusBar !== false && a.integration && a.claudeLimits && a.refreshLimits
    && (kind === AGENT_KIND.codex ? a.codexUsage : a.claudeUsage));
};

/** The agents running in some terminal now. */
const agentsRunning = () => new Set([...state.tabs.values()].map(t => runningAgent(t)).filter(Boolean));

function check() {
  if (!document.hasFocus()) return;
  const now = Date.now();
  for (const kind of agentsRunning()) {
    if (!kind || !wanted(kind)) continue;
    const maxAge = MAX_AGE_MS[kind] ?? MAX_AGE_MS[AGENT_KIND.claude];
    const came = planLimits(kind)?.at ?? 0;
    if (now - came < maxAge || now - (asked.get(kind) ?? 0) < maxAge) continue;
    asked.set(kind, now);
    send(PAGE.limitsRefresh, { agent: kind });
  }
}

setInterval(check, CHECK_MS);
addEventListener('focus', check);
// An agent starting in a terminal (its program seen, or its first hook) shows its plan's limits right away.
on(EVENTS.tab, debounce(check, SOON_MS));
on(EVENTS.settings, debounce(check, SOON_MS));
