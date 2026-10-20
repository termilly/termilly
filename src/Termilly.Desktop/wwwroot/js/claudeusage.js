// @ts-check
// The Claude Code session on a terminal's header: model, how full the context is and tokens written, in one small
// chip; clicking it shows the rest. The host reads the numbers from the session's transcript (ClaudeUsage.cs), and
// the plan's 5-hour and weekly limits from Claude Code's status line (Termilly.Agent/StatusLine.cs).

import { HOST } from './protocol.js';
import { onHost } from './host.js';
import { state, on, emit, wsById, EVENTS } from './store.js';
import { planLimits, currentPlan, isSubscription, PLAN_WINDOW } from './plan.js';
import { formatTokens, SECOND_MS, MINUTE_MS, HOUR_MS, DAY_MS } from './util.js';
import { costOf, costText, costTitle, costMode, dollars, workspaceCost, ledgerTotals, COST_LABEL } from './cost.js';
import { openPopover } from './popups.js';
import { escapeHtml, formatWhen } from './ui.js';
import { SETTING_VALUES } from './constants.js';

/**
 * A session's usage as the host read it from the transcript (ClaudeUsage.cs).
 * @typedef {{ session: string, model: string | null, input: number, output: number, cacheWrite: number,
 *   cacheRead: number, context: number, contextWindow: number, replies: number, compactions?: number,
 *   started?: string | null, last?: string | null, branch?: string | null, version?: string | null,
 *   estimatedUsd?: number | null }} ClaudeUsage
 */

/** @typedef {import('./plan.js').PlanLimits} PlanLimits */
/** @typedef {import('./plan.js').Plan} Plan */

/** The choices of the settings used here (C#'s SettingValues). */
const { costDisplay } = SETTING_VALUES;


/** How often the plan figures are redrawn while no new ones come. */
const REDRAW_MS = MINUTE_MS;
const MINUTES_PER_HOUR = HOUR_MS / MINUTE_MS;

/** A whole, in percent: the most a context can be full. */
const PERCENT = 100;
/** How full a context is, in percent, when its meter turns "high" and then "full". */
const HIGH_PERCENT = 70;
const FULL_PERCENT = 90;

/**
 * Claude Code's context figures from its status line, for one session.
 * @typedef {{ session: string | null, used: number, size: number, tokens: number | null }} ClaudeContext
 */
/**
 * Claude's figures for a terminal (tab.claude): from the transcript, and from the status line.
 * @typedef {{ usage: ClaudeUsage | null, context: ClaudeContext | null }} ClaudeFigures
 */

/**
 * Claude's figures for a terminal, kept here: the usage read from the session's transcript, and the context figures
 * its status line reported ({ session, used, size, tokens }).
 * @param {Tab} tab
 */
const claudeOf = tab => (tab.claude ??= { usage: null, context: null });

const redrawAll = () => {
  for (const tab of state.tabs.values()) if (tab.claude?.usage) emit(EVENTS.claudeUsage, tab);
  if (!pop.hidden && popTab) fillUsage(popTab);
};

onHost(HOST.claudeUsage, m => {
  const tab = state.tabs.get(m.id);
  if (!tab) return;
  claudeOf(tab).usage = m.usage;
  emit(EVENTS.claudeUsage, tab);
  if (!pop.hidden && popTab === tab) fillUsage(tab); // the details follow too
});

// The plan or its limits moved (plan.js).
on(EVENTS.planChanged, () => redrawAll());

// Claude Code's own context figures for a terminal's session, from its status line ({ session, used, size, tokens }).
onHost(HOST.claudeContext, m => {
  const tab = state.tabs.get(m.id);
  if (!tab) return;
  claudeOf(tab).context = { session: m.session ?? null, used: m.used, size: m.size, tokens: m.tokens ?? null };
  emit(EVENTS.claudeUsage, tab);
  if (!pop.hidden && popTab === tab) fillUsage(tab);
});

// The plan figures age while nobody's replies bring new ones: redraw now and then so "as of" and the dimming follow.
setInterval(() => { if (planLimits()) redrawAll(); }, REDRAW_MS);

/** Plan figures older than this are dimmed: use elsewhere (another terminal, claude.ai) isn't in them yet. */
const STALE_MS = 15 * MINUTE_MS;
const limitsStale = () => !!planLimits() && Date.now() - /** @type {PlanLimits} */ (planLimits()).at > STALE_MS;
/** @param {number} ms */
const clock = ms => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });


/**
 * A limit window still running (Claude Code drops one once it has reset), or null.
 * @param {'fiveHour' | 'sevenDay'} name
 */
function windowOf(name) {
  const w = state.settings.agents.claudeLimits ? planLimits()?.[name] : null;
  return w && (!w.resetsAt || w.resetsAt * SECOND_MS > Date.now()) ? w : null;
}

/**
 * As /usage puts it, "Resets 8:19 AM" (or "Resets Oct 12, 1:59 AM"), with how long that is within a day.
 * @param {number | null} resetsAt
 */
function resetText(resetsAt) {
  if (!resetsAt) return '';
  const d = new Date(resetsAt * SECOND_MS);
  const ms = d.getTime() - Date.now();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (ms >= DAY_MS) return `Resets ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
  const min = Math.max(1, Math.round(ms / MINUTE_MS));
  return `Resets ${time} · in ${min >= MINUTES_PER_HOUR ? `${Math.floor(min / MINUTES_PER_HOUR)} h ${min % MINUTES_PER_HOUR} min` : `${min} min`}`;
}

/** "max" → "Claude Max". */

/** @param {Plan | null} p */
const planName = p => (p?.subscription ? `Claude ${p.subscription[0].toUpperCase()}${p.subscription.slice(1)}` : null);

/** "claude-opus-5-5" → "Opus 5.5", "claude-sonnet-4-5-20250929" → "Sonnet 4.5", "claude-3-5-haiku-20241022" → "Haiku 3.5".
 * @param {string | null | undefined} model
 */
export function modelName(model) {
  if (!model) return 'Claude';
  const parts = model.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/\[.*\]$/, '').split('-');
  const family = parts.find(p => /^[a-z]+$/i.test(p));
  const version = parts.filter(p => /^\d{1,2}$/.test(p)).join('.');
  return family ? `${family[0].toUpperCase()}${family.slice(1)}${version ? ` ${version}` : ''}` : model;
}


/**
 * The usage for the session the terminal runs now, or null (none yet, another session, or turned off).
 * @param {Tab} tab
 * @returns {ClaudeUsage | null}
 */
export function usageOf(tab) {
  const u = tab.claude?.usage;
  if (!u || !tab.agent || !state.settings.agents.integration || !state.settings.agents.claudeUsage) return null;
  return !tab.agent.session || tab.agent.session === u.session ? u : null;
}

/**
 * How full the context is: Claude Code's own figures when its status line has reported them for this session (they
 * match its /context), else the transcript's last reply (input and cache, as Claude Code counts it).
 * @param {Tab} tab
 * @param {ClaudeUsage} u
 */
function contextOf(tab, u) {
  const c = tab.claude?.context;
  if (c && (!c.session || c.session === u.session)) {
    return { percent: Math.min(PERCENT, Math.round(c.used)), tokens: c.tokens ?? Math.round((c.used / PERCENT) * c.size), size: c.size, official: true };
  }
  return { percent: Math.min(PERCENT, Math.round((u.context / u.contextWindow) * PERCENT)), tokens: u.context, size: u.contextWindow, official: false };
}

/** @param {number} p */
const level = p => (p >= FULL_PERCENT ? 'full' : p >= HIGH_PERCENT ? 'high' : '');

/**
 * The chip's content: the model, and how full its context is (meter and percent). The rest is in the details.
 * @param {Tab} tab
 * @param {ClaudeUsage} u
 */
export function usageChipHtml(tab, u) {
  const { percent: p } = contextOf(tab, u);
  const cost = costText(costOf(tab));
  return `${cost ? `<span class="cu-cost">${escapeHtml(cost)}</span>` : ''}<span class="cu-model">${escapeHtml(modelName(u.model))}</span>
    <span class="cu-meter ${level(p)}"><i style="width:${p}%"></i></span><span class="cu-pct">${p}%</span>`;
}

/**
 * @param {Tab} tab
 * @param {ClaudeUsage} u
 */
export function usageTitle(tab, u) {
  const ctx = contextOf(tab, u);
  const five = windowOf(PLAN_WINDOW.fiveHour);
  return `${modelName(u.model)} · context ${formatTokens(ctx.tokens)} of ${formatTokens(ctx.size)} · ${formatTokens(u.output)} tokens written`
    + (five ? ` · ${Math.round(five.used)}% of the plan's 5-hour limit used, as of ${clock(/** @type {PlanLimits} */ (planLimits()).at)}` : '') + '. Click for details.';
}

/**
 * Cost in the details: this session (Claude's figure or an estimate), its workspace, today and this week.
 * @param {Tab} tab
 * @param {(label: string, value: string) => string} row
 */
function costRowsHtml(tab, row) {
  const cost = costOf(tab);
  if (!cost || costMode() === costDisplay.off) return '';
  const { today, week } = ledgerTotals();
  const label = isSubscription() ? 'API value' : COST_LABEL;
  return `<div class="cu-rows cu-cost-rows" title="${escapeHtml(costTitle(cost))}">
      ${row(`${label}, this session${cost.estimated ? ' (est.)' : ''}`, dollars(cost.usd))}
      ${row('This workspace now', dollars(workspaceCost(/** @type {Workspace} */ (wsById(tab.wsId)))))}
      ${row('Today, all terminals', dollars(today))}
      ${row('Last 7 days', dollars(week))}
      ${isSubscription() ? '<div class="cu-reset cu-note">On a Pro or Max plan this is what the work would cost on the API, not a bill.</div>' : ''}
    </div>`;
}

/** The plan's limits in the details: a meter and reset time per window, under the plan's name. */
function limitsHtml() {
  // Only the windows still running are kept.
  const windows = /** @type {[import('./plan.js').PlanWindow, string][]} */ (
    /** @type {['fiveHour' | 'sevenDay', string][]} */ ([[PLAN_WINDOW.fiveHour, 'Current session'], [PLAN_WINDOW.sevenDay, 'Current week (all models)']])
      .map(([name, label]) => [windowOf(name), label]).filter(([w]) => w));
  const name = planName(currentPlan());
  if (!state.settings.agents.claudeLimits) return '';
  return `<div class="cu-plan">
      <div class="cu-plan-head">Plan usage${name ? `<b>${escapeHtml(name)}</b>` : ''}</div>
      ${windows.length ? `<div class="cu-reset${limitsStale() ? ' stale' : ''}">As of ${clock(/** @type {PlanLimits} */ (planLimits()).at)} · updated with Claude’s replies</div>` : ''}
      ${windows.map(([w, label]) => `
        <div class="cu-limit-row"><span>${label}</span><b>${Math.round(w.used)}% used</b></div>
        <div class="cu-meter big ${level(w.used)}"><i style="width:${Math.min(PERCENT, w.used)}%"></i></div>
        <div class="cu-reset">${escapeHtml(resetText(w.resetsAt))}</div>`).join('')}
      ${windows.length
        ? '<div class="cu-reset cu-note">Per-model limits, and the very latest figures: <code>/usage</code> in Claude.</div>'
        : '<div class="cu-reset cu-note">The 5-hour and weekly limits come with Claude’s next reply (Pro and Max plans). If they don’t, restart <code>claude</code> in this terminal.</div>'}
    </div>`;
}

const pop = document.createElement('section');
pop.className = 'popover cu-pop';
pop.hidden = true;

/** @type {Tab | null} */
let popTab = null;

/**
 * The session's details, under the chip.
 * @param {Tab} tab
 * @param {import('./popups.js').Anchor} anchor
 */
export function openUsage(tab, anchor) {
  if (!fillUsage(tab)) return;
  popTab = tab;
  openPopover(pop, anchor, { dynamic: true, onClose: () => { popTab = null; } });
}

/** @param {Tab} tab */
function fillUsage(tab) {
  const u = usageOf(tab);
  if (!u) return false;
  const ctx = contextOf(tab, u);
  const p = ctx.percent;
  /**
   * @param {string} label
   * @param {string} value
   */
  const row = (label, value) => `<div class="cu-row"><span>${label}</span><b>${value}</b></div>`;
  pop.innerHTML = `
    <div class="cu-head">${escapeHtml(modelName(u.model))}<span>${escapeHtml(u.model ?? '')}</span></div>
    <div class="cu-ctx">
      <div class="cu-meter big ${level(p)}"><i style="width:${p}%"></i></div>
      <div class="cu-ctx-text" title="${ctx.official ? 'As Claude Code reports it (its status line, after the last reply)' : 'From the transcript’s last reply; Claude Code’s own figure follows its next status line'}">Context <b>${formatTokens(ctx.tokens)}</b> of ${formatTokens(ctx.size)} · ${p}%${u.compactions ? ` · compacted ${u.compactions}×` : ''}</div>
    </div>
    <div class="cu-rows">
      ${row('Written (output)', formatTokens(u.output))}
      ${row('Read fresh (input)', formatTokens(u.input))}
      ${row('Cache written', formatTokens(u.cacheWrite))}
      ${row('Cache read', formatTokens(u.cacheRead))}
      ${row('Replies', u.replies.toLocaleString())}
    </div>
    ${costRowsHtml(tab, row)}
    ${limitsHtml()}
    <div class="cu-rows">
      ${u.started ? row('Started', escapeHtml(formatWhen(Date.parse(u.started)))) : ''}
      ${u.last ? row('Last reply', escapeHtml(formatWhen(Date.parse(u.last)))) : ''}
      ${u.branch ? row('Branch', escapeHtml(u.branch)) : ''}
      ${u.version ? row('Claude Code', escapeHtml(u.version)) : ''}
      ${row('Session', `<span class="cu-id" title="${escapeHtml(u.session)}">${escapeHtml(u.session.slice(0, 8))}</span>`)}
    </div>`;
  return true;
}
