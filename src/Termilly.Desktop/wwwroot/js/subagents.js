// @ts-check
// Claude Code's subagents as rows under their terminal in the sidebar: what each is, what it's doing and how long it's
// been running. From the hooks (PageHost posts "subagent"): an Agent call says what it starts and, once it has, the
// subagent's id; SubagentStart and SubagentStop bracket it (SubagentStart doesn't always come); its own tool events
// carry its id. A finished one shows its ✓ for a moment, then leaves the list. See research_notes/claude-subagent-hooks.md.

import { HOST } from './protocol.js';
import { onHost } from './host.js';
import { state, on, activityChanged, EVENTS, TURN_ENDS } from './store.js';
import { escapeHtml } from './ui.js';
import { activityLine } from './agentline.js';
import { dollars, costMode } from './cost.js';
import { AGENT_STATE, CLAUDE_TOOL, HOOK_EVENT, SETTING_VALUES } from './constants.js';
import { SECOND_MS, MINUTE_S, HOUR_S } from './util.js';

/** The choices of the settings used here (C#'s SettingValues). */
const { costDisplay } = SETTING_VALUES;

/**
 * One subagent's row: what it is, what it's doing and, once known, what it cost.
 * @typedef {{ id: string, state: string, startedAt: number, endedAt?: number, type?: string | null,
 *   description?: string | null, background?: boolean, tool?: string | null, line?: string | null,
 *   result?: string, needsYou?: boolean, usd?: number | null, tokens?: number, model?: string | null }} SubagentRow
 */

/**
 * An Agent call waiting for its subagent's id.
 * @typedef {{ description: string | null, type: string | null, background: boolean }} Launch
 */

/** How long a finished subagent's row stays, with its ✓, before it leaves the list. */
export const SHOW_DONE_MS = 4 * SECOND_MS;
/** How often the running times tick. */
const TICK_MS = SECOND_MS;

/** A subagent row's state (also its class): running, done, or not known to have finished (the session ended). */
export const ROW_STATE = Object.freeze({ running: 'running', done: 'done', unknown: 'unknown' });

/**
 * A terminal's subagents (tab.subagents): the rows by agent id, the Agent calls waiting for their ids, and the ids
 * that have finished (a late event for one doesn't bring its row back).
 * @typedef {{ rows: Map<string, SubagentRow>, launches: Map<string, Launch>, finished: Set<string> }} Subagents
 */

/**
 * A terminal's subagents, kept here: the rows by agent id (oldest first), the Agent calls waiting for their
 * subagent's id (by tool use id: { description, type, background }), and the ids that have finished.
 * @param {Tab} tab
 * @returns {Subagents}
 */
const subagentsOf = tab => (tab.subagents ??= { rows: new Map(), launches: new Map(), finished: new Set() });
/** @param {Tab} tab */
const listOf = tab => subagentsOf(tab).rows;
/** @param {Tab} tab */
const launchesOf = tab => subagentsOf(tab).launches;

/**
 * @param {Tab} tab
 * @param {string} agentId
 * @param {Partial<SubagentRow>} fields
 * @returns {SubagentRow | null} null for a subagent that has already finished
 */
function upsert(tab, agentId, fields) {
  if (subagentsOf(tab).finished.has(agentId)) return null;
  const list = listOf(tab);
  const row = list.get(agentId) ?? { id: agentId, state: ROW_STATE.running, startedAt: Date.now() };
  Object.assign(row, Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null)));
  list.set(agentId, row);
  return row;
}

/**
 * A subagent has finished (or, `how` unknown, isn't known to have): its row shows that for a moment, then goes.
 * @param {Tab} tab
 * @param {SubagentRow} row
 * @param {string} how ROW_STATE.done or ROW_STATE.unknown
 * @param {Partial<SubagentRow>} [fields]
 */
function finish(tab, row, how, fields = {}) {
  Object.assign(row, fields, { state: how, endedAt: Date.now(), tool: null, line: null, needsYou: false });
  subagentsOf(tab).finished.add(row.id);
  setTimeout(() => {
    if (listOf(tab).get(row.id) !== row) return;
    listOf(tab).delete(row.id);
    activityChanged(tab, true);
  }, SHOW_DONE_MS);
}

onHost(HOST.subagent, m => {
  const tab = state.tabs.get(m.id);
  if (!tab) return;
  if (m.event === HOOK_EVENT.subagentStop && m.agentId) {
    const row = upsert(tab, m.agentId, { type: m.agentType });
    if (!row) return;
    finish(tab, row, ROW_STATE.done, { result: m.message?.split(/\r?\n/).find(l => l.trim()) });
  } else if (m.event === HOOK_EVENT.preToolUse && !m.agentId && m.toolUseId) {
    // The main conversation starts one: what it is, until the call says which id it got.
    launchesOf(tab).set(m.toolUseId, { description: m.description, type: m.subagentType, background: m.background });
  } else if (m.event === HOOK_EVENT.postToolUse && !m.agentId && m.toolUseId && m.launchedId) {
    const launch = /** @type {Partial<Launch>} */ (launchesOf(tab).get(m.toolUseId) ?? {});
    launchesOf(tab).delete(m.toolUseId);
    upsert(tab, m.launchedId, { description: launch.description ?? m.description, type: launch.type ?? m.subagentType, background: launch.background ?? m.background });
  } else if (m.event === HOOK_EVENT.subagentStart && m.agentId) {
    upsert(tab, m.agentId, { type: m.agentType });
  } else if (m.agentId && (m.event === HOOK_EVENT.preToolUse || m.event === HOOK_EVENT.postToolUse)) {
    // The subagent's own tools: the one it's using now, as the activity line says it.
    const row = upsert(tab, m.agentId, { type: m.agentType });
    if (!row) return;
    if (row.state === ROW_STATE.running) {
      row.tool = m.event === HOOK_EVENT.preToolUse ? m.tool : row.tool;
      row.line = m.event === HOOK_EVENT.preToolUse ? activityLine({ event: HOOK_EVENT.preToolUse, tool: m.tool, target: m.target }) : row.line;
    }
    if (m.event === HOOK_EVENT.preToolUse && m.tool === CLAUDE_TOOL.askUserQuestion) row.needsYou = true;
    if (m.event === HOOK_EVENT.postToolUse) row.needsYou = false;
  } else if (m.event === HOOK_EVENT.permissionRequest && m.agentId) {
    upsert(tab, m.agentId, { needsYou: true });
  } else {
    return;
  }
  activityChanged(tab, true);
});

// The main conversation's turn ended (Stop, StopFailure) or a new one began: a foreground subagent still listed as
// running missed its SubagentStop, so it's done. Background ones may still be at work. The session ended: none of
// those still listed said they finished.
onHost(HOST.agent, m => {
  const tab = state.tabs.get(m.id);
  if (!tab?.subagents?.rows.size) return;
  const exited = m.state === AGENT_STATE.exited;
  const turnOver = TURN_ENDS.has(m.state) || /** @type {{ event?: string }} */ (m).event === HOOK_EVENT.userPromptSubmit;
  if (!exited && !turnOver) return;
  for (const row of tab.subagents.rows.values()) {
    if (row.state !== ROW_STATE.running) continue;
    if (exited) finish(tab, row, ROW_STATE.unknown);
    else if (!row.background) finish(tab, row, ROW_STATE.done);
  }
  if (exited) tab.subagents.launches.clear();
  activityChanged(tab, true);
});

/**
 * 0:42, 12:05, 1:02:07
 * @param {number} ms
 */
const clock = ms => {
  const s = Math.max(0, Math.floor(ms / SECOND_MS));
  const h = Math.floor(s / HOUR_S);
  const mm = String(Math.floor((s % HOUR_S) / MINUTE_S));
  const ss = String(s % MINUTE_S).padStart(2, '0');
  return h ? `${h}:${mm.padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
};

/** @type {Record<string, string>} */
const ICON = { running: '<span class="sub-spin"></span>', done: '✓', unknown: '?', error: '✗' };

/**
 * How many of a terminal's subagents are running now (the "N agents" badge).
 * @param {Tab} tab
 */
export const runningSubagents = tab =>
  [.../** @type {Iterable<SubagentRow>} */ (tab.subagents?.rows.values() ?? [])].filter(r => r.state === ROW_STATE.running).length;

/**
 * The rows under a terminal in the sidebar: running ones, and those that have just finished.
 * @param {Tab} tab
 */
export function subagentRowsHtml(tab) {
  const rows = [.../** @type {Iterable<SubagentRow>} */ (tab.subagents?.rows.values() ?? [])];
  if (!rows.length) return '';
  const now = Date.now();
  /** @param {SubagentRow} r */
  const row = r => {
    const title = [r.type, r.description, r.state === ROW_STATE.done && r.result ? `→ ${r.result}` : '', r.state === ROW_STATE.unknown ? 'not known to have finished' : '']
      .filter(Boolean).join(' · ');
    return `<div class="sub-row ${r.state}${r.needsYou ? ' needs' : ''}" data-tab="${tab.id}" title="${escapeHtml(title)}">
      <span class="sub-icon">${ICON[r.state] ?? ''}</span>
      <span class="sub-name"><b>${escapeHtml(r.type ?? 'agent')}</b>${r.description ? ` · ${escapeHtml(r.description)}` : ''}${r.background ? ' <span class="sub-bg">background</span>' : ''}</span>
      ${r.needsYou ? '<span class="sub-tool needs">needs you</span>' : r.state === ROW_STATE.running && r.tool ? `<span class="sub-tool" title="${escapeHtml(r.line ?? r.tool)}">${escapeHtml(r.tool)}</span>` : ''}
      ${r.usd != null && costMode() === costDisplay.cost ? `<span class="sub-cost" title="Estimated from its transcript${r.model ? ` (${escapeHtml(r.model)})` : ''}">${dollars(r.usd)}</span>` : ''}
      <span class="sub-time" data-since="${r.state === ROW_STATE.running ? r.startedAt : ''}">${clock((r.endedAt ?? now) - r.startedAt)}</span>
    </div>`;
  };
  return `<div class="sub-rows">${rows.map(row).join('')}</div>`;
}

// Running times tick without redrawing the sidebar.
setInterval(() => {
  for (const el of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.sub-time[data-since]'))) {
    const since = Number(el.dataset.since);
    if (since) el.textContent = clock(Date.now() - since);
  }
}, TICK_MS);

on(EVENTS.tabClosed, tab => tab?.subagents?.rows.clear());
// A new session: its subagents' ids are new too.
onHost(HOST.agent, m => {
  if (/** @type {{ event?: string }} */ (m).event === HOOK_EVENT.sessionStart) state.tabs.get(m.id)?.subagents?.finished.clear();
});

// What a subagent has cost, from its own transcript.
onHost(HOST.subagentCost, m => {
  const tab = state.tabs.get(m.id);
  const row = tab?.subagents?.rows.get(m.agentId);
  if (!row) return;
  Object.assign(row, { usd: m.usd ?? null, tokens: (m.input ?? 0) + (m.output ?? 0), model: m.model ?? null });
  activityChanged(/** @type {Tab} */ (tab), true);
});
