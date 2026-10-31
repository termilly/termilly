// @ts-check
// Settings › Privacy & security › History: what history keeps and the space it takes (HistoryManager.cs), the largest
// terminals, a warning size, and ways to clear part of it (js/historyclear.js) or export it.

import { state, wsById, tabTitle, getSetting, emit, GROUPS, EVENTS } from '../store.js';
import { ICONS, escapeHtml, badgeHtml } from '../ui.js';
import { updateSettings } from '../preferences.js';
import { row, toggle } from './controls.js';
import { SECTION, redrawIfShowing } from './page.js';
import { SETTING_VALUES } from '../constants.js';
import { HISTORY_DAYS, FOREVER } from './privacy.js';
import { HISTORY_KIND, askStats, formatBytes, formatLines, formatCount, formatDate } from '../historysize.js';
import { clearKind, removeTerminal, clearBeforeDate, clearByGroup, exportHistory, clearEverything } from '../historyclear.js';

const { historyDays, historyWarnGb } = SETTING_VALUES;

/** Each kind's row: its colour, name and what it is. */
const KIND_ROWS = [
  [HISTORY_KIND.closed, 'var(--history-closed)', 'Closed terminals', 'with their output'],
  [HISTORY_KIND.earlier, 'var(--history-earlier)', 'Earlier output', 'of the open terminals'],
  [HISTORY_KIND.snapshot, 'var(--history-snapshot)', 'Restart snapshot', 'what open terminals show now'],
  [HISTORY_KIND.commands, 'var(--history-commands)', 'Commands run', 'on this PC'],
  [HISTORY_KIND.synced, 'var(--history-synced)', 'Commands from other PCs', ''],
];
/** The bar's thinnest slice (percent), so a small kind still shows. */
const LEAST_SLICE = 0.6;
const PERCENT = 100;
const WARN_GB = '[data-warn-gb]';

/** @type {import('../historysize.js').Stats | null} */
let stats = null;
let asking = false;

/** Asks the host for the summary; the page draws again when it comes. */
export async function refreshHistory() {
  if (asking) return;
  asking = true;
  try {
    stats = await askStats();
  } finally {
    asking = false;
  }
  redrawIfShowing(SECTION.history);
}

/** @param {number} days */
const keptFor = days => (days === historyDays.forever ? FOREVER : days % historyDays.daysPerMonth === 0
  ? `${days / historyDays.daysPerMonth} month${days === historyDays.daysPerMonth ? '' : 's'}` : `${days} day${days === 1 ? '' : 's'}`);

/** @param {import('../historysize.js').Stats} s */
function totalsHtml(s) {
  const days = getSetting(HISTORY_DAYS);
  return `<div class="hist-totals">
    <div class="hist-total"><div class="hist-lbl">On disk</div><div class="hist-val">${formatBytes(s.total)}</div><div class="hist-sub">encrypted, on this PC only</div></div>
    <div class="hist-total"><div class="hist-lbl">Oldest</div><div class="hist-val">${s.oldest ? formatDate(s.oldest) : 'Nothing yet'}</div><div class="hist-sub">${escapeHtml(s.oldestName ?? '')}</div></div>
    <div class="hist-total"><div class="hist-lbl">Keep history for</div><div class="hist-val">${keptFor(days)} <button class="link-btn" data-action="historyKeepFor">Change</button></div>
      <div class="hist-sub">${days === historyDays.forever ? 'nothing expires' : 'older history goes by itself'}</div></div>
  </div>`;
}

/** @param {import('../historysize.js').Stats} s */
function kindsHtml(s) {
  const byKind = new Map(s.kinds.map(k => [k.kind, k]));
  const sum = s.kinds.reduce((n, k) => n + k.bytes, 0) || 1;
  const synced = s.hosts.map(h => h.host).join(', ');
  const bar = KIND_ROWS.map(([kind, colour]) => `<i style="width:${Math.max(LEAST_SLICE, (byKind.get(kind)?.bytes ?? 0) / sum * PERCENT)}%;background:${colour}"></i>`).join('');
  const rows = KIND_ROWS.map(([kind, colour, name, what]) => {
    const k = byKind.get(kind) ?? { count: 0, lines: 0, bytes: 0 };
    const clear = kind === HISTORY_KIND.snapshot ? '<span class="hist-note">rewritten as you work</span>'
      : `<button class="btn small" data-history-clear="${kind}"${k.count ? '' : ' disabled'}>Clear</button>`;
    return `<tr><td><span class="hist-key" style="background:${colour}"></span>${name} <span class="hist-what">${kind === HISTORY_KIND.synced ? escapeHtml(synced) : what}</span></td>
      <td class="num">${formatCount(k.count)}</td><td class="num muted">${k.lines ? formatLines(k.lines) : ''}</td><td class="num">${formatBytes(k.bytes)}</td><td class="act">${clear}</td></tr>`;
  }).join('');
  return `<div class="hist-bar">${bar}</div><table class="hist-kinds">${rows}</table>`;
}

/** @param {import('../historysize.js').Terminal} t */
function terminalHtml(t) {
  const tab = t.open ? state.tabs.get(t.id) : null;
  const name = tab ? tabTitle(tab) : t.name ?? '';
  const ws = tab ? wsById(tab.wsId) : state.workspaces.find(w => w.name === t.workspace);
  const profile = state.profiles.find(p => p.id === (tab?.profile ?? t.profile));
  const where = tab ? ws?.name ?? '' : t.workspace ?? '';
  return `<div class="hist-term">${badgeHtml(profile)}<span class="hist-name">${escapeHtml(name)} <span class="hist-where">${ws ? `<span class="hist-dot" style="background:${ws.color}"></span>` : ''}${escapeHtml(where)}</span></span>
    <span class="hist-when">${t.open ? 'open' : t.closedAt ? `closed ${formatDate(t.closedAt)}` : ''}</span><span class="hist-size">${formatBytes(t.bytes)}</span>
    <button class="btn small" data-history-remove="${escapeHtml(t.id)}" data-open="${t.open}" title="Remove from history">${ICONS.trash}Remove</button></div>`;
}

const warnHtml = () => row('Warn me when history passes', 'A note in the window offers to free up space.',
  `<span class="field-row hist-warn">${toggle('session.historyWarn')}<input class="field keep-count" data-warn-gb type="number" min="${historyWarnGb.min}" max="${historyWarnGb.max}" value="${getSetting('session.historyWarnGb')}" aria-label="Gigabytes"><span class="muted">GB</span></span>`,
  { keywords: 'history size disk space warning limit gigabytes' });

/** @type {import('./page.js').Section} */
const HISTORY = {
  id: SECTION.history,
  parent: SECTION.privacy,
  label: 'History', icon: ICONS.history,
  tools: () => '<button class="btn small" data-action="historyBack">‹ Privacy &amp; security</button>',
  html: () => (!stats ? `<p class="set-desc set-empty">${asking ? 'Working out what history keeps.' : 'History is locked, or couldn’t be read.'}</p>${warnHtml()}`
    : `${totalsHtml(stats)}${kindsHtml(stats)}
      ${stats.largest.length ? `<h4 class="hist-h4">Largest terminals</h4><div class="hist-terms">${stats.largest.map(terminalHtml).join('')}</div>` : ''}
      ${warnHtml()}
      <div class="hist-actions"><button class="btn" data-action="historyBefore">Clear before a date</button>
        <button class="btn" data-action="historyGroups">Clear by workspace or tag</button>
        <button class="btn" data-action="historyExport">Export</button><span class="grow"></span>
        <button class="btn danger-outline" data-action="historyAll">Clear everything</button></div>`),
  refresh: refreshHistory,
  opened: refreshHistory,
  click(e) {
    const target = /** @type {HTMLElement} */ (e.target);
    const kind = /** @type {HTMLElement | null} */ (target.closest('[data-history-clear]'))?.dataset.historyClear;
    const remove = /** @type {HTMLElement | null} */ (target.closest('[data-history-remove]'));
    if (kind) clearKind(kind).then(refreshHistory);
    else if (remove) removeTerminal(/** @type {string} */ (remove.dataset.historyRemove), remove.dataset.open === 'true').then(refreshHistory);
    return !!(kind || remove);
  },
  change(e) {
    const field = /** @type {HTMLInputElement} */ (e.target);
    if (!field.matches(WARN_GB)) return false;
    const gb = Math.min(historyWarnGb.max, Math.max(historyWarnGb.min, Math.round(Number(field.value)) || historyWarnGb.default));
    field.value = String(gb);
    updateSettings(GROUPS.session, { historyWarnGb: gb });
    return true;
  },
  actions: {
    historyBack: () => emit(EVENTS.openSettings, SECTION.privacy),
    historyKeepFor: () => emit(EVENTS.openSettings, SECTION.privacy),
    historyBefore: () => clearBeforeDate(stats).then(refreshHistory),
    historyGroups: () => clearByGroup(stats).then(refreshHistory),
    historyExport: () => exportHistory(),
    historyAll: () => clearEverything().then(refreshHistory),
  },
};

export default HISTORY;
