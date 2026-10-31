// @ts-check
// Clearing part of history (Settings › Privacy › History, js/settings/history.js) and exporting it. Each dialog asks
// the host first what its choices would take (a dry run) and says so on its button; only then does anything go.

import { send, request, onHost } from './host.js';
import { PAGE, HOST } from './protocol.js';
import { state, emit, tabTitle, wsById, EVENTS } from './store.js';
import { modal, confirmDialog } from './dialogs.js';
import { escapeHtml } from './ui.js';
import { showToast, TOAST } from './toasts.js';
import { DAY_MS } from './util.js';
import { HISTORY_KIND, openIds, askStats, removeHistory, formatBytes, formatCount, removalLines } from './historysize.js';

/** @typedef {import('./historysize.js').Stats} Stats */
/** @typedef {import('./historysize.js').Plan} Plan */
/** @typedef {import('./historysize.js').Removal} Removal */

const HISTORY_DIALOG = 'history-clear';
/** How long choosing pauses before the host is asked what it would take. */
const ASK_AFTER_MS = 120;
/** The dialogs' parts. */
const PART = Object.freeze({ result: '[data-result]', go: '[data-ok]', chip: '[data-chip]', kind: '[data-kind]', date: '[data-date]', ws: '[data-ws]', tag: '[data-tag]', keepOpen: '[data-keep-open]', option: '[data-option]', months: '[data-months]' });
const ON = 'on';
/** The shortcuts for a date: days back. */
const SHORTCUTS = [[7, 'Older than 1 week'], [30, '1 month'], [90, '3 months'], [365, '1 year']];
const DEFAULT_SHORTCUT = 90;
/** Free up space: how far back each option reaches, in months; and how many of the largest terminals the third takes. */
const MONTHS = [1, 3, 6, 12];
const EARLIER_MONTHS = 3;
const OUTPUT_MONTHS = 6;
const DAYS_PER_MONTH = 30;
/** Free up space's options (data-option, data-months). */
const OPTION = Object.freeze({ earlier: 'earlier', output: 'output', largest: 'largest' });

/** Everything that can be cleared, for the open terminals as they are. */
const everything = () => ({ kinds: [HISTORY_KIND.closed, HISTORY_KIND.earlier, HISTORY_KIND.commands, HISTORY_KIND.synced], earlierIds: openIds() });

/**
 * Asks to confirm, saying what a plan takes, then clears it. Resolves true when it went.
 * @param {string} title
 * @param {Plan} plan
 */
async function confirmPlan(title, plan) {
  const would = await removeHistory(plan, true);
  if (!would || !would.bytes && !removalLines(would).length) {
    showToast({ text: 'Nothing to clear.' });
    return false;
  }
  if (!await confirmDialog({ title, body: `${removalLines(would).join('. ')}. ${formatBytes(would.bytes)} in all. This can’t be undone.`, confirm: `Remove ${formatBytes(would.bytes)}` })) return false;
  return apply([plan]);
}

/**
 * Clears plans one after the other, then says what went.
 * @param {Plan[]} plans
 */
async function apply(plans) {
  let bytes = 0;
  for (const plan of plans) bytes += (await removeHistory(plan, false))?.bytes ?? 0;
  emit(EVENTS.history);
  showToast({ text: `Removed ${formatBytes(bytes)} from history.` });
  return true;
}

/**
 * A row's Clear: one kind of history.
 * @param {string} kind
 */
export function clearKind(kind) {
  /** @type {Record<string, string>} */
  const names = { [HISTORY_KIND.closed]: 'closed terminals', [HISTORY_KIND.earlier]: 'earlier output of open terminals', [HISTORY_KIND.commands]: 'commands run', [HISTORY_KIND.synced]: 'commands from other PCs' };
  const plan = kind === HISTORY_KIND.earlier ? { kinds: [kind], earlierIds: openIds() } : { kinds: [kind] };
  return confirmPlan(`Clear ${names[kind] ?? 'this'}?`, plan);
}

/**
 * A largest terminal's Remove: a closed one goes from history; an open one loses only its earlier output.
 * @param {string} id
 * @param {boolean} open
 */
export function removeTerminal(id, open) {
  const tab = open ? state.tabs.get(id) : null;
  return confirmPlan(open ? `Remove the earlier output of ${tab ? tabTitle(tab) : 'this terminal'}?` : 'Remove this terminal from history?',
    open ? { kinds: [HISTORY_KIND.earlier], earlierIds: [id] } : { ids: [id] });
}

/** Clear everything: what open terminals show now stays. */
export const clearEverything = () => confirmPlan('Clear all history?', everything());

/**
 * A dialog whose choices make plans: the box under them says what they'd take, the button how much.
 * @param {string} html
 * @param {(dialog: HTMLElement) => Plan[]} plansOf What the dialog's choices clear.
 * @param {(dialog: HTMLElement) => void} [wire] Its own controls (chips that set a date, and so on).
 */
function planDialog(html, plansOf, wire) {
  return modal(HISTORY_DIALOG, html, (dialog, close) => {
    const result = /** @type {HTMLElement} */ (dialog.querySelector(PART.result));
    const go = /** @type {HTMLButtonElement} */ (dialog.querySelector(PART.go));
    let timer = 0, asked = 0;
    const update = () => {
      clearTimeout(timer);
      timer = window.setTimeout(async () => {
        const ask = ++asked;
        const plans = plansOf(dialog);
        const found = await Promise.all(plans.map(p => removeHistory(p, true)));
        if (ask !== asked) return;
        const bytes = found.reduce((n, r) => n + (r?.bytes ?? 0), 0);
        const lines = found.flatMap(r => (r ? removalLines(r) : []));
        result.innerHTML = lines.length ? `<b>Removes ${formatBytes(bytes)}</b><ul>${lines.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul>${result.dataset.keeps ? `<div class="hist-keeps">${escapeHtml(result.dataset.keeps)}</div>` : ''}`
          : '<b>Nothing to remove</b>';
        go.disabled = !lines.length;
        go.textContent = lines.length ? `Remove ${formatBytes(bytes)}` : 'Remove';
      }, ASK_AFTER_MS);
    };
    wire?.(dialog);
    dialog.addEventListener('click', e => {
      if (/** @type {HTMLElement} */ (e.target).closest('select, input')) return;
      const t = /** @type {HTMLElement} */ (e.target).closest(`${PART.chip}, ${PART.kind}, ${PART.ws}, ${PART.tag}, ${PART.keepOpen}, ${PART.option}`);
      if (t && !t.matches(PART.chip)) t.classList.toggle(ON);
      if (t) update();
    });
    dialog.addEventListener('change', update);
    update();
    return { submit: () => { if (!go.disabled) apply(plansOf(dialog)).then(() => close(true)); } };
  });
}

/**
 * A row to tick: its name and what it holds.
 * @param {string} attr
 * @param {string} value
 * @param {string} label
 * @param {string} detail
 * @param {boolean} on
 */
const tick = (attr, value, label, detail, on) => `<button class="hist-pick${on ? ` ${ON}` : ''}" ${attr}="${escapeHtml(value)}"><span class="hist-check"></span><span class="grow">${label}</span><span class="hist-num">${detail}</span></button>`;

/** @param {HTMLElement} dialog @param {string} sel */
const picked = (dialog, sel) => [...dialog.querySelectorAll(`${sel}.${ON}`)].map(el => /** @type {HTMLElement} */ (el).getAttribute(sel.slice(1, -1)) ?? '');

/** A date as a date field holds it (yyyy-mm-dd). */
const DATE_LENGTH = 10;
/** @param {number} ms */
const isoDay = ms => new Date(ms).toISOString().slice(0, DATE_LENGTH);

/**
 * Clear before a date: a shortcut or a date, and which kinds.
 * @param {Stats | null} stats
 */
export function clearBeforeDate(stats) {
  const kinds = new Map((stats?.kinds ?? []).map(k => [k.kind, k]));
  const has = (/** @type {string} */ k) => { const x = kinds.get(k); return x ? `<b>${formatCount(x.count)}</b> · ${formatBytes(x.bytes)}` : ''; };
  return planDialog(`<h3>Clear before a date</h3><p class="dialog-sub">What was kept before the date goes. Everything after it stays.</p>
    <div class="hist-chips">${SHORTCUTS.map(([days, label]) => `<button class="hist-chip${days === DEFAULT_SHORTCUT ? ` ${ON}` : ''}" data-chip="${days}">${label}</button>`).join('')}</div>
    <label class="hist-drow"><span class="hist-dlbl">Before</span><input class="field" type="date" data-date value="${isoDay(Date.now() - DEFAULT_SHORTCUT * DAY_MS)}"></label>
    <div class="hist-picks">${tick('data-kind', HISTORY_KIND.closed, 'Closed terminals', has(HISTORY_KIND.closed), true)}
      ${tick('data-kind', HISTORY_KIND.earlier, 'Earlier output of open terminals', has(HISTORY_KIND.earlier), true)}
      ${tick('data-kind', HISTORY_KIND.commands, 'Commands run', has(HISTORY_KIND.commands), false)}
      ${tick('data-kind', HISTORY_KIND.synced, 'Commands from other PCs', has(HISTORY_KIND.synced), false)}</div>
    <div class="hist-result" data-result data-keeps="Keeps what open terminals show now, and everything from the date on."></div>
    <div class="dialog-actions"><button class="btn" data-cancel>Cancel</button><button class="btn danger" data-ok>Remove</button></div>`,
  dialog => {
    const date = /** @type {HTMLInputElement} */ (dialog.querySelector(PART.date)).valueAsNumber;
    const kinds = picked(dialog, PART.kind);
    // A closed terminal newer than the date keeps its output, but not earlier output kept before the date.
    if (kinds.includes(HISTORY_KIND.closed)) kinds.push(HISTORY_KIND.closedEarlier);
    return Number.isFinite(date) && kinds.length ? [{ before: date, kinds, earlierIds: openIds() }] : [];
  },
  dialog => {
    dialog.addEventListener('click', e => {
      const chip = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest(PART.chip));
      if (!chip) return;
      for (const c of dialog.querySelectorAll(PART.chip)) c.classList.toggle(ON, c === chip);
      /** @type {HTMLInputElement} */ (dialog.querySelector(PART.date)).value = isoDay(Date.now() - Number(chip.dataset.chip) * DAY_MS);
    });
    // A date of one's own: no shortcut stands for it.
    dialog.querySelector(PART.date)?.addEventListener('input', () => { for (const c of dialog.querySelectorAll(PART.chip)) c.classList.remove(ON); });
  });
}

/**
 * Clear by workspace or tag: the workspaces (open ones, and ones only history remembers) and the tags.
 * @param {Stats | null} stats
 */
export function clearByGroup(stats) {
  const groups = new Map((stats?.workspaces ?? []).map(g => [g.name.toLowerCase(), g]));
  const names = [...new Set([...state.workspaces.map(w => w.name), ...(stats?.workspaces ?? []).map(g => g.name)])];
  const wsRow = (/** @type {string} */ name) => {
    const g = groups.get(name.toLowerCase());
    const ws = state.workspaces.find(w => w.name === name);
    const label = `${ws ? `<span class="hist-dot" style="background:${ws.color}"></span>` : ''}${escapeHtml(name)}${ws ? '' : ' <span class="muted">· workspace closed</span>'}`;
    return tick('data-ws', name, label, g ? `<b>${formatCount(g.closed)}</b> · ${formatBytes(g.bytes)}` : '', false);
  };
  const tags = [...new Set([...(stats?.tags ?? []).map(t => t.name), ...state.tags.map(t => t.name)])];
  return planDialog(`<h3>Clear by workspace or tag</h3><p class="dialog-sub">Closed terminals from these, with their output, and the commands run in them.</p>
    <h4 class="hist-h4">Workspaces</h4><div class="hist-picks scroll">${names.map(wsRow).join('') || '<p class="muted">None yet.</p>'}</div>
    <h4 class="hist-h4">Tags</h4><div class="hist-chips">${tags.map(t => `<button class="hist-chip" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('') || '<span class="muted">None yet.</span>'}</div>
    <button class="hist-pick hist-keep ${ON}" data-keep-open><span class="hist-check"></span><span class="grow">Keep open terminals’ earlier output</span></button>
    <div class="hist-result" data-result></div>
    <div class="dialog-actions"><button class="btn" data-cancel>Cancel</button><button class="btn danger" data-ok>Remove</button></div>`,
  dialog => {
    const workspaces = picked(dialog, PART.ws), tagsOn = picked(dialog, PART.tag);
    if (!workspaces.length && !tagsOn.length) return [];
    const keepOpen = !!dialog.querySelector(`${PART.keepOpen}.${ON}`);
    const open = keepOpen ? [] : [...state.tabs.values()].filter(t => t.wsId
      && (workspaces.includes(wsById(t.wsId)?.name ?? '') || t.tags.some(tag => tagsOn.includes(tag)))).map(t => t.id);
    return [{ kinds: [HISTORY_KIND.closed, HISTORY_KIND.commands, HISTORY_KIND.earlier], workspaces, tags: tagsOn, earlierIds: open }];
  });
}

/** @param {number} months */
const monthsAgo = months => Date.now() - months * DAYS_PER_MONTH * DAY_MS;
/** @param {string} attr @param {number} chosen */
const monthsPick = (attr, chosen) => `<select class="field hist-months" ${attr}>${MONTHS.map(m => `<option value="${m}"${m === chosen ? ' selected' : ''}>${m} month${m === 1 ? '' : 's'}</option>`).join('')}</select>`;

/**
 * Free up space: output first; names, tags and commands stay, so terminals are still found by name.
 * @param {Stats | null} stats
 */
export function freeUpSpace(stats) {
  const largest = (stats?.largest ?? []);
  return planDialog(`<h3>Free up space</h3><p class="dialog-sub">${stats ? `History is ${formatBytes(stats.total)}. ` : ''}Output goes first; names, tags and commands stay, so terminals are still found by name.</p>
    <div class="hist-picks"><div class="hist-pick ${ON}" data-option="${OPTION.earlier}"><span class="hist-check"></span><span class="grow">Earlier output older than ${monthsPick(`data-months="${OPTION.earlier}"`, EARLIER_MONTHS)}</span></div>
      <div class="hist-pick" data-option="${OPTION.output}"><span class="hist-check"></span><span class="grow">Closed terminals’ output older than ${monthsPick(`data-months="${OPTION.output}"`, OUTPUT_MONTHS)}</span></div>
      ${largest.length ? `<div class="hist-pick" data-option="${OPTION.largest}"><span class="hist-check"></span><span class="grow">The ${largest.length} largest terminals</span></div>` : ''}</div>
    <div class="hist-result" data-result></div>
    <div class="dialog-actions"><button class="btn" data-cancel>Cancel</button><button class="btn primary" data-ok>Remove</button></div>`,
  dialog => {
    const on = (/** @type {string} */ o) => !!dialog.querySelector(`[data-option="${o}"].${ON}`);
    const months = (/** @type {string} */ o) => Number(/** @type {HTMLSelectElement} */ (dialog.querySelector(`[data-months="${o}"]`)).value);
    /** @type {Plan[]} */
    const plans = [];
    if (on(OPTION.earlier)) plans.push({ before: monthsAgo(months(OPTION.earlier)), kinds: [HISTORY_KIND.earlier, HISTORY_KIND.closedEarlier], earlierIds: openIds() });
    if (on(OPTION.output)) plans.push({ before: monthsAgo(months(OPTION.output)), kinds: [HISTORY_KIND.closed], outputOnly: true });
    if (on(OPTION.largest)) plans.push({ ids: largest.filter(t => !t.open).map(t => t.id), kinds: [HISTORY_KIND.earlier], earlierIds: largest.filter(t => t.open).map(t => t.id) });
    return plans;
  });
}

/** Export: a zip of plain text, after saying it isn't encrypted. */
export async function exportHistory() {
  if (!await confirmDialog({ title: 'Export history as plain text?', body: 'The zip isn’t encrypted: anyone who has the file can read your terminals’ output and commands.', confirm: 'Export' })) return;
  const open = [...state.tabs.values()].filter(t => t.wsId).map(t => ({ id: t.id, name: `${tabTitle(t)} · ${wsById(t.wsId)?.name ?? ''}` }));
  const toast = showToast({ text: 'Exporting history.', state: TOAST.running });
  const m = await request(PAGE.historyExport, { open });
  if (m?.path) toast.update({ text: 'History exported.', action: { label: 'Show in folder', run: () => send(PAGE.openPath, { path: m.path }) } });
  else if (m?.error) toast.update({ text: `Couldn’t export: ${m.error}`, state: TOAST.failed });
  else toast.close();
}

// History passed the size the user set: a note that stays, offering to free up space.
onHost(HOST.historyOverLimit, m => {
  showToast({
    text: `History is ${formatBytes(m.bytes)}, over the ${formatBytes(m.limit)} you set.`, stay: true,
    action: { label: 'Free up space', run: async () => freeUpSpace(await askStats()) },
  });
});

