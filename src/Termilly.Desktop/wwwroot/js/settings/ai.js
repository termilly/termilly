// @ts-check
// Settings › AI assistant: the provider (off, Anthropic or a local model), its key or server, and what it may use.

import { PAGE, HOST } from '../protocol.js';
import { send, onHost, sys } from '../host.js';
import { state, getSetting } from '../store.js';
import { escapeHtml, ICONS } from '../ui.js';
import { confirmDialog } from '../dialogs.js';
import { row, seg, group } from './controls.js';
import { SECTION, body, redraw, redrawIfShowing } from './page.js';
import { SETTING_VALUES } from '../constants.js';
import { field } from '../dom.js';

/** The choices of the settings used here (C#'s SettingValues). */
const { aiProvider, aiPermission } = SETTING_VALUES;

/** Whether an Anthropic API key is saved (the host never sends the key itself). */
let aiHasKey = false;

/** @type {import('./page.js').Section} */
const AI = {
  id: SECTION.ai,
  label: 'AI assistant', icon: ICONS.spark,
  html: () => {
    const s = state.settings;
    const perm = (/** @type {string} */ key) => seg(key, [[aiPermission.never, 'Never'], [aiPermission.ask, 'Ask'], [aiPermission.always, 'Always']]);
    const text = (/** @type {string} */ key, /** @type {string} */ placeholder) => `<input class="field mono" data-setting-text="${key}" value="${escapeHtml(getSetting(key) ?? '')}" placeholder="${placeholder}" spellcheck="false">`;
    return group('', row('Assistant',
      'Optional, and off until you pick a provider. Ask about a terminal with Ctrl+Shift+K. Nothing is sent anywhere while it’s off.',
      seg('ai.provider', [[aiProvider.off, 'Off'], [aiProvider.anthropic, 'Anthropic'], [aiProvider.local, 'Local model']])))
      + (s.ai.provider === aiProvider.anthropic ? group('Anthropic', row('API key',
        aiHasKey ? `Saved in ${sys.credentials}, not in Termilly’s files.` : `Your own key from console.anthropic.com. It’s kept in ${sys.credentials}.`, `
          <span class="field-row"><input class="field mono" type="password" data-ai-key placeholder="${aiHasKey ? '••••••••  (saved)' : 'sk-ant-…'}" autocomplete="off" spellcheck="false">
          <button class="btn small" data-action="saveAiKey">Save</button>${aiHasKey ? '<button class="btn small danger-outline" data-action="removeAiKey">Remove</button>' : ''}</span>`, { stack: true })
        + row('Model', '', text('ai.model', 'claude-sonnet-5-5'))) : '')
      + (s.ai.provider === aiProvider.local ? group('Local model', row('Server',
        'An OpenAI-compatible server on this PC or your network: Ollama (http://localhost:11434/v1), LM Studio (http://localhost:1234/v1).',
        text('ai.endpoint', 'http://localhost:11434/v1'), { stack: true })
        + row('Model', '', text('ai.model', 'llama3.2'))) : '')
      + group('What it may use', row('Read terminal output', 'The last 200 lines of the terminal you ask about.', perm('ai.readOutput'))
        + row('Read command history', 'Your last 30 commands, with folders and exit codes.', perm('ai.readHistory'))
        + row('Run suggested commands', 'Never: copy only. Ask: confirm each one. Always: Run types it and presses Enter.', perm('ai.runCommands'))
        + `<p class="set-desc set-note">Everything sent is redacted first: tokens, keys and passwords that look like secrets, and every
          password you saved for an SSH connection. Each answer has “What was sent” to check.</p>`);
  },
  refresh: () => send(PAGE.aiStatus),
  actions: {
    saveAiKey() {
      const input = field(body, '[data-ai-key]');
      if (input.value.trim()) send(PAGE.aiKey, { key: input.value.trim() });
      input.value = '';
    },
    async removeAiKey() {
      if (await confirmDialog({ title: 'Remove the API key?', body: `It’s deleted from ${sys.credentials}. The assistant stops working until you add one again.`, confirm: 'Remove' })) {
        send(PAGE.aiKey, { key: '' });
      }
    },
  },
  changed(key) {
    if (key === 'ai.provider') redraw(); // its own rows
  },
};

export default AI;

onHost(HOST.aiStatus, m => {
  aiHasKey = m.hasKey;
  redrawIfShowing(SECTION.ai);
});
