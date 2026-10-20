// @ts-check
// Plugins (Settings › Plugins; Plugins.cs reads them from <data>\plugins). Themes are data: terminal colours picked
// in Settings. A plugin's script runs in a sandboxed frame — its own opaque origin, no network (CSP), no access to
// this page or the host — and talks to Termilly only through messages: register palette commands, and call the same
// methods as the termilly CLI (list, state, status, open, send — send only when Settings › Terminal allows API
// input). A plugin that fails while starting is stopped and shown as disabled with the error; a command that fails
// later only shows its error in Settings › Plugins.

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { state, emit, EVENTS } from './store.js';
import { focusedTab } from './panes.js';
import { callApi } from './api.js';
import { escapeHtml } from './ui.js';

export const PLUGIN_API = 1;
const START_TIMEOUT = 3000;

/** A plugin's state here: running, turned off in Settings, or stopped because it failed while starting. */
export const PLUGIN_STATE = Object.freeze({ on: 'on', off: 'off', failed: 'failed' });

/** The messages a plugin's frame and this page send each other (their type). */
const MESSAGE = Object.freeze({
  run: 'run', result: 'result', ready: 'ready', register: 'register', call: 'call', error: 'error', warn: 'warn',
});

/** How much of a plugin's error is kept, in characters. */
const MAX_ERROR_CHARS = 300;
/** The most palette commands one plugin can register. */
const MAX_COMMANDS = 30;

/**
 * A plugin as Plugins.cs read it, with its state here: 'on', 'off' or 'failed'.
 * @typedef {{ id: string, name: string, script?: string | null, themes: any[], error?: string | null, state: string,
 *   lastError?: string }} Plugin
 */

/**
 * A running plugin's frame: its commands, whether it said it's ready, and the timer that fails it if it doesn't.
 * @typedef {{ frame: HTMLIFrameElement, commands: Map<string, { id: string, label: string, keywords: string }>,
 *   ready: boolean, timer?: ReturnType<typeof setTimeout> }} PluginFrame
 */

/** @type {Map<string, PluginFrame>} */
const frames = new Map(); // id → { frame, commands: Map, calls }

/**
 * The plugins as last read, each with its state: { ...info, state: 'on' | 'off' | 'failed', error }.
 * @type {Plugin[]}
 */
export let plugins = [];

onHost(HOST.plugins, m => {
  for (const id of [...frames.keys()]) stop(id);
  const disabled = new Set(state.settings.interface.disabledPlugins ?? []);
  plugins = m.plugins.map((/** @type {any} */ p) => ({
    ...p, state: p.error ? PLUGIN_STATE.failed : disabled.has(p.id) ? PLUGIN_STATE.off : PLUGIN_STATE.on,
  }));
  state.pluginThemes = plugins.filter(p => p.state === PLUGIN_STATE.on).flatMap(p => p.themes);
  for (const p of plugins) if (p.state === PLUGIN_STATE.on && p.script) start(p);
  emit(EVENTS.plugins);
});

export const reloadPlugins = () => send(PAGE.pluginsList);

/** Palette commands the running plugins registered. */
export function pluginCommands() {
  return [...frames.entries()].flatMap(([id, f]) => [...f.commands.values()].map(c => ({
    label: c.label, keywords: `${c.keywords ?? ''} plugin ${plugins.find(p => p.id === id)?.name ?? ''}`,
    hint: `<span class="set-desc">${escapeHtml(plugins.find(p => p.id === id)?.name ?? id)}</span>`,
    run: () => post(id, { type: MESSAGE.run, command: c.id, context: { pane: focusedTab()?.id ?? null } }),
  })));
}


/**
 * @param {string} id
 * @param {unknown} message
 */
function fail(id, message) {
  stop(id);
  const p = plugins.find(x => x.id === id);
  if (p) {
    p.state = PLUGIN_STATE.failed;
    p.error = String(message).slice(0, MAX_ERROR_CHARS);
  }
  console.warn(`[plugin ${id}] disabled: ${message}`);
  emit(EVENTS.plugins);
}

/** @param {string} id */
function stop(id) {
  const f = frames.get(id);
  if (!f) return;
  clearTimeout(f.timer);
  f.frame.remove();
  frames.delete(id);
}

/**
 * @param {string} id
 * @param {object} message
 */
function post(id, message) {
  frames.get(id)?.frame.contentWindow?.postMessage(message, '*');
}

/**
 * The frame's page: a strict CSP, the termilly object, then the plugin's script.
 * @param {string} script
 */
function frameDocument(script) {
  // The script is embedded as a JSON string and run with Function, so no text in it can end the <script> early.
  const bootstrap = `
    'use strict';
    (() => {
      const handlers = new Map();
      const calls = new Map();
      let next = 0;
      let started = false;
      const out = message => parent.postMessage(message, '*');
      // Failing while starting disables the plugin; failing later is only reported.
      const report = message => out({ type: started ? 'warn' : 'error', message: String(message || 'error') });
      window.addEventListener('error', e => report(e.message));
      window.addEventListener('unhandledrejection', e => report(e.reason?.message ?? e.reason));
      window.addEventListener('message', async e => {
        if (e.source !== parent) return;
        const m = e.data;
        if (m.type === 'result') { calls.get(m.callId)?.(m); calls.delete(m.callId); }
        if (m.type === 'run') {
          try { await handlers.get(m.command)?.(m.context); } catch (err) { report(err?.message ?? err); }
        }
      });
      const termilly = Object.freeze({
        apiVersion: ${PLUGIN_API},
        registerCommand(def, handler) {
          if (!def || typeof def.id !== 'string' || typeof def.label !== 'string' || typeof handler !== 'function') throw new Error('registerCommand({ id, label }, handler)');
          handlers.set(def.id, handler);
          out({ type: 'register', id: def.id, label: def.label.slice(0, 80), keywords: String(def.keywords ?? '').slice(0, 200) });
        },
        call(method, args = {}) {
          const callId = ++next;
          return new Promise((resolve, reject) => {
            calls.set(callId, m => (m.error ? reject(new Error(m.error)) : resolve(m.result)));
            out({ type: 'call', callId, method, args });
          });
        },
        setStatus(pane, text) { return termilly.call('status', { pane, text }); },
      });
      Object.defineProperty(window, 'termilly', { value: termilly });
      new Function(${JSON.stringify(script)})();
      started = true;
      out({ type: 'ready' });
    })();`;
  return `<!doctype html><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'">
    <script>${bootstrap.replace(/<\/script/gi, '<\\/script')}</script>`;
}

/** @param {Plugin} plugin */
function start(plugin) {
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.setAttribute('sandbox', 'allow-scripts'); // no allow-same-origin: an opaque origin, nothing of ours reachable
  frame.srcdoc = frameDocument(/** @type {string} */ (plugin.script));
  /** @type {PluginFrame} */
  const entry = { frame, commands: new Map(), ready: false };
  entry.timer = setTimeout(() => { if (!entry.ready) fail(plugin.id, 'It didn’t start within 3 seconds.'); }, START_TIMEOUT);
  frames.set(plugin.id, entry);
  document.body.append(frame);
}

window.addEventListener('message', e => {
  const id = [...frames.entries()].find(([, f]) => f.frame.contentWindow === e.source)?.[0];
  if (!id) return;
  const entry = /** @type {PluginFrame} */ (frames.get(id));
  const m = e.data ?? {};
  switch (m.type) {
    case MESSAGE.ready:
      entry.ready = true;
      clearTimeout(entry.timer);
      emit(EVENTS.plugins);
      break;
    case MESSAGE.register:
      if (entry.commands.size < MAX_COMMANDS) entry.commands.set(String(m.id), { id: String(m.id), label: String(m.label), keywords: String(m.keywords ?? '') });
      break;
    case MESSAGE.call: {
      (async () => {
      let result;
      let error;
      try {
        if ((m.method === 'send' || m.method === 'open' || m.method === 'snippet') && !state.settings.agents.apiAllowInput) throw new Error('Opening and typing into terminals is off (Settings › Terminal › Let scripts and agents type).');
        result = await callApi(String(m.method), m.args ?? {});
      } catch (err) {
        error = /** @type {Error} */ (err).message;
      }
      post(id, { type: MESSAGE.result, callId: m.callId, result, error });
      })();
      break;
    }
    case MESSAGE.error:
      fail(id, m.message);
      break;
    case MESSAGE.warn: {
      const p = plugins.find(x => x.id === id);
      if (p) p.lastError = String(m.message).slice(0, MAX_ERROR_CHARS);
      console.warn(`[plugin ${id}] ${m.message}`);
      emit(EVENTS.plugins);
      break;
    }
  }
});
