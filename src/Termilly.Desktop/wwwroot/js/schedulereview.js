// @ts-check
// A schedule's agent prompt, reviewed by other agents, as To do's Implement is (js/todoreview.js): when the agent that ran the
// prompt is done, the agents picked to review it read what it did, each in a hidden shell, changing nothing. What they find
// goes back to that agent, in the session it worked in (in a new one, told what it said, should that one not open again), and
// they look again, for as many rounds as the schedule allows. A prompt that may change files has its changes reviewed; one
// that only reads has its answer checked against the files, and corrects it. The run stays Running all that time; its report
// is the agent's reply with the reviewers' verdict and what each one said. Only out of sight on this computer: the agents are
// known to be installed here, and there's a hidden shell to run them in.

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { newId, installedAgents } from './store.js';
import { AGENT_KIND } from './constants.js';
import { agentKind } from './agentkinds.js';
import { agentCommand, readResult, noticeOf } from './agentcli.js';
import { plainText } from './schedulereport.js';
import { WHAT, WHERE, summaryOf } from './schedulerules.js';
import { fitPlan, reviewPrompt, fixPrompt, answerReviewPrompt, answerFixPrompt, readReview, verdictOf, namesOf } from './todoplan.js';

/** @typedef {import('./todoplan.js').AgentReview} AgentReview */
/** @typedef {import('./agentcli.js').AgentResult} AgentResult */
/**
 * How a reviewed run ended, for js/schedules.js to record.
 * @typedef {{ code?: number | null, stopped?: boolean, error?: string, summary?: string, costUsd?: number | null, notice?: string, text?: string }} Ending
 */

const MINUTE_S = 60;
/** What a review's part of the report starts with. */
const REVIEW_HEAD = '---';

/**
 * A schedule's run on its way through its reviews.
 * @typedef {object} Loop
 * @property {ActiveScheduleRun} going
 * @property {string} by the agent that ran the prompt
 * @property {string[]} reviewers
 * @property {number} rounds the most reviews it gets
 * @property {number} round the review going, from 1
 * @property {number | null} code how the agent's first run ended
 * @property {string[]} replies what the agent said: its first reply, then each fix's
 * @property {AgentReview[]} reviews this round's reviews so far
 * @property {AgentReview[]} open the findings last handed back
 * @property {{ round: number, found: number }[]} earlier the rounds that found something, and how much
 * @property {string | null} session the agent's session, which a fix goes on from
 * @property {Set<string>} waiting the hidden runs going now: reviewers, or the fix
 * @property {boolean} resumed whether the fix going on now went on from the session
 * @property {number} cost what its runs cost so far, as they said
 * @property {string | undefined} shell the shell it runs in, which a prompt is written for
 * @property {(how: Ending) => void} finish
 * @property {() => void} changed what the run says now is shown
 */

/**
 * The runs on their way, by the schedule's run.
 * @type {Map<string, Loop>}
 */
const loops = new Map();
/**
 * The hidden runs going, by their own id: whose they are, and whether they review or fix.
 * @type {Map<string, { loop: Loop, kind: string, review: boolean }>}
 */
const runs = new Map();

/**
 * The agents that review a schedule's prompt when it runs: installed, not the one that runs it, and only out of sight here.
 * @param {Schedule} schedule
 * @returns {string[]}
 */
export function reviewersOf(schedule) {
  if (schedule.what !== WHAT.agent || schedule.where !== WHERE.hidden || !schedule.reviewers?.length) return [];
  const by = schedule.agent ?? AGENT_KIND.claude;
  return fitPlan({ by, reviewers: schedule.reviewers }, installedAgents()).reviewers;
}

/** @param {Schedule} schedule */
const roundsOf = schedule => fitPlan({ rounds: schedule.rounds }, []).rounds;

/**
 * Whether the run reviewed changes, or an answer.
 * @param {Loop} loop
 */
const changes = loop => loop.going.schedule.allowChanges;

/**
 * Starts an agent in a hidden shell, where the schedule runs.
 * @param {Loop} loop
 * @param {string} kind
 * @param {string} prompt
 * @param {{ review: boolean, resume?: string | null }} how
 */
function start(loop, kind, prompt, { review, resume = null }) {
  const { schedule } = loop.going;
  const id = newId('v');
  const command = agentCommand(prompt, {
    kind, shell: loop.shell, changes: !review && changes(loop), all: !review && !!schedule.allowAll, json: true, review, keep: !review, resume,
  });
  runs.set(id, { loop, kind, review });
  loop.waiting.add(id);
  send(PAGE.scheduleRun, { runId: id, profile: schedule.profile, cwd: schedule.cwd || null, command, limitSeconds: schedule.limitMinutes * MINUTE_S });
  return id;
}

/**
 * Hands its reviews a run whose agent is done: the reviewers read it now, and the run ends when they're through.
 * @param {ActiveScheduleRun} going
 * @param {AgentResult} result what the agent said
 * @param {number | null} code
 * @param {{ reviewers: string[], shell: string | undefined, finish: (how: Ending) => void, changed: () => void }} with shell: the
 *   one it runs in; changed: what the run says now is to be shown
 */
export function startReviews(going, result, code, { reviewers, shell, finish, changed }) {
  const { schedule } = going;
  /** @type {Loop} */
  const loop = {
    going, by: schedule.agent ?? AGENT_KIND.claude, reviewers, rounds: roundsOf(schedule), round: 0, code, replies: [result.reply.trim()],
    reviews: [], open: [], earlier: [], session: result.session, waiting: new Set(), resumed: false, cost: result.costUsd ?? 0, shell, finish, changed,
  };
  loops.set(going.run.id, loop);
  review(loop);
}

/** @param {Loop} loop */
const lastReply = loop => loop.replies.at(-1) ?? '';

/**
 * A review round: every reviewer reads the work at the same time, each on its own.
 * @param {Loop} loop
 */
function review(loop) {
  const before = loop.reviews.filter(r => !r.agrees);
  loop.round += 1;
  loop.reviews = [];
  const by = agentKind(loop.by).name;
  const { prompt } = loop.going.schedule;
  const ask = changes(loop) ? reviewPrompt(prompt, by, lastReply(loop), before) : answerReviewPrompt(prompt, by, lastReply(loop), before);
  for (const kind of loop.reviewers) start(loop, kind, ask, { review: true });
  loop.going.run.summary = `${namesOf(loop.reviewers)} ${loop.reviewers.length > 1 ? 'are' : 'is'} reviewing${loop.rounds > 1 ? `, round ${loop.round} of ${loop.rounds}` : ''}.`;
  loop.changed();
}

/**
 * What a review found goes back to the agent that ran the prompt: in its session, where that's known, else in a new one.
 * @param {Loop} loop
 */
function fix(loop) {
  const { prompt } = loop.going.schedule;
  const fresh = !loop.session;
  const ask = changes(loop) ? fixPrompt(prompt, loop.open, '') : answerFixPrompt(prompt, loop.open, fresh ? lastReply(loop) : null);
  loop.resumed = !fresh;
  start(loop, loop.by, ask, { review: false, resume: loop.session });
  loop.going.run.summary = `${agentKind(loop.by).name} is fixing what ${namesOf(loop.open.map(r => r.kind))} found.`;
  loop.changed();
}

/**
 * The report: what the agent said, then the reviewers' verdict and what each one said. A prompt that only reads keeps its
 * corrected answer alone; one that changes files keeps what each fix said it did.
 * @param {Loop} loop
 * @param {boolean} agreed
 */
function reportOf(loop, agreed) {
  const replies = changes(loop)
    ? loop.replies.map((reply, i) => (i ? `After review round ${i}:\n${reply}` : reply)).join('\n\n')
    : lastReply(loop);
  const verdict = verdictLine(loop, agreed);
  const earlier = loop.earlier.map(e => `Round ${e.round} found ${e.found || 'something'}; it went back to ${agentKind(loop.by).name}.`);
  const said = loop.reviews.map(r => `${agentKind(r.kind).name}${r.agrees ? ' agrees' : ''}:\n${r.text}`);
  return [replies, REVIEW_HEAD, verdict, ...earlier, ...said].filter(Boolean).join('\n\n');
}

/**
 * The reviewers' verdict in a line: "Codex agrees, after 1 round".
 * @param {Loop} loop
 * @param {boolean} agreed
 */
function verdictLine(loop, agreed) {
  const verdict = verdictOf({ reviews: loop.reviews, rounds: loop.round, agreed });
  return verdict ? `${verdict.text}, ${verdict.more}.` : '';
}

/**
 * The run ends, with the reviewers' verdict.
 * @param {Loop} loop
 * @param {boolean} agreed
 */
function done(loop, agreed) {
  stopAll(loop);
  const { schedule, run } = loop.going;
  const text = reportOf(loop, agreed);
  const verdict = verdictLine(loop, agreed);
  const headline = lastReply(loop).split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '';
  // The report the window shows is this one, reviews and all, not the first run's output. It's played back as a terminal's
  // output is, where a line feed alone doesn't go back to the start of the line.
  send(PAGE.scheduleKeep, { runId: run.id, output: text.replace(/\r?\n/g, '\r\n') });
  loop.finish({
    code: loop.code, summary: summaryOf(`${verdict} ${headline}`), costUsd: loop.cost || null, text,
    notice: schedule.replyInNotice ? `${verdict} ${noticeOf(lastReply(loop))}`.trim() : undefined,
  });
}

/**
 * Takes a loop off the runs going; what's still running is stopped.
 * @param {Loop} loop
 */
function stopAll(loop) {
  loops.delete(loop.going.run.id);
  for (const id of loop.waiting) {
    runs.delete(id);
    send(PAGE.scheduleStop, { runId: id });
  }
  loop.waiting.clear();
}

/**
 * Stops a schedule's run that's being reviewed. False when it isn't.
 * @param {string} runId the schedule's run
 */
export function stopReviews(runId) {
  const loop = loops.get(runId);
  if (!loop) return false;
  stopAll(loop);
  loop.finish({ stopped: true });
  return true;
}

/**
 * A reviewer's run ended: its review is kept, and with the round's last one, the round is over: they agree, or what they found
 * goes back while rounds are left.
 * @param {Loop} loop
 * @param {string} kind
 * @param {AgentResult | null} result
 * @param {string} why
 */
function reviewed(loop, kind, result, why) {
  loop.reviews.push(result && !result.errored ? readReview(kind, result.reply) : { kind, agrees: false, count: null, text: `It couldn’t review this. ${why}` });
  if (loop.waiting.size) return;
  const open = loop.reviews.filter(r => !r.agrees);
  if (!open.length) done(loop, true);
  else if (loop.round >= loop.rounds) done(loop, false);
  else {
    loop.earlier.push({ round: loop.round, found: open.reduce((sum, r) => sum + (r.count ?? 0), 0) });
    loop.open = open;
    fix(loop);
  }
}

/**
 * The fix's run ended: what it said is reviewed again. One whose session wouldn't open starts over in a new one; one that gave
 * nothing leaves the work as the reviewers last saw it.
 * @param {Loop} loop
 * @param {AgentResult | null} result
 */
function fixed(loop, result) {
  if (!result || result.errored) {
    if (loop.resumed) {
      loop.session = null;
      fix(loop);
    } else done(loop, false);
    return;
  }
  loop.replies.push([result.reply.trim(), result.failed ? result.why : ''].filter(Boolean).join('\n\n'));
  loop.session = result.session ?? loop.session;
  review(loop);
}

onHost(HOST.scheduleEnded, async m => {
  const id = m.runId ?? '';
  const hidden = runs.get(id);
  if (!hidden) return;
  const text = await plainText(m.tail ?? '');
  // Stopped meanwhile: the run has ended already.
  if (!runs.delete(id)) return;
  send(PAGE.scheduleForget, { runIds: [id] });
  const { loop, kind } = hidden;
  loop.waiting.delete(id);
  const result = m.stopped || m.error ? null : readResult(text, kind);
  loop.cost += result?.costUsd ?? 0;
  if (m.stopped) {
    // Stopped by its limit: the run ends there, as the first one's would.
    stopAll(loop);
    loop.finish({ stopped: true });
    return;
  }
  const why = m.error || (result?.errored ? result.why : '') || `${agentKind(kind).name} didn’t answer.`;
  if (hidden.review) reviewed(loop, kind, result, why);
  else fixed(loop, result);
});
