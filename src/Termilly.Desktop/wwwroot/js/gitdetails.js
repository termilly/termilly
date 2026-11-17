// @ts-check
// What the Git window's right side shows for a commit and a branch (js/gitwindow.js): a commit's message, people,
// parents, its checks on GitHub and the files it changed (the first one's diff below), with Undo this commit while it
// isn't pushed; a branch's place and its latest commits.

import { PAGE } from './protocol.js';
import { escapeHtml, highlight } from './ui.js';
import { targetOf } from './dom.js';
import { ITEM, found, searching, ago } from './gitsearch.js';
import { history, refChips, isHead } from './githistory.js';
import { checksSlotHtml, fillChecks, checksClicked } from './gitchecks.js';
import { undoCommit } from './gitwrite.js';
import { gw, ask, repoNow } from './gitwindowstate.js';
import { els, useRight, onGitHub } from './gitwindowparts.js';
import { writeContext, checksContext } from './gitcontexts.js';
import { showFile } from './gitdiffview.js';

/** @typedef {import('./gitwindowstate.js').Branch} Branch */
/** @typedef {import('./gitwindowstate.js').Commit} Commit */
/** @typedef {import('./gitwindowstate.js').CommitDetail} CommitDetail */

/** Commits shown in a branch's latest commits. */
const BRANCH_LOG_COMMITS = 50;
/** How long a Copy button says "Copied". */
const COPIED_MS = 1200;
const COPY_LABEL = 'Copy';
const COPIED_LABEL = 'Copied';
const UNDO_COMMIT_LABEL = 'Undo this commit';
const { rightEl } = els;

/**
 * Switching to a branch: a remote one becomes a local branch that tracks it.
 * @param {Branch} b
 */
export const switchLabel = b => (b.remote ? `Switch to ${b.name.replace(/^[^/]+\//, '')} (tracking ${b.name})` : `Switch to ${b.name}`);

/**
 * Whether a commit can be undone here: the branch's newest, not pushed yet (the host checks no remote has it).
 * @param {string} hash
 */
const canUndo = hash => !!gw.repo && !gw.repo.detached && !history.path && gw.commits.find(c => isHead(c.refs))?.hash === hash
  && (!gw.repo.upstream || !!gw.repo.ahead);

/**
 * A commit's files, each to open below it.
 * @param {CommitDetail} c
 */
const filesHtml = c => c.files.map((f, i) => {
  const counts = f.added == null ? '<span class="gw-binary">binary</span>'
    : `<span class="pv-plus">+${f.added}</span> <span class="pv-minus">−${f.removed}</span>`;
  return `<div class="cw-row gw-file" data-commit-file="${i}" title="${escapeHtml(f.oldPath ? `${f.oldPath} → ${f.path}` : f.path)}">`
    + `<span class="gw-status" data-s="${f.status}">${escapeHtml(f.status)}</span><span class="cw-name">${escapeHtml(f.path)}</span>`
    + `<span class="gw-counts">${counts}</span></div>`;
}).join('');

/**
 * A commit's head: its message (what a search found marked), people, date, hash and parents.
 * @param {CommitDetail} c
 */
function commitInfoHtml(c) {
  const [subject, ...body] = c.message.split('\n');
  const needle = found.text.toLowerCase();
  const date = new Date(c.authorDate);
  return `<div class="gw-commit-info">
      <div class="gw-commit-subject">${subject ? highlight(subject, needle) : '(no message)'}</div>
      ${body.join('\n').trim() ? `<pre class="gw-commit-body">${highlight(body.join('\n').trim(), needle)}</pre>` : ''}
      <div class="gw-commit-facts">
        <span>${highlight(c.author, needle)}</span>
        <span title="${escapeHtml(date.toString())}">${escapeHtml(date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}</span>
        <span class="gw-hash">${escapeHtml(c.hash.slice(0, 12))}</span><button class="btn small" data-copy="${escapeHtml(c.hash)}" title="Copy the full hash">${COPY_LABEL}</button>
        ${c.parents.length ? `<span>Parent${c.parents.length > 1 ? 's' : ''} ${c.parents.map(p => `<button class="gw-link" data-show-commit="${escapeHtml(p)}">${escapeHtml(p.slice(0, 7))}</button>`).join(' ')}</span>` : '<span>First commit</span>'}
        ${c.committer !== c.author ? `<span>Committed by ${escapeHtml(c.committer)}</span>` : ''}
        ${canUndo(c.hash) ? `<button class="btn small" data-undo-commit title="Takes it off the branch; its changes stay staged">${UNDO_COMMIT_LABEL}</button>` : ''}
      </div>
    </div>`;
}

/**
 * A commit: its message, author, date and parents, the files it changed, and the selected file's diff below (the
 * first, or `path`). While searching, what was found is marked.
 * @param {string} hash
 * @param {{ path?: string | null }} [options]
 */
export async function showCommit(hash, { path = null } = {}) {
  useRight(false);
  gw.selection = { kind: ITEM.commit, hash };
  rightEl.innerHTML = '<div class="gw-message">Loading</div>';
  /** @type {CommitDetail} */
  let c;
  try {
    c = await ask(PAGE.gitviewCommit, { root: repoNow().root, hash });
  } catch (e) {
    rightEl.innerHTML = `<div class="gw-message">${escapeHtml(/** @type {Error} */ (e).message)}</div>`;
    return;
  }
  if (gw.selection?.hash !== hash) return; // another one was picked meanwhile
  gw.currentCommit = c;
  rightEl.innerHTML = `${commitInfoHtml(c)}
    ${onGitHub() ? checksSlotHtml(c.hash) : ''}
    <div class="gw-commit-files">${c.files.length ? filesHtml(c) : '<div class="gw-empty">No files changed.</div>'}</div>
    <div class="gw-commit-diff"></div>`;
  // The first file (or the one asked for) opens at once.
  const at = Math.max(0, c.files.findIndex(f => f.path === path));
  const first = /** @type {HTMLElement | null} */ (rightEl.querySelector(`[data-commit-file="${at}"]`));
  if (first) first.click();
  if (onGitHub()) fillChecks(rightEl, c.hash, repoNow().root);
}

/**
 * A branch: where it is, how far from its upstream, and its latest commits (each opens).
 * @param {Branch} b
 */
export async function showBranch(b) {
  useRight(false);
  gw.selection = { kind: ITEM.branch, ref: b.ref };
  rightEl.innerHTML = '<div class="gw-message">Loading</div>';
  /** @type {Commit[]} */
  let list;
  try {
    list = await ask(PAGE.gitviewLog, { root: repoNow().root, skip: 0, limit: BRANCH_LOG_COMMITS, ref: b.ref });
  } catch (e) {
    rightEl.innerHTML = `<div class="gw-message">${escapeHtml(/** @type {Error} */ (e).message)}</div>`;
    return;
  }
  if (gw.selection?.ref !== b.ref) return;
  const facts = [
    b.current ? 'The checked-out branch' : b.remote ? 'A remote branch' : 'A local branch',
    b.upstream ? `tracking ${b.upstream}${b.gone ? ' (gone)' : b.ahead || b.behind ? `, ${b.ahead} ahead, ${b.behind} behind` : ', up to date'}` : '',
  ].filter(Boolean).join(', ');
  rightEl.innerHTML = `
    <div class="gw-commit-info">
      <div class="gw-commit-subject">${escapeHtml(b.name)}</div>
      <div class="gw-commit-facts"><span>${escapeHtml(facts)}</span>${b.current ? '' : `<button class="btn small" data-switch-branch>${escapeHtml(switchLabel(b))}</button>`}</div>
    </div>
    <div class="gw-branch-log">${list.map(c => `<div class="cw-row gw-commit" data-show-commit="${escapeHtml(c.hash)}">`
      + `<span class="gw-commit-main"><span class="gw-subject">${escapeHtml(c.subject || '(no message)')}</span>${refChips(c.refs)}</span>`
      + `<span class="gw-commit-meta"><span class="gw-hash">${escapeHtml(c.short)}</span><span>${escapeHtml(c.author)}</span><span>${ago(c.date)}</span></span></div>`).join('')}</div>`;
}

// A commit's buttons: its checks', a file of it, Copy, a parent (or a branch's commit), Undo this commit.
rightEl.addEventListener('click', e => {
  if (gw.repo && checksClicked(e, checksContext())) return;
  const t = targetOf(e);
  const file = /** @type {HTMLElement | null} */ (t.closest('[data-commit-file]'));
  if (file) {
    for (const el of rightEl.querySelectorAll('[data-commit-file]')) el.classList.toggle('selected', el === file);
    const f = gw.currentCommit?.files[Number(file.dataset.commitFile)];
    if (f) showFile(f, { inCommit: /** @type {CommitDetail} */ (gw.currentCommit).hash, find: searching() ? { line: 0, wholeFile: false } : null });
    return;
  }
  const copy = /** @type {HTMLElement | null} */ (t.closest('[data-copy]'));
  if (copy) {
    navigator.clipboard.writeText(/** @type {string} */ (copy.dataset.copy));
    copy.textContent = COPIED_LABEL;
    setTimeout(() => { copy.textContent = COPY_LABEL; }, COPIED_MS);
    return;
  }
  const commit = /** @type {HTMLElement | null} */ (t.closest('[data-show-commit]'));
  if (commit) return void showCommit(/** @type {string} */ (commit.dataset.showCommit));
  const ctx = writeContext();
  if (ctx && gw.currentCommit && t.closest('[data-undo-commit]')) undoCommit(ctx, gw.currentCommit.message.split('\n')[0]);
});
