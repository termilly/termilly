// @ts-check
// The words the Git window's GitHub parts make up on their own: an issue's branch name, the issue a branch is for, a
// pull request's first title and body, and which issues a filter keeps. Pure, with no imports, so the tests load it
// on its own (tests/js/githubtext.test.mjs).

/** The branch an issue is worked on starts with this: bugfix/72-remote-render-fix; an enhancement's with feature/. */
export const BRANCH_PREFIX = Object.freeze({ bug: 'bugfix/', feature: 'feature/' });
/** Labels that make an issue's branch a feature's. */
const FEATURE_LABELS = new Set(['enhancement', 'feature']);
/** How many words of the title go into the branch name, and how long that part is at most. */
const SLUG_WORDS = 5;
const SLUG_CHARS = 40;
/** The issue number in a branch's name: bugfix/72-..., feature/72, 72-fix. */
const BRANCH_ISSUE = /(?:^|\/)(\d+)(?:-|$)/;
/** How a pull request says it closes its issue, which GitHub then closes on merge. */
const CLOSES = 'Closes #';

/**
 * A branch name for an issue: its kind, its number and the first words of its title.
 * @param {{ number: number, title: string, labels?: { name: string }[] }} issue
 */
export function issueBranch(issue) {
  const feature = (issue.labels ?? []).some(l => FEATURE_LABELS.has(l.name.toLowerCase()));
  const slug = issue.title.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim()
    .split(/[\s_-]+/).filter(Boolean).slice(0, SLUG_WORDS).join('-').slice(0, SLUG_CHARS).replace(/-+$/, '');
  return `${feature ? BRANCH_PREFIX.feature : BRANCH_PREFIX.bug}${issue.number}${slug ? `-${slug}` : ''}`;
}

/**
 * The issue a branch is for, from its name; null when it names none.
 * @param {string | null | undefined} branch
 */
export function issueOfBranch(branch) {
  const m = branch ? BRANCH_ISSUE.exec(branch) : null;
  return m ? Number(m[1]) : null;
}

/**
 * What a new pull request starts with: the issue's title (or the last commit's subject) and a body that closes the
 * issue, when the branch names one.
 * @param {string} branch
 * @param {string} lastSubject the branch's newest commit's subject
 * @param {{ number: number, title: string } | null} issue
 */
export function pullRequestDraft(branch, lastSubject, issue) {
  const number = issue?.number ?? issueOfBranch(branch);
  return {
    title: issue ? `${issue.title} (#${issue.number})` : lastSubject,
    body: number ? `${CLOSES}${number}` : '',
  };
}

/**
 * The issues a filter keeps: by number ("72", "#72"), or by words in the title, a label or the author.
 * @template {{ number: number, title: string, author?: string, labels?: { name: string }[] }} T
 * @param {T[]} issues
 * @param {string} filter
 * @returns {T[]}
 */
export function filterIssues(issues, filter) {
  const text = filter.trim().toLowerCase().replace(/^#/, '');
  if (!text) return issues;
  return issues.filter(i => String(i.number) === text
    || [i.title, i.author ?? '', ...(i.labels ?? []).map(l => l.name)].some(s => s.toLowerCase().includes(text)));
}

/**
 * An issue's text for a To do task's details: where it is, then its body, cut to a length a prompt can carry.
 * @param {{ url: string, body?: string | null }} issue
 * @param {number} most characters of the body kept
 */
export function issueDetails(issue, most) {
  const body = (issue.body ?? '').trim();
  const cut = body.length > most ? `${body.slice(0, most).trimEnd()} (the rest is on GitHub)` : body;
  return [issue.url, cut].filter(Boolean).join('\n');
}
