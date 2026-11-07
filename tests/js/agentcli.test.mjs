// Tests for agentcli.js: how Claude Code is asked with nobody watching, and what its answer says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentCommand, readResult, noticeOf } from '../../src/Termilly.Desktop/wwwroot/js/agentcli.js';

const result = (extra = {}) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'All good.\nSecond line.', permission_denials: [], total_cost_usd: 0.02, ...extra });

test('read only gets tools that only read, and leaves the user\'s settings out', () => {
  const line = agentCommand('Summarize it', { shell: 'bash' });
  assert.match(line, /--restricted/);
  assert.match(line, /--tools Read,Grep,Glob,WebFetch,WebSearch/);
  assert.doesNotMatch(line, /Bash|Edit|Write|acceptEdits|bypassPermissions|dangerously/);
});

test('nothing it does can wait for an answer, whatever it may do', () => {
  for (const changes of [false, true]) {
    const line = agentCommand('x', { shell: 'bash', changes });
    assert.match(line, /--permission-prompts none/);
    assert.match(line, /--strict-mcp-config/);
    assert.match(line, /--no-session-persistence/);
  }
});

test('changes are only allowed when asked for', () => {
  assert.match(agentCommand('x', { shell: 'bash', changes: true }), /--permission-mode acceptEdits/);
  assert.doesNotMatch(agentCommand('x', { shell: 'bash', changes: true }), /--restricted/);
  assert.doesNotMatch(agentCommand('x', { shell: 'bash' }), /--permission-mode/);
});

test('its answer comes as JSON only when something reads it', () => {
  assert.match(agentCommand('x', { shell: 'bash', json: true }), /--output-format json/);
  assert.doesNotMatch(agentCommand('x', { shell: 'bash' }), /--output-format/);
});

test('a prompt stays one word in each shell', () => {
  assert.match(agentCommand("it's two\nlines", { shell: 'bash', json: true }), /^claude --print 'it'\\''s two\nlines' /);
  assert.match(agentCommand('say "hi"', { shell: 'powershell', json: true }), /^claude --print 'say ''hi''' /);
  assert.match(agentCommand('one\ntwo "x"', { shell: 'cmd', json: true }), /^claude --print "one two \\"x\\"" /);
});

test('a result that worked gives its reply', () => {
  assert.deepEqual(readResult(result()), { reply: 'All good.\nSecond line.', failed: false, why: '', costUsd: 0.02 });
});

test('what a shell printed before it doesn\'t matter', () => {
  assert.equal(readResult(`Welcome {not json}\n${result()}\n`)?.reply, 'All good.\nSecond line.');
});

test('a run refused a tool failed, and says which', () => {
  const r = readResult(result({ permission_denials: [{ tool_name: 'Bash' }, { tool_name: 'Bash' }, { tool_name: 'Write' }] }));
  assert.equal(r?.failed, true);
  assert.equal(r?.why, 'It needed permission for Bash, Write.');
});

test('many refused tools are not all named', () => {
  const r = readResult(result({ permission_denials: ['A', 'B', 'C', 'D', 'E'].map(tool_name => ({ tool_name })) }));
  assert.equal(r?.why, 'It needed permission for A, B, C and 2 more.');
});

test('an error says what it was', () => {
  const r = readResult(result({ is_error: true, subtype: 'error_max_budget_usd', result: undefined, errors: ['Over budget.'] }));
  assert.equal(r?.failed, true);
  assert.equal(r?.why, 'Over budget.');
  assert.equal(readResult(result({ is_error: true, subtype: 'error_during_execution' }))?.why, 'error_during_execution');
});

test('output that isn\'t its result is nothing to read', () => {
  assert.equal(readResult('claude: command not found'), null);
  assert.equal(readResult(''), null);
  assert.equal(readResult('{"type":"other"}'), null);
  assert.equal(readResult('{"broken'), null);
});

test('a notification gets the start of a long reply', () => {
  assert.equal(noticeOf(' short \n'), 'short');
  const long = noticeOf('x'.repeat(500));
  assert.equal(long.length, 280);
  assert.ok(long.endsWith('…'));
});

test('a prompt typed into a terminal is one line', () => {
  assert.match(agentCommand('one\n  two', { shell: 'bash' }), /^claude --print 'one two' /);
});
