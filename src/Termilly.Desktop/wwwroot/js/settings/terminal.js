// @ts-check
// Settings › Terminal: the default shell, scrollback, agents, production safety, logs, recordings, triggers and the
// shell profiles. Notifications and sounds have their own page (notifications.js).

import { sys, SYSTEM_NAME } from '../host.js';
import { state, isSshProfile, activityChanged, GROUPS } from '../store.js';
import { escapeHtml, ICONS, profileOptionsHtml } from '../ui.js';
import { environments } from '../environments.js';
import { updateSettings } from '../preferences.js';
import { row, seg, toggle, group, choices } from './controls.js';
import { SECTION } from './page.js';
import { triggerList, triggerActions, triggerClick, triggerChange, triggerInput } from './triggers.js';
import { shellList, profileActions, profileClick } from './profiles.js';
import { SETTING_VALUES } from '../constants.js';
import { targetOf } from '../dom.js';

/** The choices of the settings used here (C#'s SettingValues). */
const { hiddenScrollback, costDisplay, agentLine, agentLimit, prodPaste, logFormat, linkClick, clipLimit } = SETTING_VALUES;

/** Clipboard's rows: keeping copies, from other apps too, after a restart, how many. */
const clipRows = () => row('Keep copies', 'Every copy kept, to paste again from a terminal’s right-click menu or the Clipboard panel (Ctrl+Shift+X).', toggle('clips.enabled'), { keywords: 'clipboard history copy paste' })
  + row('Copies from other apps', 'Also keep what you copy in other apps. Copies a password manager marks private are left out.', toggle('clips.otherApps'), { keywords: 'clipboard history other apps' })
  + row('Keep after a restart', 'Encrypted on this PC. Secrets are never written and go after 10 minutes.', toggle('clips.keep'), { keywords: 'clipboard history restart encrypted' })
  + row('Clips kept', 'The oldest go first. Pinned clips don’t count.', seg('clips.limit', choices(clipLimit.all, String)), { keywords: 'clipboard history limit' });

/** The status bar's own switch, which the rows after it need. */
const STATUS_BAR = 'terminal.statusBar';
/** The plan's two windows in the bar: with either on, Termilly reads the limits (agents.claudeLimits follows them, statusbar.js). */
const FIVE_HOUR = 'terminal.statusFiveHour';
const WEEK = 'terminal.statusWeek';

/** The status bar's rows: the bar itself, what's on it (each agent's session, the plan's limits, the branch), and how. */
const statusBarRows = () => row('Status bar', 'A bar under each terminal: its agent’s session, files changed, the git branch.', toggle(STATUS_BAR), { keywords: 'status bar footer branch model context' })
  + row('Claude Code session', 'Model, context and tokens. Click the model to change it.', toggle('agents.claudeUsage'), { keywords: 'claude usage model context tokens', needs: STATUS_BAR })
  + row('Codex session', 'Model, context and tokens, from Codex’s session files.', toggle('agents.codexUsage'), { keywords: 'codex usage model context tokens openai', needs: STATUS_BAR })
  + row('Context', 'How full the agent’s context is.', toggle('terminal.statusContext'), { keywords: 'status bar context tokens', needs: STATUS_BAR })
  + row('5-hour usage', 'How much of your plan’s 5-hour limit is used (Claude and Codex).', toggle(FIVE_HOUR), { keywords: 'plan limit usage 5-hour session daily', needs: STATUS_BAR })
  + row('Weekly usage', 'How much of your plan’s weekly limit is used.', toggle(WEEK), { keywords: 'plan limit usage weekly week', needs: STATUS_BAR })
  + row('Keep limits up to date', 'Always show them: Codex’s are free, Claude’s cost a tiny Haiku prompt every 15 minutes at most, only while Termilly is in front.', toggle('agents.refreshLimits'), { keywords: 'plan limit usage refresh haiku 5-hour weekly', needs: `${STATUS_BAR},agents.claudeLimits` })
  + row('Meters', 'Context and limits as bars. Off: numbers only.', toggle('terminal.statusMeters'), { keywords: 'status bar meter numbers', needs: STATUS_BAR })
  + row('Colour by state', 'The bar takes the colour of what the agent is doing: working, needs you, failed.', toggle('terminal.statusStateColor'), { keywords: 'status bar colour color state working needs', needs: STATUS_BAR })
  + row('Git branch', 'The branch, its uncommitted changes and ↑↓ against its upstream. Click to switch.', toggle('interface.gitStatus'), { keywords: 'git branch dirty changes ahead behind upstream repository worktree switch', needs: STATUS_BAR });

/** A row per environment (production, staging) with its host patterns, comma-separated. */
function envPatternRows() {
  return environments().map(env => row(`${escapeHtml(env.label[0] + env.label.slice(1).toLowerCase())} hosts`,
    `Hosts that count as ${env.id === 'prod' ? 'production' : escapeHtml(env.label.toLowerCase())}; * matches anything.`,
    `<input class="field env-patterns" data-env="${escapeHtml(env.id)}" value="${escapeHtml((env.patterns ?? []).join(', '))}" spellcheck="false" style="--env:${env.color}">`,
    { keywords: 'production prod staging environment host pattern' })).join('');
}

/**
 * A comma-separated field as its entries.
 * @param {string} text
 */
const commaList = text => text.split(',').map(t => t.trim()).filter(Boolean);

/** @type {import('./page.js').Section} */
const TERMINAL = {
  id: SECTION.terminal,
  label: 'Terminal', icon: ICONS.terminal,
  html: () => group('', row('Default shell', 'Used for new terminals and Ctrl Shift T.', `
      <select class="field" data-setting="shells.defaultProfile">${profileOptionsHtml()}</select>`)
    + row('Scrollback', 'Lines each terminal keeps, and saves to history when closed.',
      seg('terminal.scrollback', [['1000', '1,000'], ['5000', '5,000'], ['10000', '10,000'], ['50000', '50,000']]))
    + row('Check before pasting several lines', 'Ask, with a preview, before pasting several lines at once.', toggle('safety.pasteWarning'))
    + row('Inline images', 'Pictures programs print (Sixel, iTerm2). New terminals only.', toggle('terminal.inlineImages'))
    + row('Copy on select', 'Selecting text copies it, without Ctrl+C.', toggle('terminal.copyOnSelect'), { keywords: 'clipboard copy paste select mouse' })
    + row('Open web links', 'Ctrl+click leaves a plain click free for selecting text.', seg('terminal.linkClick', [[linkClick.ctrl, 'Ctrl+click'], [linkClick.click, 'Click']]), { keywords: 'link url web address browser open click hyperlink' })
    + row('Let programs copy to the clipboard', 'Programs may set the clipboard (OSC 52), never read it.', toggle('terminal.programClipboard'))
    + row('Scrollback out of sight', 'Fewer lines for terminals in other workspaces, to save memory.',
      seg('session.hiddenScrollback', choices(hiddenScrollback.all, lines => (lines ? lines.toLocaleString('en-US') : 'Same'))))
    + row('Containers and pods', 'Docker containers and Kubernetes pods in the + menu.', toggle('shells.dynamicSources'))
    + row('Activity spinner', 'Spins while a command runs or a program reports progress.',
      toggle('interface.showActivity'))
    + row('Agent integration', 'Claude Code and Codex report what they’re doing. New terminals only.',
      toggle('agents.integration'))
    + row('Shell integration', 'Marks where each command starts and ends. New terminals only.',
      toggle('shells.integration'))
    + row('Agents can read other terminals', 'Agents may read other terminals’ output, secrets redacted.', toggle('agents.readDefault'), { keywords: 'agent read output mcp terminal other watch wait' })
    + row('Let scripts and agents type', 'Scripts and agents may open terminals and type into them.',
      toggle('agents.apiAllowInput'))
    + row('Agent cost', 'What each agent has cost, in the sidebar and its status bar.',
      seg('agents.costDisplay', [[costDisplay.cost, 'Dollars'], [costDisplay.tokens, 'Tokens'], [costDisplay.off, 'Off']]), { keywords: 'agent claude cost price dollars tokens spend usage budget' })
    + row('Agent activity line', 'A dim line under an agent’s row: what it’s doing now.',
      seg('agents.line', [[agentLine.on, 'On'], [agentLine.focused, 'This workspace'], [agentLine.off, 'Off']]), { keywords: 'agent claude activity status line sidebar' })
    + row('Live agents', 'Above this many, idle agents in other workspaces hibernate.',
      seg('agents.limit', choices(agentLimit.all, limit => (limit ? String(limit) : 'No limit')))))
    + group('Status bar', statusBarRows())
    + group('Clipboard', clipRows())
    + group('Production', row('Ask before pasting', 'Ask before pasting into a production terminal.',
        seg('safety.prodPaste', [[prodPaste.always, 'Always'], [prodPaste.multiline, 'Several lines or risky'], [prodPaste.dangerous, 'Risky words'], [prodPaste.never, 'Never']]), { keywords: 'production prod safety confirm paste rm drop delete' })
      + envPatternRows()
      + row('Tint the background', 'A faint wash of the environment’s colour over the terminal.', toggle('safety.prodTint'), { keywords: 'production prod staging colour color' }))
    + group('Session logs', row('Folder', 'Where session logs go (Log to file, in a terminal’s menu).',
        `<input class="field" data-setting-text="logging.folder" value="${escapeHtml(state.settings.logging.folder ?? '')}" placeholder="Documents\\Termilly\\logs" spellcheck="false">`, { keywords: 'log logging record file audit session' })
      + row('Format', 'Plain text without escape codes, or everything as it came.', seg('logging.format', [[logFormat.plain, 'Plain text'], [logFormat.raw, 'Raw']]), { keywords: 'log logging' })
      + row('Time on each line', '', toggle('logging.timestamps'), { keywords: 'log logging timestamp' })
      + row('Redact secrets', 'Tokens and passwords are replaced, as in the history.', toggle('logging.redact'), { keywords: 'log logging secret password token' })
      + row('Always log these tags', 'Terminals with these tags log from the start, e.g. <b>prod</b>.', `<input class="field log-tags" value="${escapeHtml((state.settings.logging.tags ?? []).join(', '))}" placeholder="prod, audit" spellcheck="false">`, { keywords: 'log logging tag prod' })
      + row('Delete logs after', '', seg('logging.keepDays', [['0', 'Never'], ['30', '30 days'], ['90', '90 days'], ['365', 'A year']]), { keywords: 'log logging rotation cleanup' }))
    + group('Recordings', row('Recording folder', 'Where recordings (.cast) go. What you type is never saved.',
        `<input class="field" data-setting-text="recording.folder" value="${escapeHtml(state.settings.recording.folder ?? '')}" placeholder="Documents\\Termilly\\recordings" spellcheck="false">`, { keywords: 'record replay asciicast asciinema cast' })
      + row('Redact secrets', 'Replace tokens and passwords as it’s written.', toggle('recording.redact'), { keywords: 'record secret' })
      + row('Record agent terminals', 'Record a terminal when its agent starts working.', toggle('recording.agents'), { keywords: 'record agent claude replay' })
      + row('Largest recording', 'A recording stops by itself at this size.', seg('recording.maxMb', [['50', '50 MB'], ['100', '100 MB'], ['500', '500 MB']]), { keywords: 'record size cap' }))
    + group('Triggers', `${triggerList()}
        <p class="set-desc">Patterns matched against each new output line.</p>`)
    + group('Your profiles', `${shellList('custom', { editable: true })}
        <button class="btn small" data-action="addProfile">${ICONS.plus}<span>Add profile</span></button>
        <p class="set-desc">Any command, with its own folder, variables and tags.</p>`)
    + group('Detected', `${shellList('local')}${shellList('wsl')}
        <p class="set-desc">${sys.name === SYSTEM_NAME.linux ? 'Your login shell and the shells in /etc/shells.' : 'PowerShell, Command Prompt, Git Bash and WSL on this PC.'}</p>`)
    + group('SSH hosts', `${shellList('ssh')}
        <p class="set-desc">${state.profiles.some(p => isSshProfile(p)) ? 'From <code>~/.ssh/config</code>. Hosts named like production are tagged prod.' : 'Add <code>Host</code> entries to <code>~/.ssh/config</code> to see them here.'}</p>`),
  actions: { ...triggerActions, ...profileActions },
  click: e => triggerClick(e) || profileClick(e),
  change(e) {
    if (triggerChange(e)) return true;
    if (targetOf(e).matches('input.log-tags')) {
      updateSettings(GROUPS.logging, { tags: commaList(/** @type {HTMLInputElement} */ (e.target).value) });
    }
    if (targetOf(e).matches('input.env-patterns')) {
      const patterns = commaList(/** @type {HTMLInputElement} */ (e.target).value);
      updateSettings(GROUPS.safety, { environments: environments().map(env => (env.id === targetOf(e).dataset.env ? { ...env, patterns } : env)) });
    }
  },
  input: triggerInput,
  changed(key) {
    if (key === 'interface.showActivity') for (const tab of state.tabs.values()) activityChanged(tab, true);
  },
};

export default TERMINAL;
