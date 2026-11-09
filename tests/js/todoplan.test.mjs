// Tests for todoplan.js: Implement's plan (who works, who reviews, how many rounds), what a task's row says while its agents
// work, and how a reviewer's reply is read. And for agentcli.js: how Codex and a review are asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitPlan, reviewersFor, planWords, stageWords, reviewPrompt, fixPrompt, readReview, verdictOf, RUN, STAGE, ROUNDS } from '../../src/Termilly.Desktop/wwwroot/js/todoplan.js';
import { agentCommand, readResult } from '../../src/Termilly.Desktop/wwwroot/js/agentcli.js';

const BOTH = ['claude', 'codex'];

test('with nothing saved, the first agent works, nobody reviews, in a new terminal', () => {
  assert.deepEqual(fitPlan(null, BOTH), { by: 'claude', reviewers: [], rounds: ROUNDS.usual, run: RUN.terminal });
  assert.deepEqual(fitPlan(undefined, ['codex']), { by: 'codex', reviewers: [], rounds: ROUNDS.usual, run: RUN.terminal });
});

test('a saved plan is kept where its agents are still installed', () => {
  const saved = { by: 'codex', reviewers: ['claude'], rounds: 2, run: RUN.silent };
  assert.deepEqual(fitPlan(saved, BOTH), saved);
  // Codex was removed: Claude Code does the work, and can't review itself.
  assert.deepEqual(fitPlan(saved, ['claude']), { by: 'claude', reviewers: [], rounds: 2, run: RUN.silent });
});

test('an agent never reviews its own work, and rounds stay within their limits', () => {
  assert.deepEqual(fitPlan({ by: 'claude', reviewers: ['claude', 'codex', 'codex'] }, BOTH).reviewers, ['codex']);
  assert.equal(fitPlan({ rounds: 0 }, BOTH).rounds, ROUNDS.usual);
  assert.equal(fitPlan({ rounds: 99 }, BOTH).rounds, ROUNDS.max);
  assert.equal(fitPlan({ rounds: 1 }, BOTH).rounds, 1);
});

test('reviewers are offered only when another agent is installed', () => {
  assert.deepEqual(reviewersFor('claude', BOTH), ['codex']);
  assert.deepEqual(reviewersFor('claude', ['claude']), []);
});

test('a plan in words', () => {
  assert.equal(planWords({ by: 'claude', reviewers: ['codex'], rounds: 3, run: RUN.silent }), 'Claude Code, reviewed by Codex, silently');
  assert.equal(planWords({ by: 'codex', reviewers: [], rounds: 3, run: RUN.terminal }), 'Codex, in a new terminal');
});

test('a task\'s row says who has it now', () => {
  const plan = { by: 'claude', reviewers: ['codex'], rounds: 3, run: RUN.silent };
  assert.deepEqual(stageWords(plan, { what: STAGE.working, round: 0 }), { kind: 'claude', text: 'Claude Code is working. Codex reviews next' });
  assert.deepEqual(stageWords(plan, { what: STAGE.reviewing, round: 1 }), { kind: 'codex', text: 'Codex is reviewing, round 1 of 3' });
  assert.deepEqual(stageWords(plan, { what: STAGE.fixing, round: 2, count: 2 }), { kind: 'claude', text: 'Claude Code is fixing 2 findings from Codex, round 2 of 3' });
  assert.equal(stageWords(plan, { what: STAGE.fixing, round: 2, count: null }).text, 'Claude Code is fixing what Codex found, round 2 of 3');
  assert.equal(stageWords({ ...plan, reviewers: [] }, undefined).text, 'Claude Code is working');
  assert.equal(stageWords({ ...plan, rounds: 1 }, { what: STAGE.reviewing, round: 1 }).text, 'Codex is reviewing');
});

test('a reviewer is told to change nothing and to end with its verdict', () => {
  const prompt = reviewPrompt('Add a  filter\nicon', 'Claude Code', 'Added it in todopanel.js.');
  assert.match(prompt, /'Add a filter icon'/);
  assert.match(prompt, /Claude Code says: Added it in todopanel\.js\./);
  assert.match(prompt, /Do not change, create or delete any file/);
  assert.match(prompt, /VERDICT: AGREE/);
  assert.match(prompt, /VERDICT: FINDINGS N/);
  assert.match(reviewPrompt('t', 'Codex', 'r', [{ kind: 'claude', agrees: false, count: 1, text: '1. A bug' }]), /In the round before, the review found this.*1\. A bug/);
});

test('findings go back with how to finish', () => {
  const reviews = [{ kind: 'codex', agrees: false, count: 2, text: '1. A\n2. B' }];
  assert.match(fixPrompt('The task', reviews, ''), /Codex found: 1\. A\n2\. B Fix what is right.*reply with a short summary/s);
  assert.match(fixPrompt('The task', reviews, ' Call finish_task.'), /say why\. Call finish_task\.$/);
});

test('a review\'s verdict is read from its last line', () => {
  assert.deepEqual(readReview('codex', 'Looks right.\n\nVERDICT: AGREE'), { kind: 'codex', agrees: true, count: 0, text: 'Looks right.' });
  assert.deepEqual(readReview('codex', '1. A bug in a.js\n2. A test is missing\nVERDICT: FINDINGS 2'), { kind: 'codex', agrees: false, count: 2, text: '1. A bug in a.js\n2. A test is missing' });
  // Dressed up, as agents do.
  assert.equal(readReview('codex', 'Fine.\n**VERDICT: AGREE**').agrees, true);
  assert.equal(readReview('codex', '- one\n- two\n- three\nverdict: findings').count, 3);
  assert.equal(readReview('codex', 'VERDICT: AGREE').text, 'Nothing found.');
});

test('a review without a verdict doesn\'t agree', () => {
  const review = readReview('claude', 'I looked at the files.');
  assert.equal(review.agrees, false);
  assert.equal(review.count, null);
  assert.equal(readReview('claude', '').text, 'It gave no verdict.');
  // A list of what's fine isn't a count of findings.
  assert.equal(readReview('codex', 'No issues found:\n- math.js is right\n- README.md too').count, null);
});

test('the verdict a task in Review leads with', () => {
  assert.equal(verdictOf({ summary: 's', by: 'b' }), null);
  assert.deepEqual(verdictOf({ agreed: true, rounds: 2, reviews: [{ kind: 'codex', agrees: true, count: 0, text: '' }] }), { agreed: true, text: 'Codex agrees', more: 'after 2 rounds' });
  assert.deepEqual(verdictOf({ agreed: false, rounds: 3, reviews: [{ kind: 'codex', agrees: false, count: 1, text: '' }, { kind: 'claude', agrees: true, count: 0, text: '' }] }),
    { agreed: false, text: 'No agreement after 3 rounds', more: '1 point still open' });
  assert.equal(verdictOf({ agreed: false, rounds: 1, reviews: [{ kind: 'codex', agrees: false, count: null, text: '' }] })?.text, 'No agreement after 1 round');
});

test('Codex runs without a terminal, in a sandbox that fits what it may do', () => {
  assert.match(agentCommand('Do it', { kind: 'codex', shell: 'bash', changes: true, json: true }), /^codex exec --skip-git-repo-check --json --sandbox workspace-write 'Do it'$/);
  assert.match(agentCommand('Look', { kind: 'codex', shell: 'bash' }), /--sandbox read-only/);
  assert.match(agentCommand('Review', { kind: 'codex', shell: 'bash', changes: true, review: true }), /--sandbox read-only/);
  assert.match(agentCommand('Do it', { kind: 'codex', shell: 'bash', changes: true, all: true }), /--dangerously-bypass-approvals-and-sandbox/);
  assert.doesNotMatch(agentCommand('Do it', { kind: 'codex', shell: 'bash', changes: true }), /claude|--print|permission/);
});

test('a prompt for Codex is one line cmd can pass on: no line break, double quote or percent sign', () => {
  const line = agentCommand('It says:\n- "done" & 100% of %PATH%\r\n  VERDICT last', { kind: 'codex', shell: 'powershell', review: true });
  assert.match(line, /'It says: - ''done'' & 100\uFF05 of \uFF05PATH\uFF05 VERDICT last'$/);
  assert.doesNotMatch(line, /[\r\n"%]/);
});

test('a review by Claude Code reads, and looks at what changed with git, nothing more', () => {
  const line = agentCommand('Review', { shell: 'bash', json: true, review: true });
  assert.match(line, /--restricted/);
  assert.match(line, /--tools Read,Grep,Glob,WebFetch,WebSearch,Bash/);
  assert.match(line, /Bash\(git diff:\*\)/);
  assert.match(line, /--permission-prompts none/);
  assert.doesNotMatch(line, /acceptEdits|bypassPermissions|--permission-mode/);
});

test('Claude Code is asked as before when no agent is named', () => {
  assert.equal(agentCommand('x', { shell: 'bash', changes: true }), agentCommand('x', { kind: 'claude', shell: 'bash', changes: true }));
  assert.match(agentCommand('x', { shell: 'bash', changes: true }), /^claude --print x --permission-mode auto --strict-mcp-config --no-session-persistence --permission-prompts none$/);
});

test('Codex\'s answer is its last message', () => {
  const out = ['Reading additional input from stdin...', '{"type":"thread.started","thread_id":"01a1"}', '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Looking."}}',
    '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Done.\\nVERDICT: AGREE"}}',
    '{"type":"turn.completed","usage":{"input_tokens":1}}'].join('\r\n');
  assert.deepEqual(readResult(out, 'codex'), { reply: 'Done.\nVERDICT: AGREE', failed: false, errored: false, why: '', costUsd: null });
});

test('Codex failing, or not there at all', () => {
  const failed = readResult('{"type":"thread.started","thread_id":"1"}\n{"type":"turn.failed","error":{"message":"Out of credits"}}', 'codex');
  assert.equal(failed?.errored, true);
  assert.equal(failed?.why, 'Out of credits');
  assert.equal(readResult('codex: command not found', 'codex'), null);
});

test('Codex in a terminal someone may look at answers in words, not JSON lines', () => {
  assert.equal(agentCommand('Summarize', { kind: 'codex', shell: 'bash' }), "codex exec --skip-git-repo-check --sandbox read-only Summarize");
  assert.match(agentCommand('Summarize', { kind: 'codex', shell: 'bash', json: true }), /^codex exec --skip-git-repo-check --json --sandbox read-only/);
});
