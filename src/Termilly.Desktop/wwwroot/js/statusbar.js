// @ts-check
// A terminal's status bar (Settings › Terminal › Status bar), laid out as Visual Studio's: on the left the agent's
// session (its model, which opens the model picker, how full its context is, the plan's 5-hour limit, the cost), on
// the right the files the agent changed, how the branch stands against its upstream, the repository and the branch
// (which opens the branch picker). With "Colour by state" on, the bar takes the colour of what the agent is doing.

import { state, on, emit, runningAgent, EVENTS } from './store.js';
import { setStatusBuilder } from './panes.js';
import { statusUsageHtml, usageOf, modelName, openUsage, sessionKind, sessionShown } from './claudeusage.js';
import { tabRepo, repoTitle, DETACHED_LABEL } from './gitstatus.js';
import { openBranchPicker } from './branchpicker.js';
import { openModelPicker, pickedModel } from './modelpicker.js';
import { agentKind } from './agentkinds.js';
import { codexStartModel, codexModelName } from './codexmodels.js';
import { escapeHtml, ICONS } from './ui.js';
import { setHtmlIfChanged, targetOf } from './dom.js';
import { AGENT_STATE, AGENT_KIND } from './constants.js';

/** The chevron after a picker's item: it opens upwards, over the terminal. */
const CHEVRON_UP = '<svg class="chev" viewBox="0 0 8 8"><path d="M1.5 5.5L4 3l2.5 2.5"/></svg>';

/** What the agent is doing, for the bar's colour and its word: working, waiting for you, or failed. */
const BAR_STATE = Object.freeze({ working: 'working', needs: 'needs', failed: 'failed' });
const STATE_WORDS = Object.freeze({ [BAR_STATE.working]: 'Working', [BAR_STATE.needs]: 'Needs you', [BAR_STATE.failed]: 'Failed' });

/**
 * What the bar's colour says, or null when it says nothing (the setting is off, or nothing is going on).
 * @param {Tab} tab
 */
function barState(tab) {
  if (!state.settings.terminal.statusStateColor) return null;
  switch (tab.agent?.state) {
    case AGENT_STATE.working: return BAR_STATE.working;
    case AGENT_STATE.needsInput: return BAR_STATE.needs;
    case AGENT_STATE.error: return BAR_STATE.failed;
    default: return null;
  }
}

/**
 * The model's name before the session's first reply says it: Codex's start model, else the agent's name.
 * @param {string} kind
 */
function startName(kind) {
  const start = kind === AGENT_KIND.codex ? codexStartModel() : null;
  return start ? codexModelName(start) : agentKind(kind).short;
}

/**
 * The left side: the agent's model (a button: the model picker), then its usage. Before the first reply there's no
 * usage yet, and the model's button says the agent's name.
 * @param {Tab} tab
 */
function agentHtml(tab) {
  const kind = runningAgent(tab);
  if (!kind || !sessionShown(kind)) return '';
  const usage = usageOf(tab);
  const name = pickedModel(tab) ?? (usage ? modelName(usage.model) : startName(kind));
  const word = barState(tab);
  return (word ? `<span class="sb-item sb-state"><i></i>${STATE_WORDS[word]}</span>` : '')
    + `<button class="sb-item sb-model" data-sb="model" title="${escapeHtml(`${agentKind(kind).name}${usage?.model ? `: ${usage.model}` : ''}. Click to change the model.`)}"><b>${escapeHtml(name)}</b>${CHEVRON_UP}</button>`
    + statusUsageHtml(tab, state.settings.terminal.statusMeters !== false);
}

/**
 * The files the agent changed here (the list today's "N changed" button had), when the change preview keeps them.
 * @param {Tab} tab
 */
function changesHtml(tab) {
  const count = tab.changes?.length ?? 0;
  if (!(state.settings.changes.enabled && state.settings.changes.button && (count || tab.agentSeen))) return '';
  const title = count ? `Files the agent changed in this terminal (${count}). Click to see them.` : 'The agent hasn’t changed any files in this terminal yet';
  return `<button class="sb-item sb-changes${count ? '' : ' sb-none'}" data-sb="changes" title="${escapeHtml(title)}">${ICONS.rename}<span>${count}</span></button>`;
}

/**
 * The right side: how the branch stands against its upstream, the repository's folder name, and the branch.
 * @param {Tab} tab
 */
function gitHtml(tab) {
  const repo = tabRepo(tab);
  if (!repo) return '';
  const name = repo.detached ? DETACHED_LABEL : repo.branch ?? '?';
  const folder = repo.root.split(/[\\/]/).filter(Boolean).pop() ?? repo.root;
  const ab = `${repo.ahead ? `↑${repo.ahead}` : ''}${repo.ahead && repo.behind ? ' ' : ''}${repo.behind ? `↓${repo.behind}` : ''}`;
  return (ab ? `<span class="sb-item sb-ab" title="${escapeHtml(`${repo.ahead ?? 0} to push, ${repo.behind ?? 0} to pull`)}">${ab}</span>` : '')
    + `<span class="sb-sep"></span><span class="sb-item sb-repo" title="${escapeHtml(repo.root)}">${escapeHtml(folder)}</span><span class="sb-sep"></span>`
    + `<button class="sb-item sb-branch" data-sb="branch" title="${escapeHtml(`${repoTitle(repo)}\nClick to switch branches`)}">${ICONS.git}<span class="sb-branch-name">${escapeHtml(name)}</span>${repo.changed ? '<i class="sb-dirty"></i>' : ''}${CHEVRON_UP}</button>`;
}

/** @param {Tab} tab */
export function updateStatusBar(tab) {
  const bar = tab.view?.status;
  if (!bar) return;
  bar.hidden = state.settings.terminal.statusBar === false || !!tab.virtual;
  if (bar.hidden) return;
  bar.dataset.state = barState(tab) ?? '';
  setHtmlIfChanged(bar, `${agentHtml(tab)}<span class="sb-fill"></span>${changesHtml(tab)}${gitHtml(tab)}`);
}

/**
 * @param {Tab} tab
 * @param {MouseEvent} e
 */
function onClick(tab, e) {
  const item = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-sb]'));
  if (!item) return;
  e.stopPropagation();
  switch (item.dataset.sb) {
    case 'model': openModelPicker(tab, item, runningAgent(tab) ?? sessionKind(tab)); break;
    case 'usage': openUsage(tab, item); break;
    // js/changes.js lists them (it can't be imported from here without a cycle through the preview).
    case 'changes': emit(EVENTS.openChangedFiles, { tab, anchor: item }); break;
    case 'branch': openBranchPicker(tab, item); break;
  }
}

setStatusBuilder(tab => {
  const bar = document.createElement('div');
  bar.className = 'pane-statusbar';
  bar.addEventListener('click', e => onClick(tab, e));
  // The bar isn't the terminal: a click on it shouldn't start a drag or a selection there.
  bar.addEventListener('mousedown', e => { if (targetOf(e).closest('[data-sb]')) e.preventDefault(); });
  // Assigned before updating, so the update finds it through the tab.
  /** @type {TabView} */ (tab.view).status = bar;
  updateStatusBar(tab);
  return bar;
});

const updateAll = () => { for (const tab of state.tabs.values()) updateStatusBar(tab); };

on(EVENTS.tab, updateStatusBar);
on(EVENTS.changes, updateStatusBar);
on(EVENTS.claudeUsage, updateStatusBar);
on(EVENTS.workspaces, updateAll); // a repository's state came, or the terminals moved
on(EVENTS.planChanged, updateAll);
on(EVENTS.settings, updateAll);
