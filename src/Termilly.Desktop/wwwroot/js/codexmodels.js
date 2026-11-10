// @ts-check
// The models Codex offers (its own /model list), as the host read them from Codex's cache (CodexUsage.cs), and the one
// a new session starts with: their names for the status bar, and the list for its model picker. Asked for as soon as
// a Codex terminal shows, and again each time the picker opens.

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { emit, EVENTS } from './store.js';

/** @typedef {{ slug: string, name: string, description?: string | null }} CodexModel */

/** How long the picker waits for the host's answer before it shows what it has. */
const ANSWER_MS = 2000;

/** @type {CodexModel[]} */
let models = [];
/** @type {string | null} */
let startModel = null;
let asked = false;
/** @type {Array<() => void>} */
let waiting = [];

onHost(HOST.codexModels, m => {
  models = /** @type {CodexModel[]} */ (m.models ?? []);
  startModel = m.default ?? null;
  for (const done of waiting) done();
  waiting = [];
  emit(EVENTS.planChanged); // the status bars redraw, with the models' names
});

/** Asks the host for Codex's models again (they come with HOST.codexModels). */
export function refreshCodexModels() {
  asked = true;
  send(PAGE.codexModels, {});
}

/** The models Codex offers, as last read (empty before the first answer, which this asks for). */
export const codexModels = () => {
  if (!asked) refreshCodexModels();
  return models;
};

/** Asks again and waits for the answer (a moment at most): the models, fresh. */
export function freshCodexModels() {
  const answered = new Promise(resolve => {
    waiting.push(() => resolve(undefined));
    setTimeout(resolve, ANSWER_MS);
  });
  refreshCodexModels();
  return answered.then(() => models);
}

/** The model a new Codex session starts with (config.toml's, else the first listed), or null before the answer. */
export const codexStartModel = () => {
  codexModels();
  return startModel;
};

/**
 * A Codex model's name as Codex shows it ("GPT-6.1-Sol"); one it doesn't list, its id with "gpt" in capitals.
 * @param {string} slug
 */
export const codexModelName = slug => codexModels().find(m => m.slug === slug)?.name ?? slug.replace(/^gpt/i, 'GPT');
