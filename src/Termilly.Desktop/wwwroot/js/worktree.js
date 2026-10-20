// @ts-check
// Agents in their own git worktree (+ menu, or the palette: "New agent in worktree…"): a new branch and worktree
// next to the repository (repo.worktrees\branch), the files .worktreeinclude lists copied in, and a terminal there
// running the agent. The terminal menu's "Clean up worktree…" shows whether the branch is merged and what's
// uncommitted, then closes its terminals and removes the worktree (and the branch, if you like). Worktrees.cs does
// the git work.

import { PAGE } from './protocol.js';
import { request } from './host.js';
import { state, wsById, defaultProfile, persist, emit, EVENTS } from './store.js';
import { escapeHtml, profileOptionsHtml } from './ui.js';
import { modal, pickFolder, CONFIRM_DIALOG, FORM_DIALOG } from './dialogs.js';
import { newTab, closeTab, focusedTab } from './panes.js';
import { find, field as fieldIn, showError } from './dom.js';


const LAST_COMMAND_KEY = 'termilly.worktreeAgent';
/** What the new terminal runs until another command is given. */
const DEFAULT_COMMAND = 'claude';
/** The New agent in worktree dialog's fields (their names). */
const FIELD = Object.freeze({ folder: 'folder', branch: 'branch', command: 'command', profile: 'profile' });
/** How long the worktree's terminals get to close before it's removed: a shell still in the folder would hold it. */
const CLOSE_GRACE_MS = 800;

function lastCommand() {
  try { return localStorage.getItem(LAST_COMMAND_KEY) ?? DEFAULT_COMMAND; } catch { return DEFAULT_COMMAND; }
}

/**
 * The dialog's markup, starting at a folder.
 * @param {string} folder
 */
function newWorktreeHtml(folder) {
  return `
    <h3>New agent in worktree</h3>
    <p class="dialog-sub">A new branch in its own folder next to the repository, so the agent's work stays apart from yours.</p>
    <label class="dialog-field">Repository
      <span class="field-row">
        <input class="field" name="${FIELD.folder}" value="${escapeHtml(folder)}" placeholder="A folder inside a git repository" spellcheck="false">
        <button class="btn" data-browse data-no-enter>Browse</button>
      </span>
    </label>
    <label class="dialog-field">Branch
      <input class="field" name="${FIELD.branch}" placeholder="e.g. agent/fix-login" spellcheck="false" autofocus>
    </label>
    <div class="dialog-field">Run
      <span class="field-row">
        <input class="field" name="${FIELD.command}" value="${escapeHtml(lastCommand())}" placeholder="Nothing (just a shell)" spellcheck="false">
        <select class="field" name="${FIELD.profile}" aria-label="Shell">${profileOptionsHtml(defaultProfile())}</select>
      </span>
    </div>
    <p class="dialog-sub">Untracked files the work needs (.env and the like) are copied in when the repository's <code>.worktreeinclude</code> lists them.</p>
    <p class="dialog-error" data-error hidden></p>
    <div class="dialog-actions">
      <button class="btn" data-cancel data-no-enter>Cancel</button>
      <button class="btn primary" data-ok>Create</button>
    </div>`;
}

/** The New agent in worktree dialog; the folder starts as the focused terminal's (or the workspace's). */
export function openNewWorktree() {
  const tab = focusedTab();
  const folder = tab?.cwd ?? tab?.startCwd ?? wsById(state.activeId)?.cwd ?? '';
  const wsId = state.activeId;
  return modal(FORM_DIALOG, newWorktreeHtml(folder), (dialog, close) => {
    /** @param {string} name */
    const field = name => fieldIn(dialog, `[name=${name}]`);
    const error = find(dialog, '[data-error]');
    const ok = /** @type {HTMLButtonElement} */ (find(dialog, '[data-ok]'));
    /** @param {boolean} on */
    const busy = on => {
      ok.disabled = on;
      ok.textContent = on ? 'Creating…' : 'Create';
    };
    find(dialog, '[data-browse]').addEventListener('click', async () => {
      const path = await pickFolder(field(FIELD.folder).value);
      if (path) field(FIELD.folder).value = path;
    });
    const submit = async () => {
      if (ok.disabled) return;
      if (!field(FIELD.branch).value.trim()) { field(FIELD.branch).focus(); return; }
      busy(true);
      error.hidden = true;
      const m = await request(PAGE.worktreeCreate, { folder: field(FIELD.folder).value.trim(), branch: field(FIELD.branch).value });
      if (!m.ok) {
        showError(error, m.message);
        busy(false);
        return;
      }
      close(openAgentTab(m, { command: field(FIELD.command).value.trim(), profile: field(FIELD.profile).value, wsId }));
    };
    return { submit };
  });
}

/**
 * The terminal in a new worktree, running the agent's command (remembered for next time).
 * @param {import('./protocol.js').Host_worktreeReply_0} m the host's answer: the worktree it made
 * @param {{ command: string, profile: string, wsId: string | null }} options
 */
function openAgentTab(m, { command, profile, wsId }) {
  try { localStorage.setItem(LAST_COMMAND_KEY, command); } catch { /* a convenience only */ }
  const created = newTab({ profile, wsId, name: m.branch, cwd: m.path, command: command || null });
  created.worktree = { repo: m.repo, path: m.path, branch: m.branch };
  if (m.copied) created.worktree.copied = m.copied;
  persist();
  emit(EVENTS.tab, created);
  return created;
}

/**
 * The terminals working in a worktree.
 * @param {{ path: string }} worktree
 */
const tabsIn = worktree => [...state.tabs.values()].filter(t => t.worktree?.path === worktree.path);

/**
 * Clean up worktree: its state, then closing its terminals and removing it.
 * @param {Tab} tab
 */
export async function openCleanup(tab) {
  const wt = tab.worktree;
  if (!wt) return;
  const answer = await request(PAGE.worktreeStatus, wt);
  const status = answer.status;
  const lines = !answer.ok ? [`<p class="dialog-error">${escapeHtml(answer.message)}</p>`] : [
    status.merged
      ? `<p>Branch <b>${escapeHtml(wt.branch)}</b> is merged into <b>${escapeHtml(status.base)}</b>.</p>`
      : `<p>Branch <b>${escapeHtml(wt.branch)}</b> isn't merged into <b>${escapeHtml(status.base)}</b> yet.</p>`,
    status.changes ? `<p class="dialog-error">${status.changes} uncommitted change${status.changes === 1 ? '' : 's'} in the worktree will be lost.</p>` : '',
    status.exists ? '' : '<p>The worktree folder is already gone.</p>',
  ];
  const others = tabsIn(wt).length;
  return modal(CONFIRM_DIALOG, `
    <h3>Clean up worktree</h3>
    <p class="dialog-sub" title="${escapeHtml(wt.path)}">${escapeHtml(wt.path)}</p>
    ${lines.join('')}
    <label class="paste-never"><input type="checkbox" data-branch${status?.merged ? ' checked' : ''}> Delete the branch too${status && !status.merged ? ' (its commits are only on it)' : ''}</label>
    <p class="dialog-sub">${others === 1 ? 'Its terminal closes.' : `Its ${others} terminals close.`}</p>
    <p class="dialog-error" data-error hidden></p>
    <div class="dialog-actions">
      <button class="btn" data-cancel data-no-enter>Cancel</button>
      <button class="btn danger" data-ok>${status?.changes ? 'Remove anyway' : 'Remove worktree'}</button>
    </div>`, (dialog, close) => {
    const error = find(dialog, '[data-error]');
    const submit = async () => {
      const deleteBranch = fieldIn(dialog, '[data-branch]').checked;
      // A shell sitting in the folder would keep Windows from deleting it, so the terminals close first.
      for (const t of tabsIn(wt)) closeTab(t);
      await new Promise(r => setTimeout(r, CLOSE_GRACE_MS));
      const m = await request(PAGE.worktreeRemove, { ...wt, deleteBranch, force: !!status?.changes || (deleteBranch && !status?.merged) });
      if (!m.ok) {
        showError(error, m.message);
        return;
      }
      close(true);
    };
    return { submit };
  });
}
