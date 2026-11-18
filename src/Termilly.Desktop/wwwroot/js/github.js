// @ts-check
// GitHub for the Git window, through the gh command line on this computer (the host's GitHub service runs it): whether
// a repository is on GitHub and gh is signed in, and asking it things. gh runs here only, so a repository on an SSH
// terminal's server gets none of this. Nothing is kept but gh's own sign-in.

import { PAGE } from './protocol.js';
import { request } from './host.js';
import { GITHUB_UNAVAILABLE } from './constants.js';

/**
 * What GitHub says about a repository: whether it's usable, and if not why; its name, default branch, whether
 * it's public and who is signed in.
 * @typedef {{ available: boolean, reason?: string | null, repo?: string | null, defaultBranch?: string | null,
 *   isPublic?: boolean, login?: string | null }} GitHubStatus
 */
/**
 * An issue in a list: its comments counted.
 * @typedef {{ number: number, title: string, state: string, labels: { name: string, color?: string }[],
 *   author: string, createdAt: string, updatedAt: string, comments: number, url: string }} IssueRow
 */
/**
 * A page of a repository's issues: how many GitHub has, which page this is of how many it can show, the number of
 * its first issue, whether GitHub stops short of them all (its search shows a thousand), and the page's issues.
 * @typedef {{ total: number, page: number, pages: number, first: number, capped: boolean, issues: IssueRow[] }} IssuePage
 */
/**
 * An issue in full, with its comments.
 * @typedef {Omit<IssueRow, 'comments' | 'updatedAt'> & { body: string,
 *   comments: { author: string, body: string, createdAt: string }[] }} Issue
 */
/**
 * Where an issue is: the repository's root here, its GitHub name, its default branch and the branch checked out.
 * @typedef {{ root: string, repo: string, defaultBranch: string | null, branch: string | null }} IssueContext
 */

/**
 * Why GitHub isn't there, in words, by GitHubUnavailable reason.
 * @type {Readonly<Record<string, string>>}
 */
const WHY = Object.freeze({
  [GITHUB_UNAVAILABLE.missing]: 'Issues and pull requests need the GitHub CLI (gh). Install it from cli.github.com, then refresh.',
  [GITHUB_UNAVAILABLE.signedOut]: 'Sign in to GitHub first: run gh auth login in a terminal, then refresh.',
  [GITHUB_UNAVAILABLE.notGitHub]: 'This repository\'s origin isn\'t on GitHub.',
  [GITHUB_UNAVAILABLE.unreachable]: 'GitHub didn\'t answer for this repository. Refresh (F5) to try again.',
});

/** By repository root: what GitHub said, or is saying. */
/** @type {Map<string, Promise<GitHubStatus>>} */
const statuses = new Map();

/**
 * Asks the host's GitHub service: its data, or its error as an Error.
 * @template {keyof import('./protocol.js').PageMessages} K
 * @param {K} type
 * @param {import('./protocol.js').PageMessages[K]} payload
 * @returns {Promise<any>}
 */
export async function askGitHub(type, payload) {
  const m = await request(type, payload);
  if (m.error) throw new Error(m.error);
  return m.data;
}

/**
 * Whether a repository on this computer is on GitHub, asked once per window opening (forgetGitHub asks again).
 * @param {string} root
 * @returns {Promise<GitHubStatus>}
 */
export function gitHubOf(root) {
  let status = statuses.get(root);
  if (!status) {
    status = askGitHub(PAGE.githubStatus, { root })
      .catch(e => ({ available: false, reason: null, error: /** @type {Error} */ (e).message }));
    statuses.set(root, status);
  }
  return status;
}

/** Asks again next time: gh may have been installed or signed in meanwhile. */
export const forgetGitHub = () => statuses.clear();

/**
 * Why GitHub can't be used here, in words.
 * @param {GitHubStatus & { error?: string }} status
 */
export const whyNoGitHub = status => (status.reason ? WHY[status.reason] : null) ?? status.error ?? 'GitHub isn\'t available here.';
