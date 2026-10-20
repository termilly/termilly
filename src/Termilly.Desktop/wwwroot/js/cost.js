// @ts-check
// What each agent costs: Claude's own dollar figure per session (its status line, the number /cost shows), or an
// estimate from the transcript's tokens (Pricing.cs) until that comes; subagents' estimates from their own
// transcripts. Totals per workspace, and per day in a small ledger (Settings) for "today" and "this week". For Pro
// and Max plans the dollars are what the work would cost on the API, not a bill: labelled "API value".
// Settings › Terminal › Agent cost: dollars, tokens only, or off.

import { HOST } from './protocol.js';
import { onHost } from './host.js';
import { state, emit, tabsOf, wsById, activityChanged, GROUPS, EVENTS } from './store.js';
import { isSubscription } from './plan.js';
import { debounce, formatTokens, DAY_MS, MINUTE_MS, WEEK_DAYS } from './util.js';
import { updateSettings } from './preferences.js';
import { SETTING_VALUES } from './constants.js';

/** The choices of the settings used here (C#'s SettingValues). */
const { costDisplay } = SETTING_VALUES;

/**
 * A terminal's session cost, as costOf gives it.
 * @typedef {{ usd: number, estimated: boolean, durationMs: number | null, tokens: number }} Cost
 */

/** Days the ledger keeps. */
const KEEP_DAYS = 62;

/** Below half a cent, in dollars, a cost rounds to nothing and shows as "<$0.01" (or not at all on a chip). */
const HALF_CENT_USD = 0.005;
/** Below this many dollars a cost shows its cents ($3.18); below the next, one decimal ($12.4); above, none. */
const CENTS_BELOW_USD = 10;
const DIMES_BELOW_USD = 100;

/** What a cost is called when it's a bill (not a plan's "API value"). */
export const COST_LABEL = 'Cost';

const day = (ms = Date.now()) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const costMode = () => state.settings.agents.costDisplay ?? costDisplay.default;

/**
 * $0.42, $3.18, $12.4, $130
 * @param {number} usd
 */
export const dollars = usd => (usd < HALF_CENT_USD ? '<$0.01' : usd < CENTS_BELOW_USD ? `$${usd.toFixed(2)}`
  : usd < DIMES_BELOW_USD ? `$${usd.toFixed(1)}` : `$${Math.round(usd)}`);

/**
 * A terminal's session cost: { usd, estimated, durationMs, tokens } or null when no agent has run there.
 * @param {Tab} tab
 * @returns {Cost | null}
 */
export function costOf(tab) {
  const u = tab.claude?.usage;
  const tokens = u ? u.input + u.cacheWrite + u.cacheRead + u.output : 0;
  if (tab.cost && (!u || !tab.cost.session || tab.cost.session === u.session)) return { usd: tab.cost.usd, estimated: false, durationMs: tab.cost.durationMs, tokens };
  if (u?.estimatedUsd != null) return { usd: u.estimatedUsd, estimated: true, durationMs: null, tokens };
  return null;
}

/**
 * What a cost chip says ("$1.84", "38k tokens"), or '' when there's nothing or costs are hidden.
 * @param {Cost | null} cost
 */
export function costText(cost) {
  if (!cost || costMode() === costDisplay.off) return '';
  if (costMode() === costDisplay.tokens) return cost.tokens ? `${formatTokens(cost.tokens)} tok` : '';
  return cost.usd >= HALF_CENT_USD ? dollars(cost.usd) : '';
}

/**
 * Hover text: Claude's figure or an estimate, what it means on a plan, tokens and time.
 * @param {Cost | null} cost
 */
export function costTitle(cost) {
  if (!cost) return '';
  const what = isSubscription() ? 'API value (what this would cost on the API; your plan covers it)' : COST_LABEL;
  return `${what}: ${dollars(cost.usd)}${cost.estimated ? ' (estimated from tokens)' : ' (Claude’s own figure, as /cost shows)'}`
    + (cost.tokens ? ` · ${formatTokens(cost.tokens)} tokens` : '')
    + (cost.durationMs ? ` · ${Math.round(cost.durationMs / MINUTE_MS)} min` : '');
}

/**
 * The cost of a workspace's terminals now.
 * @param {Workspace} ws
 */
export const workspaceCost = ws => tabsOf(ws).reduce((sum, t) => sum + (costOf(t)?.usd ?? 0), 0);

/** Totals from the ledger: today's, and the last seven days'. */
export function ledgerTotals() {
  const ledger = state.settings.data.costLedger ?? {};
  const week = Array.from({ length: WEEK_DAYS }, (_, i) => ledger[day(Date.now() - i * DAY_MS)]?.total ?? 0).reduce((a, b) => a + b, 0);
  return { today: ledger[day()]?.total ?? 0, week, byWorkspace: ledger[day()]?.ws ?? {} };
}

// ---- The ledger: each session's growth is added to the day it happened on ----

/** @type {Record<string, CostDay> | null} */
let pending = null;
/** How long the ledger gathers status lines before it's saved. */
const SAVE_DELAY = 20_000;
const flushLater = debounce(() => flush(), SAVE_DELAY);

/**
 * @param {Tab} tab
 * @param {number} delta
 */
function addToLedger(tab, delta) {
  if (!(delta > 0)) return;
  const ledger = pending ?? structuredClone(state.settings.data.costLedger ?? {});
  const today = day();
  const entry = (ledger[today] ??= { total: 0, ws: {} });
  entry.total += delta;
  const ws = wsById(tab.wsId)?.name ?? 'other';
  // A day the host read without its workspaces (C#'s CostDay.Ws is optional) gets them from here on.
  const perWorkspace = (entry.ws ??= {});
  perWorkspace[ws] = (perWorkspace[ws] ?? 0) + delta;
  for (const key of Object.keys(ledger)) if (Date.parse(key) < Date.now() - KEEP_DAYS * DAY_MS) delete ledger[key];
  pending = ledger;
  // Saved now and then, not on every status line.
  flushLater();
}

function flush() {
  if (!pending) return;
  const ledger = pending;
  pending = null;
  updateSettings(GROUPS.data, { costLedger: ledger });
}
addEventListener('beforeunload', flush);

onHost(HOST.claudeCost, m => {
  const tab = state.tabs.get(m.id);
  if (!tab) return;
  const before = tab.cost?.session === (m.session ?? null) ? tab.cost.usd : 0;
  tab.cost = { usd: m.usd, durationMs: m.durationMs ?? null, session: m.session ?? null };
  addToLedger(tab, m.usd - before);
  emit(EVENTS.claudeUsage, tab);
  activityChanged(tab, true);
});
