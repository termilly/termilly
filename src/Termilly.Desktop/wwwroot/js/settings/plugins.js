// @ts-check
// Settings › Plugins: the plugins folder, each installed plugin (on or off) and the terminal colours from theme plugins.

import { PAGE } from '../protocol.js';
import { send } from '../host.js';
import { state, on, GROUPS, EVENTS } from '../store.js';
import { escapeHtml, ICONS } from '../ui.js';
import { updateSettings } from '../preferences.js';
import { plugins, reloadPlugins, PLUGIN_STATE } from '../plugins.js';
import { applyTerminalSettings } from '../terminals.js';
import { row, group } from './controls.js';
import { SECTION, redrawIfShowing } from './page.js';
import { targetOf } from '../dom.js';

/**
 * A plugin as this section shows it: plugins.js's record, with the plugin.json fields it shows besides.
 * @typedef {{ id: string, name: string, version?: string, description?: string, themes?: unknown[],
 *   script?: string | null, state: string, error?: string | null, lastError?: string }} PluginRow
 */

/** How long after a plugin is turned on or off to reload the plugins, so the saved setting is what they read. */
const RELOAD_AFTER_SAVE_MS = 400;

/** @type {import('./page.js').Section} */
const PLUGINS = {
  id: SECTION.plugins,
  label: 'Plugins', icon: ICONS.puzzle,
  html: () => group('', row('Plugins folder',
    'Each plugin is a folder with a plugin.json (themes, and optionally a script that adds palette commands). Scripts run sandboxed: no network and no access to Termilly beyond its plugin API.', `
      <span class="btn-row"><button class="btn small" data-action="openPlugins">Open folder</button>
      <button class="btn small" data-action="reloadPlugins">Reload</button></span>`))
    + group('Installed', plugins.length ? /** @type {PluginRow[]} */ (plugins).map(p => `
      <div class="plugin-row" data-plugin="${escapeHtml(p.id)}">
        <div class="plugin-text">
          <div class="set-name">${escapeHtml(p.name)} <span class="set-desc">${escapeHtml([p.version, p.id].filter(Boolean).join(' · '))}</span></div>
          <div class="set-desc">${escapeHtml([p.description, p.themes?.length ? `${p.themes.length} theme${p.themes.length === 1 ? '' : 's'}` : '', p.script ? 'script' : ''].filter(Boolean).join(' · '))}</div>
          ${p.state === PLUGIN_STATE.failed ? `<div class="set-desc plugin-error">Disabled: ${escapeHtml(p.error ?? '')}</div>` : ''}
          ${p.state === PLUGIN_STATE.on && p.lastError ? `<div class="set-desc plugin-error">Last error: ${escapeHtml(p.lastError)}</div>` : ''}
        </div>
        ${p.state === PLUGIN_STATE.failed ? '' : `<button class="switch" role="switch" data-plugin-toggle aria-checked="${p.state === PLUGIN_STATE.on}" aria-label="On"><span></span></button>`}
      </div>`).join('') : '<p class="set-desc">None yet. Put a plugin’s folder in the plugins folder and press Reload.</p>')
    + group('', row('Terminal colours', 'From theme plugins. Default follows the app theme.', `
      <select class="field" data-terminal-colors>
        <option value="">Default</option>
        ${state.pluginThemes.map(t => `<option value="${escapeHtml(t.id)}"${t.id === state.settings.terminal.colors ? ' selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}
      </select>`)),
  actions: {
    openPlugins: () => send(PAGE.pluginsOpen),
    reloadPlugins: () => reloadPlugins(),
  },
  click(e) {
    const pluginToggle = targetOf(e).closest('[data-plugin-toggle]');
    if (!pluginToggle) return false;
    const id = /** @type {string} */ (
      /** @type {HTMLElement} */ (pluginToggle.closest('[data-plugin]')).dataset.plugin);
    const off = new Set(state.settings.interface.disabledPlugins ?? []);
    if (off.has(id)) off.delete(id); else off.add(id);
    updateSettings(GROUPS.interface, { disabledPlugins: [...off] });
    setTimeout(reloadPlugins, RELOAD_AFTER_SAVE_MS);
    return true;
  },
  change(e) {
    if (!targetOf(e).matches('[data-terminal-colors]')) return false;
    updateSettings(GROUPS.terminal, { colors: /** @type {HTMLSelectElement} */ (e.target).value || null });
    applyTerminalSettings();
    return true;
  },
};

export default PLUGINS;

on(EVENTS.plugins, () => redrawIfShowing(SECTION.plugins));
