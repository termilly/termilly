// @ts-check
// Copy Claude Code's allowed commands to Codex (the command palette): what the user approved for one agent in a project needn't
// be approved again for the other. The host reads Claude Code's rules for the project of the terminal in front and the user's
// own, and says which Codex can treat exactly the same (AgentRules.cs); the rest stay, each with why, so Codex never allows more
// than Claude Code does. A dialog shows what would be copied and what stays, and nothing is written until Copy. What's copied
// goes to the project's own Codex rules, not to Codex's rules for every folder.

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { state, lastFolderOf, wsById, isSsh, installedAgents } from './store.js';
import { AGENT_KIND } from './constants.js';
import { focusedTab } from './panes.js';
import { escapeHtml, ltrPath } from './ui.js';
import { modal, noticeDialog } from './dialogs.js';
import { showToast, TOAST } from './toasts.js';

/** The dialog's class (app.css). */
const RULES_DIALOG = 'agent-rules';
const TITLE = 'Copy allowed commands to Codex';
const NO_PROJECT = 'The terminal in front isn’t in a folder on this computer, so there’s no project to copy them for. Open one in the project’s folder first.';
/** What Codex does with a command, in a word each (AgentRules.Decisions). */
const DECISION_NAME = Object.freeze({ allow: 'Allowed', prompt: 'Asks first', forbidden: 'Never' });

/**
 * A rule of Claude Code's, as the host describes it (Messaging/AgentRules.cs AgentRuleView).
 * @typedef {{ text: string, decision: string, source: string, command: string | null, why: string | null }} RuleView
 */

/** The folder whose project rules are read: the terminal's in front, when it's on this computer, else its workspace's. */
function folderInFront() {
  const tab = focusedTab();
  if (!tab) return state.workspaces.find(w => w.id === state.activeId)?.cwd ?? null;
  return (isSsh(tab) ? null : lastFolderOf(tab)) ?? wsById(tab.wsId)?.cwd ?? null;
}

/** @param {RuleView} rule */
const rowHtml = rule => `<div class="ar-row"><span class="ar-decision ${escapeHtml(rule.decision)}">${DECISION_NAME[/** @type {keyof typeof DECISION_NAME} */ (rule.decision)] ?? escapeHtml(rule.decision)}</span><code>${escapeHtml(rule.command ?? rule.text)}</code><span class="ar-source">${escapeHtml(rule.source)}</span></div>`;

/** A rule as the user was shown it, for the host to check before it copies. @param {RuleView} rule */
const shown = rule => ({ text: rule.text, decision: rule.decision, command: rule.command ?? '' });

/** @param {RuleView} rule */
const staysHtml = rule => `<div class="ar-row"><code>${escapeHtml(rule.text)}</code><span class="ar-source">${escapeHtml(rule.why ?? '')}</span></div>`;

/**
 * Shows what would be copied and what stays, and copies on the user's say.
 * @param {string | null} folder
 * @param {RuleView[]} rules
 * @param {string | null} file the project's file Codex keeps them in; null with no project
 * @param {number} existing how many rules Termilly copied there before
 */
async function review(folder, rules, file, existing) {
  if (!file) return void noticeDialog({ title: TITLE, body: NO_PROJECT });
  const carried = rules.filter(r => r.command);
  const stay = rules.filter(r => !r.command);
  // Nothing carries over now, but an earlier copy is still in Codex's file: it would go on allowing what no longer may be.
  if (!carried.length && existing) return void takeBack(folder, existing, stay[0]?.why ?? '', file);
  if (!carried.length) {
    // Why the first one stays is why they all do, when it's something about the settings as a whole.
    return void noticeDialog({ title: TITLE, body: rules.length
      ? `None of Claude Code’s ${rules.length} rules here can be copied so that Codex treats it exactly the same. ${stay[0]?.why ?? ''}`
      : 'Claude Code’s settings have no rules here yet: neither your own, nor this project’s.' });
  }
  const copy = await modal(RULES_DIALOG, `
    <h3>${TITLE}</h3>
    <p class="dialog-sub">Claude Code’s settings allow, ask about or deny these commands in this project, each with whatever follows it on the line. Copied, Codex does the same here without asking you again; a command it’s allowed runs outside its sandbox. What Codex couldn’t treat exactly as Claude Code does stays behind.</p>
    <div class="ar-list">${carried.map(rowHtml).join('')}</div>
    ${stay.length ? `<details class="ar-stay"><summary>${stay.length} ${stay.length === 1 ? 'rule stays' : 'rules stay'} with Claude Code</summary><div class="ar-list">${stay.map(staysHtml).join('')}</div></details>` : ''}
    <p class="dialog-sub ar-file">They go to ${escapeHtml(ltrPath(file))}, for this project only; Codex reads it once it trusts the folder. Termilly writes its own lines there anew each time and leaves any others as they are.</p>
    <div class="dialog-actions">
      <button class="btn" data-cancel>Cancel</button>
      <button class="btn primary" data-ok autofocus>Copy ${carried.length} ${carried.length === 1 ? 'command' : 'commands'}</button>
    </div>`, (_dialog, close) => ({ submit: () => close(true) }));
  // The host copies these and no others: should the settings have changed meanwhile, it copies nothing and says so.
  if (copy) send(PAGE.agentRulesCopy, { folder, rules: carried.map(shown) });
}

/**
 * Offers to take back what an earlier copy wrote, now that none of Claude Code's rules can be copied.
 * @param {string | null} folder
 * @param {number} existing
 * @param {string} why why nothing carries over
 * @param {string} file
 */
async function takeBack(folder, existing, why, file) {
  const remove = await modal(RULES_DIALOG, `
    <h3>${TITLE}</h3>
    <p class="dialog-sub">None of Claude Code’s rules here can be copied now so that Codex treats it exactly the same. ${escapeHtml(why)}</p>
    <p class="dialog-sub">An earlier copy left ${existing} ${existing === 1 ? 'command' : 'commands'} in ${escapeHtml(ltrPath(file))}, which Codex still follows. Removing them keeps Codex from allowing what Claude Code no longer does.</p>
    <div class="dialog-actions">
      <button class="btn" data-cancel>Keep them</button>
      <button class="btn primary" data-ok autofocus>Remove ${existing} copied before</button>
    </div>`, (_dialog, close) => ({ submit: () => close(true) }));
  if (remove) send(PAGE.agentRulesCopy, { folder, rules: [] });
}

/** Opens the copy: asks the host for the rules; the dialog follows its answer. */
export function openAgentRules() {
  if (!installedAgents().includes(AGENT_KIND.codex)) {
    return void noticeDialog({ title: TITLE, body: 'Codex isn’t installed on this computer, so there’s nowhere to copy them to.' });
  }
  send(PAGE.agentRulesRead, { folder: folderInFront() });
}

onHost(HOST.agentRulesList, m => void review(m.folder ?? null, /** @type {RuleView[]} */ (m.rules ?? []), m.file ?? null, m.existing ?? 0));

onHost(HOST.agentRulesCopied, m => {
  if (m.error) showToast({ text: `Nothing was copied. ${m.error}`, state: TOAST.failed });
  else if (!m.count) showToast({ text: 'Removed what was copied before. A Codex already running follows it until its next start', state: TOAST.done });
  else showToast({ text: `Copied ${m.count} ${m.count === 1 ? 'command' : 'commands'} for this project. A Codex already running takes them at its next start`, state: TOAST.done });
});
