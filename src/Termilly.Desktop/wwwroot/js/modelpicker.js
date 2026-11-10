// @ts-check
// The status bar's model picker: the models the agent in a terminal can switch to, its current one ticked. Picking one
// types the agent's own command for it into the terminal (/model opus, /model gpt-6.1-sol), as the user would; the
// agent then says what it did. Only between turns: typed while the agent works, it would land in its prompt instead.

import { PAGE } from './protocol.js';
import { send } from './host.js';
import { emit, EVENTS } from './store.js';
import { showMenu, SIDE } from './popups.js';
import { usageOf } from './claudeusage.js';
import { codexModels, refreshCodexModels } from './codexmodels.js';
import { beforeEnter } from './api.js';
import { isAgentWorking } from './agentline.js';
import { agentKind } from './agentkinds.js';
import { escapeHtml } from './ui.js';
import { AGENT_KIND } from './constants.js';

/** The agents' command that changes the model. */
const MODEL_COMMAND = '/model';

/**
 * Claude Code's model aliases: each is the newest model of its family (claude --model fable). "default" is the one
 * the account's plan recommends.
 */
const CLAUDE_MODELS = Object.freeze([
  { alias: 'default', label: 'Default', hint: 'The one your plan recommends' },
  { alias: 'fable', label: 'Fable', hint: 'Newest Fable' },
  { alias: 'opus', label: 'Opus', hint: 'Newest Opus' },
  { alias: 'sonnet', label: 'Sonnet', hint: 'Newest Sonnet' },
  { alias: 'haiku', label: 'Haiku', hint: 'Newest Haiku, the fastest' },
]);

/**
 * The model the session runs now (its id, "claude-opus-5-5" or "gpt-6.1-sol"), as its last reply said.
 * @param {Tab} tab
 */
const currentModel = tab => usageOf(tab)?.model ?? '';

/**
 * The model just picked in a terminal: its name, and the model its session ran then. The agent writes the new one to
 * its session's file only with its next reply, so until then the status bar shows the pick.
 * @type {Map<string, { name: string, from: string }>}
 */
const picked = new Map();

/**
 * The name of the model picked in a terminal, until its session's file names another; null once it does.
 * @param {Tab} tab
 */
export function pickedModel(tab) {
  const pick = picked.get(tab.id);
  if (pick && currentModel(tab) !== pick.from) picked.delete(tab.id);
  return picked.get(tab.id)?.name ?? null;
}

/**
 * Types a model command into the terminal, then Enter once the agent has taken it in.
 * @param {Tab} tab
 * @param {string} model
 * @param {string} name what the status bar calls it meanwhile
 */
async function typeModel(tab, model, name) {
  send(PAGE.input, { id: tab.id, data: `${MODEL_COMMAND} ${model}` });
  await beforeEnter(tab);
  send(PAGE.input, { id: tab.id, data: '\r' });
  picked.set(tab.id, { name, from: currentModel(tab) });
  emit(EVENTS.claudeUsage, tab);
}

/**
 * Claude Code's choices: an alias is ticked when the session's model is of its family.
 * @param {Tab} tab
 * @param {{ disabled: boolean, title: string }} state
 * @returns {import('./popups.js').MenuEntry[]}
 */
function claudeItems(tab, state) {
  const model = currentModel(tab).toLowerCase();
  return CLAUDE_MODELS.map(m => ({
    label: m.label, hint: escapeHtml(m.hint), checked: model.includes(m.alias), ...state,
    action: () => typeModel(tab, m.alias, m.label),
  }));
}

/**
 * Codex's choices: the models its own /model lists, from its cache.
 * @param {Tab} tab
 * @param {{ disabled: boolean, title: string }} state
 * @returns {import('./popups.js').MenuEntry[]}
 */
function codexItems(tab, state) {
  const model = currentModel(tab);
  const models = codexModels();
  if (!models.length) return [{ label: 'Codex hasn’t listed its models yet', disabled: true, title: 'Run codex once, or open this again in a moment' }];
  return models.map(m => ({
    label: m.name, checked: m.slug === model, ...state, title: state.title || (m.description ?? ''),
    action: () => typeModel(tab, m.slug, m.name),
  }));
}

/**
 * Opens the picker over the model in a terminal's status bar.
 * @param {Tab} tab
 * @param {HTMLElement} anchor
 * @param {string} kind the agent running there (AGENT_KIND)
 */
export function openModelPicker(tab, anchor, kind) {
  if (kind === AGENT_KIND.codex) refreshCodexModels();
  const busy = isAgentWorking(tab);
  const state = { disabled: busy, title: busy ? `${agentKind(kind).short} is working. The model changes between turns.` : '' };
  showMenu(kind === AGENT_KIND.codex ? codexItems(tab, state) : claudeItems(tab, state), anchor, { side: SIDE.above });
}
