// @ts-check
// What the Git window's helper modules work with (js/gitwindow.js): writing (gitwrite.js), issues (gitissues.js),
// Local history and cleanup (gitlocal.js, gitcleanup.js), checks (gitchecks.js) and staging part of a file
// (gitstage.js). Each is made when it's needed, from the window as it is then; the ones an Undo or a dialog keeps hold
// the machine they were made on, so they act there even after the window moved on.

import { PAGE } from './protocol.js';
import { gw, ui, ask, askHere, repoNow } from './gitwindowstate.js';
import { showGitError } from './gitwindowparts.js';

/** Looks again after a write: a push or a new pull request changes what the head offers. */
const refreshAfterWrite = () => {
  gw.pullRequestOf = null;
  return ui.refresh();
};

/** What the write side works with. @returns {import('./gitwrite.js').WriteContext | null} */
export const writeContext = () => (gw.repo ? { repo: gw.repo, ask, refresh: refreshAfterWrite, showGitError, github: gw.github } : null);

/** What the Issues tab works with. @returns {import('./gitissues.js').IssueContext} */
export const issueContext = () => ({
  root: repoNow().root, repo: gw.github?.repo ?? '', defaultBranch: gw.github?.defaultBranch ?? null,
  branch: gw.repo?.branch ?? null,
});

/** What the Local history tab and Clean up work with. @returns {import('./gitlocal.js').LocalContext} */
export const localContext = () => ({ ask: askHere(), root: repoNow().root, remote: !!gw.server, refresh: () => ui.refresh(), showError: showGitError });

/** What the checks work with. @returns {import('./gitchecks.js').ChecksContext} */
export const checksContext = () => {
  // The repository and machine as they are now: a fix asked for here stays here, whatever the window shows later.
  const { root, branch: current } = repoNow();
  const on = askHere();
  return {
    root, showError: showGitError,
    folderFor: async branch => {
      if (!branch || branch === current) return root;
      /** @type {import('./gitcleanup.js').Worktree[]} */
      const list = await on(PAGE.gitviewWorktrees, { root }).catch(() => []);
      return list.find(w => w.branch === branch)?.path ?? null;
    },
  };
};

/**
 * What staging part of the shown file works with.
 * @param {import('./gitwindowstate.js').DiffState} shown
 * @returns {import('./gitstage.js').StageContext}
 */
export const stageContext = shown => ({
  ask: askHere(), root: repoNow().root, path: shown.request.path ?? '', side: shown.request.side ?? '',
  refresh: () => ui.refresh(), showError: showGitError,
});
