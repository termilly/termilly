// @ts-check
// Settings › Terminal: the default shell, scrollback, agents, production safety, logs, recordings, notifications,
// triggers and the shell profiles.

import { sys, SYSTEM_NAME } from '../host.js';
import { state, isSshProfile, activityChanged, GROUPS } from '../store.js';
import { escapeHtml, ICONS, profileOptionsHtml } from '../ui.js';
import { environments } from '../environments.js';
import { updateSettings } from '../preferences.js';
import { row, seg, toggle, group, choices } from './controls.js';
import { SECTION, takenChords } from './page.js';
import { triggerList, triggerActions, triggerClick, triggerChange, triggerInput } from './triggers.js';
import { shellList, profileActions, profileClick } from './profiles.js';
import { SETTING_VALUES } from '../constants.js';
import { targetOf } from '../dom.js';

/** The choices of the settings used here (C#'s SettingValues). */
const { hiddenScrollback, costDisplay, agentLine, agentLimit, prodPaste, logFormat } = SETTING_VALUES;

/** A row per environment (production, staging) with its host patterns, comma-separated. */
function envPatternRows() {
  return environments().map(env => row(`${escapeHtml(env.label[0] + env.label.slice(1).toLowerCase())} hosts`,
    `Host names or addresses that count as ${env.id === 'prod' ? 'production' : escapeHtml(env.label.toLowerCase())}; <code>*</code> matches anything. Terminals tagged <b>${escapeHtml(env.id)}</b> count too.`,
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
    + row('Scrollback', 'Lines each terminal keeps. Also how much a closed terminal saves to history.',
      seg('terminal.scrollback', [['1000', '1,000'], ['5000', '5,000'], ['10000', '10,000'], ['50000', '50,000']]))
    + row('Check before pasting several lines', 'Pasting more than one line at a prompt runs them one by one; ask first, with a preview.', toggle('safety.pasteWarning'))
    + row('Inline images', 'Pictures programs print with Sixel or the iTerm2 image protocol (img2sixel, chafa, imgcat). Applies to terminals opened after the change.', toggle('terminal.inlineImages'))
    + row('Copy on select', 'Selecting text copies it, without Ctrl+C. Ctrl+C copies a selection either way, and stops the running command when nothing is selected.', toggle('terminal.copyOnSelect'), { keywords: 'clipboard copy paste select mouse' })
    + row('Let programs copy to the clipboard', 'Programs can put text on your clipboard with the OSC 52 sequence (neovim, tmux, helix), also from a server over ssh. They can never read it.', toggle('terminal.programClipboard'))
    + row('Scrollback out of sight', 'Terminals in workspaces you’re not looking at keep fewer lines, to save memory with many terminals open. Their oldest lines are dropped.',
      seg('session.hiddenScrollback', choices(hiddenScrollback.all, lines => (lines ? lines.toLocaleString('en-US') : 'Same'))))
    + row('Containers and pods', 'Running Docker containers and Kubernetes pods (current kubectl context) in the + menu, each opening a shell inside. Read at start and with “Refresh containers and pods”.', toggle('shells.dynamicSources'))
    + row('Activity spinner', 'Next to a terminal’s title while a command runs (Start-Process -Wait, npm install, a build) or an app reports progress, like Claude Code while it works. Interactive programs such as ssh and vim don’t count.',
      toggle('interface.showActivity'))
    + row('Agent integration', 'Claude Code started in a terminal reports what it’s doing through hooks Termilly adds, next to your own: working, needs you, finished, or stopped with an error. Applies to terminals opened after the change. Run <code>termilly-hook selftest</code> in a terminal to check it.',
      toggle('agents.integration'))
    + row('Claude session in the header', 'A small chip on the header of a terminal running Claude Code: the model, how full its context is, and the tokens it has written. Click it for the rest. Termilly reads the numbers from the session’s transcript on this PC; nothing is sent anywhere.',
      toggle('agents.claudeUsage'))
    + row('Plan usage limits', 'Your Claude plan’s 5-hour and weekly limits (Pro and Max), next to the session’s. Claude Code reports them to its status line, so Termilly sets the status line to a small helper that passes them on and then runs your own status line, which looks as before. Applies to Claude started after the change.',
      toggle('agents.claudeLimits'))
    + row('Shell integration', `${sys.name === SYSTEM_NAME.linux ? 'bash and PowerShell' : 'PowerShell, Git Bash and WSL bash'} mark where each command starts and ends, so the spinner also shows for commands that start no program (Start-Sleep, a long loop). Your prompt and profile stay as they are. Applies to terminals opened after the change.`,
      toggle('shells.integration'))
    + row('Agents can read other terminals', 'With <code>termilly read</code> / <code>wait</code> and the MCP server’s read_terminal_output and wait_for_terminal, an agent can see another terminal’s last command and output (secrets redacted), e.g. a dev server or tests. On by default for local terminals only; SSH, WSL, containers, production and terminals tagged <b>sensitive</b> are off. Each terminal’s menu (Scripts and agents › Can read this terminal) changes it.', toggle('agents.readDefault'), { keywords: 'agent read output mcp terminal other watch wait' })
    + row('Let scripts and agents type', 'The <code>termilly</code> command (in every terminal) and its MCP server (<code>claude mcp add termilly -- termilly mcp</code>) can always list terminals, read their state, search command history (redacted) and set a status. With this on they can also open terminals, and type into the ones whose menu allows it: Scripts and agents › Can type here.',
      toggle('agents.apiAllowInput'))
    + row('Agent cost', 'What each agent has cost, on its row in the sidebar, its header and the workspace: Claude’s own figure (as <code>/cost</code> shows), or an estimate from its tokens; subagents are estimated. On a Pro or Max plan it’s what the work would cost on the API, not a bill.',
      seg('agents.costDisplay', [[costDisplay.cost, 'Dollars'], [costDisplay.tokens, 'Tokens'], [costDisplay.off, 'Off']]), { keywords: 'agent claude cost price dollars tokens spend usage budget' })
    + row('Agent activity line', 'One dim line under an agent terminal’s row in the sidebar: the tool it’s using and on what, what it’s waiting for, or the first line of its reply.',
      seg('agents.line', [[agentLine.on, 'On'], [agentLine.focused, 'This workspace'], [agentLine.off, 'Off']]), { keywords: 'agent claude activity status line sidebar' })
    + row('Live agents', 'With more Claude Code sessions open than this, the ones idle for 5 minutes in other workspaces are ended and marked hibernated; opening the terminal resumes the same conversation.',
      seg('agents.limit', choices(agentLimit.all, limit => (limit ? String(limit) : 'No limit'))))
    + row('Global shortcut', takenChords.has('Ctrl+Alt+J')
        ? '<span class="warn">Another app already uses Ctrl Alt J, so it can’t work from other apps. Inside Termilly, Ctrl Shift J still does.</span>'
        : 'Ctrl Alt J goes to the next terminal that needs you from any app, bringing Termilly forward. Inside Termilly it’s Ctrl Shift J.',
      toggle('notifications.jumpHotkey')))
    + group('Production', row('Ask before pasting', 'Into a terminal on production: one tagged <b>prod</b>, an SSH host named like production or matching the patterns below, or a terminal running <code>ssh</code> to one. Broadcasts, dropped files and scripts typing there always ask.',
        seg('safety.prodPaste', [[prodPaste.always, 'Always'], [prodPaste.multiline, 'Several lines or risky'], [prodPaste.dangerous, 'Risky words'], [prodPaste.never, 'Never']]), { keywords: 'production prod safety confirm paste rm drop delete' })
      + envPatternRows()
      + row('Tint the background', 'A faint wash of the environment’s colour over the whole terminal, besides the frame and the chip.', toggle('safety.prodTint'), { keywords: 'production prod staging colour color' }))
    + group('Session logs', row('Folder', 'Logs go to <code>{folder}\\{workspace}\\{terminal}_{date}_{time}.log</code>. Start one from a terminal’s menu (<b>Log to file</b>). Logs are plain files, <b>not encrypted</b>.',
        `<input class="field" data-setting-text="logging.folder" value="${escapeHtml(state.settings.logging.folder ?? '')}" placeholder="Documents\\Termilly\\logs" spellcheck="false">`, { keywords: 'log logging record file audit session' })
      + row('Format', 'Plain text has escape codes stripped and each command marked with its exit code; raw keeps everything, so <code>cat</code> replays it.', seg('logging.format', [[logFormat.plain, 'Plain text'], [logFormat.raw, 'Raw']]), { keywords: 'log logging' })
      + row('Time on each line', '', toggle('logging.timestamps'), { keywords: 'log logging timestamp' })
      + row('Redact secrets', 'Tokens and passwords are replaced, as in the history.', toggle('logging.redact'), { keywords: 'log logging secret password token' })
      + row('Always log these tags', 'Every terminal with one of these tags logs from the start, e.g. <b>prod</b>.', `<input class="field log-tags" value="${escapeHtml((state.settings.logging.tags ?? []).join(', '))}" placeholder="prod, audit" spellcheck="false">`, { keywords: 'log logging tag prod' })
      + row('Delete logs after', '', seg('logging.keepDays', [['0', 'Never'], ['30', '30 days'], ['90', '90 days'], ['365', 'A year']]), { keywords: 'log logging rotation cleanup' }))
    + group('Recordings', row('Recording folder', '“Record” in a terminal’s menu writes an asciicast file (.cast) here: its output with timings and a mark for each command, never what you type. Play it with “Open a recording” or <code>asciinema play</code>.',
        `<input class="field" data-setting-text="recording.folder" value="${escapeHtml(state.settings.recording.folder ?? '')}" placeholder="Documents\\Termilly\\recordings" spellcheck="false">`, { keywords: 'record replay asciicast asciinema cast' })
      + row('Redact secrets', 'Tokens and passwords in the output are replaced as it’s written.', toggle('recording.redact'), { keywords: 'record secret' })
      + row('Record agent terminals', 'A terminal starts recording when an agent in it starts working, to see later what it did.', toggle('recording.agents'), { keywords: 'record agent claude replay' })
      + row('Largest recording', 'A recording stops by itself at this size.', seg('recording.maxMb', [['50', '50 MB'], ['100', '100 MB'], ['500', '500 MB']]), { keywords: 'record size cap' }))
    + group('Notifications', row('Needs you', `A ${sys.name === SYSTEM_NAME.linux ? 'desktop' : 'Windows'} notification when an agent asks for permission or input, or a terminal wants attention, while you can’t see it (another workspace, or Termilly in the background). Clicking it opens the terminal.`,
        toggle('notifications.needsInput'))
      + row('Stopped with an error', '', toggle('notifications.error'))
      + row('Finished', 'When an agent finishes its turn.', toggle('notifications.done')))
    + group('Triggers', `${triggerList()}
        <p class="set-desc">Each new output line is matched against these regular expressions (case doesn’t matter). Matches can be highlighted, kept in the
          <b>Captured lines</b> list (sidebar), or raise a notification or the amber “wants attention” dot. For one terminal, use its menu: <b>Alert me</b>.</p>`)
    + group('Your profiles', `${shellList('custom', { editable: true })}
        <button class="btn small" data-action="addProfile">${ICONS.plus}<span>Add profile</span></button>
        <p class="set-desc">Any command with its own folder, environment variables and tags: a shell with arguments,
          <code>docker exec -it</code>, <code>kubectl exec -it</code>…</p>`)
    + group('Detected', `${shellList('local')}${shellList('wsl')}
        <p class="set-desc">${sys.name === SYSTEM_NAME.linux ? 'Your login shell and the shells listed in <code>/etc/shells</code>.' : 'PowerShell, Command Prompt, Git Bash and WSL distributions found on this PC.'}</p>`)
    + group('SSH hosts', `${shellList('ssh')}
        <p class="set-desc">${state.profiles.some(p => isSshProfile(p))
          ? 'Read from <code>~/.ssh/config</code>; ssh itself handles keys, agents and jump hosts. Hosts named like production start tagged <b>prod</b>.'
          : `Add <code>Host</code> entries to <code>~/.ssh/config</code> and they appear here, opened with ${sys.name === SYSTEM_NAME.linux ? 'your OpenSSH client' : 'the OpenSSH client that comes with Windows'}.`}</p>`),
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
