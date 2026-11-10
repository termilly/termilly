// @ts-check
// The models Codex offers (its own /model list), as the host read them from Codex's cache (CodexUsage.cs): their
// names for the status bar, and the list for its model picker. Asked for once, and again each time the picker opens.

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { emit, EVENTS } from './store.js';

/** @typedef {{ slug: string, name: string, description?: string | null }} CodexModel */

/** @type {CodexModel[]} */
let models = [];
let asked = false;

onHost(HOST.codexModels, m => {
  models = /** @type {CodexModel[]} */ (m.models ?? []);
  emit(EVENTS.planChanged); // the status bars redraw, with the models' names
});

/** Asks the host for Codex's models again (they come with HOST.codexModels). */
export function refreshCodexModels() {
  asked = true;
  send(PAGE.codexModels, {});
}

/** The models Codex offers, as last read (empty before the first answer). */
export const codexModels = () => {
  if (!asked) refreshCodexModels();
  return models;
};

/**
 * A Codex model's name as Codex shows it ("GPT-6.1-Sol"); one it doesn't list, its id with "gpt" in capitals.
 * @param {string} slug
 */
export const codexModelName = slug => codexModels().find(m => m.slug === slug)?.name ?? slug.replace(/^gpt/i, 'GPT');
