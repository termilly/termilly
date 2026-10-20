// @ts-check
// Claude Code's subagents as rows under their terminal in the sidebar: what each is, what it's doing, how long it's
// been running, and whether it's done. From the hooks (PageHost posts "subagent"): an Agent call says what it starts
// and, once it has, the subagent's id; SubagentStart and SubagentStop bracket it (SubagentStart doesn't always come);
// its own tool events carry its id. See research_notes/claude-subagent-hooks.md.

import { HOST } from './protocol.js';
import { onHost } from './host.js';
import { state, on, activityChanged, EVENTS } from './store.js';
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

/** How long a finished subagent keeps its own row before folding into "N done". */
const SHOW_DONE_MS = 30_000;
/** How long after that the sidebar redraws to fold it, so it's old by then. */
const FOLD_AFTER_MS = 100;
/** How often the running times tick. */
const TICK_MS = SECOND_MS;

/** A subagent row's state (also its class): running, done, or not known to have finished (the session ended). */
const ROW_STATE = Object.freeze({ running: 'running', done: 'done', unknown: 'unknown' });

/**
 * A terminal's subagents (tab.subagents): the rows by agent id, the Agent calls waiting for their ids, and whether the
 * finished ones are unfolded.
 * @typedef {{ rows: Map<string, SubagentRow>, launches: Map<string, Launch>, open: boolean }} Subagents
 */

/**
 * A terminal's subagents, kept here: the rows by agent id (oldest first), the Agent calls waiting for their
 * subagent's id (by tool use id: { description, type, background }), and whether the finished ones are unfolded.
 * @param {Tab} tab
 * @returns {{ rows: Map<string, SubagentRow>, launches: Map<string, Launch>, open: boolean }}
 */
const subagentsOf = tab => (tab.subagents ??= { rows: new Map(), launches: new Map(), open: false });
/** @param {Tab} tab */
const listOf = tab => subagentsOf(tab).rows;
/** @param {Tab} tab */
const launchesOf = tab => subagentsOf(tab).launches;

/**
 * @param {Tab} tab
 * @param {string} agentId
 * @param {Partial<SubagentRow>} fields
 */
function upsert(tab, agentId, fields) {
  const list = listOf(tab);
  const row = list.get(agentId) ?? { id: agentId, state: ROW_STATE.running, startedAt: Date.now() };
  Object.assign(row, Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null)));
  list.set(agentId, row);
  return row;
}

onHost(HOST.subagent, m => {
  const tab = state.tabs.get(m.id);
  if (!tab) return;
  if (m.event === HOOK_EVENT.preToolUse && !m.agentId && m.toolUseId) {
    // The main conversation starts one: what it is, until the call says which id it got.
    launchesOf(tab).set(m.toolUseId, { description: m.description, type: m.subagentType, background: m.background });
  } else if (m.event === HOOK_EVENT.postToolUse && !m.agentId && m.toolUseId && m.launchedId) {
    const launch = /** @type {Partial<Launch>} */ (launchesOf(tab).get(m.toolUseId) ?? {});
    launchesOf(tab).delete(m.toolUseId);
    upsert(tab, m.launchedId, { description: launch.description ?? m.description, type: launch.type ?? m.subagentType, background: launch.background ?? m.background });
  } else if (m.event === HOOK_EVENT.subagentStart && m.agentId) {
    upsert(tab, m.agentId, { type: m.agentType });
  } else if (m.event === HOOK_EVENT.subagentStop && m.agentId) {
    upsert(tab, m.agentId, { type: m.agentType, state: ROW_STATE.done, endedAt: Date.now(), tool: null, line: null, result: m.message?.split(/\r?\n/).find(l => l.trim()) });
    setTimeout(() => activityChanged(tab, true), SHOW_DONE_MS + FOLD_AFTER_MS); // folds into "N done"
  } else if (m.agentId && (m.event === HOOK_EVENT.preToolUse || m.event === HOOK_EVENT.postToolUse)) {
    // The subagent's own tools: the one it's using now, as the activity line says it.
    const row = upsert(tab, m.agentId, { type: m.agentType });
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

// The session ended: subagents still listed never said they finished.
onHost(HOST.agent, m => {
  if (m.state !== AGENT_STATE.exited) return;
  const tab = state.tabs.get(m.id);
  if (!tab?.subagents?.rows.size) return;
  for (const row of tab.subagents.rows.values()) if (row.state === ROW_STATE.running) Object.assign(row, { state: ROW_STATE.unknown, endedAt: Date.now() });
  tab.subagents.launches.clear();
  // The list clears a little later, so the end can still be seen.
  setTimeout(() => {
    if (tab.agent) return; // a new session started meanwhile
    subagentsOf(tab).rows.clear();
    activityChanged(tab, true);
  }, SHOW_DONE_MS);
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
 * The rows under a terminal in the sidebar: running and just-finished ones, then "N done" (it expands).
 * @param {Tab} tab
 */
export function subagentRowsHtml(tab) {
  const rows = [.../** @type {Iterable<SubagentRow>} */ (tab.subagents?.rows.values() ?? [])];
  if (!rows.length) return '';
  const now = Date.now();
  /** @param {SubagentRow} r */
  const isOld = r => r.state !== ROW_STATE.running && now - (r.endedAt ?? now) >= SHOW_DONE_MS;
  const old = rows.filter(isOld).length;
  const { open } = subagentsOf(tab);
  const shown = open ? rows : rows.filter(r => !isOld(r));
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
  const fold = old ? `<div class="sub-row sub-fold" data-sub-fold="${tab.id}">${open ? 'Hide' : ''} ${old} done</div>` : '';
  return `<div class="sub-rows">${shown.map(row).join('')}${fold}</div>`;
}

/**
 * "N done" expands (and folds back).
 * @param {Tab} tab
 */
export function toggleFold(tab) {
  subagentsOf(tab).open = !subagentsOf(tab).open;
  activityChanged(tab, true);
}

// Running times tick without redrawing the sidebar.
setInterval(() => {
  for (const el of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.sub-time[data-since]'))) {
    const since = Number(el.dataset.since);
    if (since) el.textContent = clock(Date.now() - since);
  }
}, TICK_MS);

on(EVENTS.tabClosed, tab => tab?.subagents?.rows.clear());

// What a subagent has cost, from its own transcript.
onHost(HOST.subagentCost, m => {
  const tab = state.tabs.get(m.id);
  const row = tab?.subagents?.rows.get(m.agentId);
  if (!row) return;
  Object.assign(row, { usd: m.usd ?? null, tokens: (m.input ?? 0) + (m.output ?? 0), model: m.model ?? null });
  activityChanged(/** @type {Tab} */ (tab), true);
});
