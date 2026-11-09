// @ts-check
// Implement's plan: which agent does a task's work, which agents review it, for how many rounds at most, and whether it runs in
// a terminal or silently. Also what each agent is asked in a review, and how a reviewer's reply is read. Nothing here touches
// the page or the store, so it can be tested alone (tests/js/todoplan.test.mjs).

import { AGENTS, agentKind } from './agentkinds.js';

/** How Implement runs. */
export const RUN = Object.freeze({ terminal: 'terminal', silent: 'silent' });
/** What a task's agents are at, while it's In progress. */
export const STAGE = Object.freeze({ working: 'working', reviewing: 'reviewing', fixing: 'fixing' });
/** The rounds a review may take: each is one review, and the fixes it asks for. */
export const ROUNDS = Object.freeze({ min: 1, max: 5, usual: 3 });

/**
 * @typedef {{ by: string, reviewers: string[], rounds: number, run: string }} ImplementPlan by and reviewers: agents
 *   (AGENT_KIND); run: one of RUN
 * @typedef {{ kind: string, agrees: boolean, count: number | null, text: string }} AgentReview what a reviewer said: count is
 *   how many findings it named, null when it didn't say
 */

/** The agents Termilly knows, in the order they're offered. */
export const KNOWN_AGENTS = Object.freeze(Object.keys(AGENTS));

/**
 * A plan that can run with the agents there are: the saved one where it still fits, else the first agent, nobody reviewing,
 * in a new terminal. A reviewer is always another agent than the one doing the work, and one that's installed.
 * @param {Partial<ImplementPlan> | null | undefined} saved
 * @param {readonly string[]} installed the agents installed where it runs
 * @returns {ImplementPlan}
 */
export function fitPlan(saved, installed) {
  const by = saved?.by && installed.includes(saved.by) ? saved.by : installed[0] ?? KNOWN_AGENTS[0];
  const reviewers = [...new Set(saved?.reviewers ?? [])].filter(kind => kind !== by && installed.includes(kind));
  const rounds = Math.min(ROUNDS.max, Math.max(ROUNDS.min, Math.round(Number(saved?.rounds) || ROUNDS.usual)));
  return { by, reviewers, rounds, run: saved?.run === RUN.silent ? RUN.silent : RUN.terminal };
}

/**
 * The agents that can review another's work: every installed one but the one doing it. Empty with one agent installed.
 * @param {string} by
 * @param {readonly string[]} installed
 */
export const reviewersFor = (by, installed) => installed.filter(kind => kind !== by);

/**
 * Names as a sentence has them: "Codex", "Codex and Claude Code", "A, B and C".
 * @param {readonly string[]} kinds
 */
export function namesOf(kinds) {
  const names = kinds.map(kind => agentKind(kind).name);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] ?? '';
}

/**
 * A plan in a few words, for a tooltip: "Claude Code, reviewed by Codex, silently".
 * @param {ImplementPlan} plan
 */
export const planWords = plan => [
  agentKind(plan.by).name,
  plan.reviewers.length ? `reviewed by ${namesOf(plan.reviewers)}` : '',
  plan.run === RUN.silent ? 'silently' : 'in a new terminal',
].filter(Boolean).join(', ');

/**
 * What a task's row says while its agents work: who has it now, and who's next.
 * @param {ImplementPlan} plan
 * @param {{ what: string, round: number, count?: number | null } | null | undefined} stage
 */
export function stageWords(plan, stage) {
  const by = agentKind(plan.by).name;
  const reviewers = namesOf(plan.reviewers);
  const round = stage && plan.rounds > 1 ? `, round ${stage.round} of ${plan.rounds}` : '';
  if (stage?.what === STAGE.reviewing) return { kind: plan.reviewers[0], text: `${reviewers} ${plan.reviewers.length > 1 ? 'are' : 'is'} reviewing${round}` };
  if (stage?.what === STAGE.fixing) {
    const found = stage.count ? `${stage.count} ${stage.count === 1 ? 'finding' : 'findings'} from ${reviewers}` : `what ${reviewers} found`;
    return { kind: plan.by, text: `${by} is fixing ${found}${round}` };
  }
  return { kind: plan.by, text: `${by} is working${reviewers ? `. ${reviewers} ${plan.reviewers.length > 1 ? 'review' : 'reviews'} next` : ''}` };
}

/** The last line a reviewer's reply ends with. */
const VERDICT = Object.freeze({ agree: 'VERDICT: AGREE', findings: 'VERDICT: FINDINGS' });
const VERDICT_LINE = /^\W*VERDICT:\s*(AGREE|FINDINGS)\b\W*(\d+)?.*$/im;
/** A finding in a reply: a numbered or bulleted line. */
const FINDING_LINE = /^\s*(?:\d+[.)]|[-*•])\s+\S/gm;

/** @param {string} text */
const oneLine = text => text.replace(/\s+/g, ' ').trim();
/** The most of an agent's reply another agent is given. */
const MAX_QUOTED = 4000;
/** @param {string} text */
const quoted = text => (text.length > MAX_QUOTED ? `${text.slice(0, MAX_QUOTED)} (cut short)` : text).trim();

/**
 * What a reviewer is asked: to check the work on a task without changing anything, and to end with its verdict.
 * @param {string} task the task's text (and step, when it was one)
 * @param {string} by the agent that did the work, by name
 * @param {string} reply what that agent said it did
 * @param {AgentReview[]} [before] what this review's earlier round found, when it's a later one
 */
export function reviewPrompt(task, by, reply, before = []) {
  const earlier = before.length ? ` In the round before, the review found this, which ${by} says it fixed: ${quoted(before.map(r => r.text).join(' '))}` : '';
  return `Review work another agent (${by}) just did in this folder on this task: '${oneLine(task)}'. ${by} says: ${quoted(reply) || '(nothing)'}${earlier}`
    + ' Look at what changed (git status and git diff, when this is a git repository) and read the files it touched. Check that the task is done and done right: bugs, things left out, things broken.'
    + ' Do not change, create or delete any file, and do not wait for answers. Reply with your findings as a numbered list, most important first, each with its file; leave out matters of taste.'
    + ` End your reply with one last line, exactly '${VERDICT.agree}' when nothing has to change, or '${VERDICT.findings} N' with the number of findings when something does.`;
}

/**
 * What the agent that did the work is asked after a review that found something.
 * @param {string} task the task's text
 * @param {AgentReview[]} reviews the reviews of this round that found something
 * @param {string} finish how it says it's done: what a terminal's agent calls, or '' for a reply
 */
export function fixPrompt(task, reviews, finish) {
  const found = reviews.map(r => `${agentKind(r.kind).name} found: ${quoted(r.text)}`).join(' ');
  return `Your work on the task '${oneLine(task)}' was reviewed. ${found} Fix what is right in these findings; where a finding is wrong, leave the code and say why.`
    + (finish || ' Nobody is watching, so do not wait for answers. When you finish, reply with a short summary of what you changed and what you left, first line first.');
}

/**
 * What a reviewer's reply says: whether it agrees, how many findings it named, and its text without the verdict's line. A reply
 * without a verdict doesn't agree: a reviewer that didn't say so hasn't approved the work.
 * @param {string} kind the reviewer
 * @param {string} reply
 * @returns {AgentReview}
 */
export function readReview(kind, reply) {
  const verdict = VERDICT_LINE.exec(reply);
  const text = (verdict ? reply.replace(verdict[0], '') : reply).trim();
  const agrees = verdict?.[1].toUpperCase() === 'AGREE';
  const said = verdict?.[2] ? Number(verdict[2]) : null;
  const count = agrees ? 0 : said ?? (text.match(FINDING_LINE)?.length || null);
  return { kind, agrees, count, text: text || (agrees ? 'Nothing found.' : 'It gave no verdict.') };
}

/**
 * The reviewers' verdict on a task in Review, in a line.
 * @param {{ reviews?: AgentReview[], rounds?: number, agreed?: boolean }} review
 * @returns {{ agreed: boolean, text: string, more: string } | null} null when nobody reviewed it
 */
export function verdictOf(review) {
  const reviews = review.reviews ?? [];
  if (!reviews.length) return null;
  const rounds = review.rounds ?? 1;
  const after = `after ${rounds} ${rounds === 1 ? 'round' : 'rounds'}`;
  if (review.agreed) return { agreed: true, text: `${namesOf(reviews.map(r => r.kind))} ${reviews.length > 1 ? 'agree' : 'agrees'}`, more: after };
  const open = reviews.reduce((sum, r) => sum + (r.agrees ? 0 : r.count ?? 1), 0);
  return { agreed: false, text: `No agreement ${after}`, more: `${open} ${open === 1 ? 'point' : 'points'} still open` };
}
