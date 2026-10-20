// @ts-check
// What a line of command output produced, for a terminal's Results list (results.js): pull requests and issues it
// opened, apps it's running (dev-server URLs), commits and pushes. Pure functions, no page state, so they can be
// tested on their own (tests/js/resultdetect.test.mjs).

/**
 * Something a line produced: its kind ('pr', 'issue', 'app', 'commit' or 'push'), its web page (null for a commit,
 * or a push to a host without branch pages), its title, and a commit's branch.
 * @typedef {{ kind: string, url: string | null, title: string, detail?: string }} DetectedResult
 */
/**
 * What the detector carries between a terminal's lines: the host and repository of the push being read.
 * @typedef {{ push?: { host: string, repo: string } }} PushState
 */
/**
 * A pull request or issue link: its pattern, and what a match's kind, repository and number are.
 * @typedef {{ re: RegExp, kind: (m: RegExpMatchArray) => string, repo: (m: RegExpMatchArray) => string,
 *   num: (m: RegExpMatchArray) => string }} PrPattern
 */

/** What a result is: a pull request, an issue, a running app, a commit or a push. */
export const RESULT_KIND = Object.freeze({ pr: 'pr', issue: 'issue', app: 'app', commit: 'commit', push: 'push' });
/** What a dev server's address on any interface is shown as. */
const LOCALHOST = 'localhost';

/** @type {PrPattern[]} */
const PR_PATTERNS = [
  // GitHub: /owner/repo/pull/42 and /issues/42
  { re: /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(pull|issues)\/(\d+)/g, kind: m => (m[2] === 'pull' ? RESULT_KIND.pr : RESULT_KIND.issue), repo: m => m[1], num: m => m[3] },
  // GitLab (gitlab.com or self-hosted gitlab.*): /group/project/-/merge_requests/7 and /-/issues/7
  { re: /https?:\/\/(?:[\w-]+\.)*gitlab[\w.-]*\/([\w./-]+?)\/-\/(merge_requests|issues)\/(\d+)/g, kind: m => (m[2] === 'issues' ? RESULT_KIND.issue : RESULT_KIND.pr), repo: m => m[1], num: m => m[3] },
  // Azure DevOps: dev.azure.com/org/project/_git/repo/pullrequest/12
  { re: /https?:\/\/dev\.azure\.com\/([\w.-]+\/[\w.-]+)\/_git\/([\w.-]+)\/pullrequest\/(\d+)/g, kind: () => RESULT_KIND.pr, repo: m => `${m[1]}/${m[2]}`, num: m => m[3] },
];

/** A local address a dev server prints: localhost, 127.0.0.1, 0.0.0.0, [::1], with a port. */
const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{2,5})(?:\/[^\s'"`<>)\]]*)?/g;

/** git commit: "[main 1a2b3c4] Fix the thing" (also "[main (root-commit) 1a2b3c4]"). */
const COMMIT = /^\[([\w./-]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.+)$/;

/** git push: "To github.com:owner/repo.git" or "To https://github.com/owner/repo.git". */
const PUSH_TO = /^To (?:https?:\/\/|ssh:\/\/)?(?:[\w.-]+@)?([\w.-]+)[:/]([\w./-]+?)(?:\.git)?\/?$/;
/** git push's ref line: "   1a2b3c4..5d6e7f8  main -> main" or " * [new branch]      feat -> feat". */
const PUSH_REF = /^\s*(?:\+|\*|-)?\s*(?:\[new branch\]|\[new tag\]|[0-9a-f]{7,40}\.\.\.?[0-9a-f]{7,40})\s+([\w./-]+)\s+->\s+([\w./-]+)/;

/**
 * A web page for a pushed branch, on GitHub and GitLab.
 * @param {string} host
 * @param {string} repo
 * @param {string} branch
 */
function branchUrl(host, repo, branch) {
  if (host === 'github.com') return `https://github.com/${repo}/tree/${branch}`;
  if (/gitlab/.test(host)) return `https://${host}/${repo}/-/tree/${branch}`;
  return null;
}

/**
 * The results in one output line. `state` carries a push across lines (its "To …" line comes before the ref
 * lines): pass the same object for a terminal's lines in order.
 * @param {string | null | undefined} line
 * @param {PushState} [state]
 */
export function detectResults(line, state = {}) {
  /** @type {DetectedResult[]} */
  const found = [];
  const text = String(line ?? '');
  for (const p of PR_PATTERNS) {
    for (const m of text.matchAll(p.re)) {
      const kind = p.kind(m);
      found.push({ kind, url: m[0].replace(/[.,;:]+$/, ''), title: `${kind === RESULT_KIND.pr ? 'PR' : 'Issue'} #${p.num(m)} · ${p.repo(m)}` });
    }
  }
  for (const m of text.matchAll(LOCAL_URL)) {
    const url = m[0].replace(/[.,;:]+$/, '').replace('0.0.0.0', LOCALHOST).replace('[::]', LOCALHOST);
    found.push({ kind: RESULT_KIND.app, url, title: url.replace(/^https?:\/\//, '') });
  }
  const commit = COMMIT.exec(text.trim());
  if (commit) found.push({ kind: RESULT_KIND.commit, url: null, title: `${commit[2].slice(0, 7)} ${commit[3]}`, detail: commit[1] });
  const to = PUSH_TO.exec(text.trim());
  if (to) state.push = { host: to[1], repo: to[2] };
  const ref = PUSH_REF.exec(text);
  if (ref && state.push) {
    found.push({ kind: RESULT_KIND.push, url: branchUrl(state.push.host, state.push.repo, ref[2]), title: `Pushed ${ref[1]} → ${state.push.repo}${ref[2] === ref[1] ? '' : `:${ref[2]}`}` });
  }
  return found;
}

