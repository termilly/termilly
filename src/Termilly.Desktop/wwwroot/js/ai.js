// @ts-check
// The optional AI assistant panel (Ctrl+Shift+K, terminal menu › Ask AI, or the palette). Off by default: until
// Settings › AI has a provider, the panel only says so and nothing is sent. Questions are about the terminal in
// focus; its output and your command history go along only as Settings allows (Never / Ask / Always), and the host
// redacts everything first (Assistant.cs). Suggested commands can be put at the prompt, or run, as allowed.

import { send, request } from './host.js';
import { PAGE } from './protocol.js';
import { state, tabTitle, emit, EVENTS } from './store.js';
import { focusedTab } from './panes.js';
import { escapeHtml, ICONS } from './ui.js';
import { modal, CONFIRM_DIALOG } from './dialogs.js';
import { bufferLines } from './terminals.js';
import { copyText } from './security.js';
import { SETTING_VALUES } from './constants.js';
import { byId, find, targetOf, WORKSPACE_ID } from './dom.js';

/**
 * One turn of the conversation: the user's question (and what went with it), or the answer with what was sent
 * and the model, or the error that came instead.
 * @typedef {{ role: string, content: string, shared?: string[], sent?: { role: string, content: string }[],
 *   model?: string, error?: boolean }} Turn
 */

/** The choices of the settings used here (C#'s SettingValues). */
const { aiProvider, aiPermission } = SETTING_VALUES;

const OUTPUT_LINES = 200;

/** Who said a turn of the conversation, as the provider's API names them. */
const ROLE = Object.freeze({ user: 'user', assistant: 'assistant' });

/** What a question can carry besides its text, as its turn lists them ("with output and history"). */
const SHARED = Object.freeze({ output: 'output', history: 'history' });

/** The panel's buttons (their data-ai). */
const ACTION = Object.freeze({ close: 'close', settings: 'settings' });



const panel = document.createElement('aside');
panel.className = 'sftp-panel ai-panel';
panel.hidden = true;
byId(WORKSPACE_ID).append(panel);

/** @type {Tab | null} */
let target = null; // the terminal the conversation is about
/** @type {Turn[]} */
const conversation = []; // { role, content, sent?, model?, error? }
let busy = false;

const settings = () => state.settings;
const providerName = () => (settings().ai.provider === aiProvider.anthropic ? 'Anthropic' : `the local server at ${settings().ai.endpoint}`);

/** @param {Tab | null} [tab] */
export function toggleAi(tab = focusedTab()) {
  if (!panel.hidden && (!tab || tab === target)) {
    panel.hidden = true;
    return;
  }
  if (tab && tab !== target) {
    target = tab;
    conversation.length = 0;
  }
  panel.hidden = false;
  render();
  panel.querySelector('textarea')?.focus();
}

/**
 * Asks before something is shared: resolves true (share) or false (leave it out).
 * @param {string} what
 * @param {string} detail
 */
function askToShare(what, detail) {
  return modal(CONFIRM_DIALOG, `
    <h3>Share ${escapeHtml(what)}?</h3>
    <p class="dialog-sub">${escapeHtml(detail)} It goes to ${escapeHtml(providerName())}, with secrets and saved passwords replaced by [redacted].</p>
    <div class="dialog-actions"><button class="btn" data-no>Leave it out</button><button class="btn primary" data-ok>Share</button></div>`, (dialog, close) => {
    find(dialog, '[data-no]').addEventListener('click', () => close(false));
    return { submit: () => close(true) };
  }).then(r => r === true);
}

/**
 * May the question carry this? "never": no; "always": yes; "ask": the user decides now.
 * @param {string} permission
 * @param {boolean | undefined} wanted
 * @param {string} what
 * @param {string} detail
 */
async function allowed(permission, wanted, what, detail) {
  if (!wanted || permission === aiPermission.never) return false;
  return permission === aiPermission.always || askToShare(what, detail);
}

/** @param {string} question */
async function ask(question) {
  if (busy || !question.trim()) return;
  const tab = target && state.tabs.has(target.id) ? target : null;
  const name = tab ? tabTitle(tab) : '';
  const withOutput = /** @type {HTMLInputElement | null} */ (panel.querySelector('[data-ai-output]'))?.checked;
  const withHistory = /** @type {HTMLInputElement | null} */ (panel.querySelector('[data-ai-history]'))?.checked;
  const output = tab && await allowed(settings().ai.readOutput, withOutput, 'terminal output', `The last ${OUTPUT_LINES} lines of “${name}”.`)
    ? bufferLines(tab, OUTPUT_LINES * 2).slice(-OUTPUT_LINES).join('\n') : null;
  const history = await allowed(settings().ai.readHistory, withHistory, 'command history', 'Your last 30 commands, with their folders and exit codes.');
  conversation.push({ role: ROLE.user, content: question, shared: [output ? SHARED.output : '', history ? SHARED.history : ''].filter(Boolean) });
  busy = true;
  render();
  const m = await request(PAGE.aiAsk, {
    output, outputName: name, history,
    messages: conversation.filter(c => !c.error).map(({ role, content }) => ({ role, content })),
  });
  busy = false;
  if (m.ok) conversation.push({ role: ROLE.assistant, content: m.text, sent: m.sent, model: m.model });
  else {
    conversation.pop(); // a question that got no answer isn't part of the conversation
    conversation.push({ role: ROLE.assistant, content: m.message, error: true });
  }
  render();
}

/**
 * The answer as HTML: paragraphs, inline code, and fenced commands with buttons.
 * @param {string} text
 * @param {number} index
 */
function answerHtml(text, index) {
  let block = 0;
  return text.split(/```/).map((part, i) => {
    if (i % 2 === 1) {
      const command = part.replace(/^[\w-]*\n/, '').trim();
      const n = block++;
      const run = settings().ai.runCommands;
      return `<div class="ai-code"><pre>${escapeHtml(command)}</pre><span class="btn-row">
        <button class="btn small" data-ai-copy="${index}:${n}">Copy</button>
        ${run === aiPermission.never ? '' : `<button class="btn small" data-ai-insert="${index}:${n}">Put at the prompt</button>
        <button class="btn small" data-ai-run="${index}:${n}">Run</button>`}</span></div>`;
    }
    return escapeHtml(part.trim()).replace(/`([^`\n]+)`/g, '<code>$1</code>').split(/\n{2,}/).map(p => p ? `<p>${p.replace(/\n/g, '<br>')}</p>` : '').join('');
  }).join('');
}

/** @param {string} text */
const commandsOf = text => text.split(/```/).filter((_, i) => i % 2 === 1).map(part => part.replace(/^[\w-]*\n/, '').trim());

function render() {
  const s = settings();
  const off = s.ai.provider === aiProvider.off;
  const name = target ? tabTitle(target) : 'no terminal';
  panel.innerHTML = `
    <div class="sftp-head">
      <span class="sftp-title">Ask AI · ${escapeHtml(name)}</span>
      <button class="pane-btn" data-ai="${ACTION.close}" title="Close">${ICONS.close}</button>
    </div>
    ${off ? `<div class="ai-off"><p>The AI assistant is off.</p><p class="set-desc">It's optional: nothing is sent anywhere until you choose a provider
        (Anthropic with your own API key, or a model running on this PC) in Settings › AI.</p>
        <button class="btn small" data-ai="${ACTION.settings}">Open Settings › AI</button></div>` : `
    <div class="ai-log">${conversation.length ? conversation.map((c, i) => c.role === ROLE.user
      ? `<div class="ai-q">${escapeHtml(c.content)}${c.shared?.length ? `<div class="set-desc">with ${c.shared.join(' and ')}</div>` : ''}</div>`
      : `<div class="ai-a${c.error ? ' sftp-error' : ''}">${c.error ? escapeHtml(c.content) : answerHtml(c.content, i)}
          ${c.sent ? `<details class="ai-sent"><summary>What was sent · ${escapeHtml(c.model ?? '')}</summary><pre>${escapeHtml(c.sent.map(m => `[${m.role}]\n${m.content}`).join('\n\n'))}</pre></details>` : ''}</div>`).join('')
      : `<div class="inbox-empty">Ask about ${escapeHtml(name)}: an error, a command you need, what something means.</div>`}
      ${busy ? '<div class="inbox-empty">Thinking…</div>' : ''}</div>
    <div class="ai-compose">
      <div class="ai-share">
        ${s.ai.readOutput === aiPermission.never ? '' : `<label class="paste-never"><input type="checkbox" data-ai-output checked> Terminal output${s.ai.readOutput === aiPermission.ask ? ' (asks)' : ''}</label>`}
        ${s.ai.readHistory === aiPermission.never ? '' : `<label class="paste-never"><input type="checkbox" data-ai-history> Command history${s.ai.readHistory === aiPermission.ask ? ' (asks)' : ''}</label>`}
      </div>
      <textarea class="field" rows="3" placeholder="Ask… (Enter sends, Shift+Enter: new line)" ${busy ? 'disabled' : ''}></textarea>
    </div>`}`;
  const log = panel.querySelector('.ai-log');
  if (log) log.scrollTop = log.scrollHeight;
}

/** @param {string} ref */
function commandAt(ref) {
  const [i, n] = ref.split(':').map(Number);
  return commandsOf(conversation[i]?.content ?? '')[n];
}

/**
 * @param {string | undefined} command
 * @param {boolean} enter
 */
async function runCommand(command, enter) {
  const tab = target && state.tabs.has(target.id) ? target : null;
  if (!tab || !command) return;
  if (enter && settings().ai.runCommands === aiPermission.ask) {
    const ok = await modal(CONFIRM_DIALOG, `
      <h3>Run this in ${escapeHtml(tabTitle(tab))}?</h3>
      <pre class="ai-confirm">${escapeHtml(command)}</pre>
      <div class="dialog-actions"><button class="btn" data-no>Cancel</button><button class="btn primary" data-ok>Run</button></div>`, (dialog, close) => {
      find(dialog, '[data-no]').addEventListener('click', () => close(false));
      return { submit: () => close(true) };
    });
    if (ok !== true) return;
  }
  send(PAGE.input, { id: tab.id, data: enter ? `${command}\r` : command });
  tab.view?.term?.focus();
}

panel.addEventListener('click', e => {
  const action = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-ai]'))?.dataset.ai;
  if (action === ACTION.close) return toggleAi(target);
  if (action === ACTION.settings) return emit(EVENTS.openSettings, 'ai');
  const copy = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-ai-copy]'));
  if (copy) return copyText(copy, commandAt(/** @type {string} */ (copy.dataset.aiCopy)));
  const insert = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-ai-insert]'));
  if (insert) return runCommand(commandAt(/** @type {string} */ (insert.dataset.aiInsert)), false);
  const run = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-ai-run]'));
  if (run) return runCommand(commandAt(/** @type {string} */ (run.dataset.aiRun)), true);
});

panel.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    panel.hidden = true;
    target?.view?.term?.focus();
  } else if (targetOf(e).matches('textarea') && e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    ask(/** @type {HTMLTextAreaElement} */ (targetOf(e)).value);
  }
  e.stopPropagation(); // typing here isn't for the terminal or app shortcuts
});
