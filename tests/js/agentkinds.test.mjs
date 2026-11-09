// Tests for agentkinds.js: which agent a running program is, and what resumes each one's session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENTS, agentKind, agentOfProgram } from '../../src/Termilly.Desktop/wwwroot/js/agentkinds.js';

test('a running program is its agent, with or without .exe and in any case', () => {
  assert.equal(agentOfProgram('codex.exe'), 'codex');
  assert.equal(agentOfProgram('Codex.EXE'), 'codex');
  assert.equal(agentOfProgram('codex'), 'codex');
  assert.equal(agentOfProgram('claude.exe'), 'claude');
  assert.equal(agentOfProgram('claude'), 'claude');
});

test('other programs, and none, are no agent', () => {
  for (const program of ['ssh.exe', 'vim', 'codexx', 'node.exe', '', null, undefined]) {
    assert.equal(agentOfProgram(program), null, String(program));
  }
});

test('each agent resumes its own way, and an unknown one is Claude Code', () => {
  assert.equal(agentKind('codex').resume('abc'), 'codex resume abc');
  assert.equal(agentKind('claude').resume('abc'), 'claude --resume abc');
  assert.equal(agentKind(undefined).name, 'Claude Code');
  assert.equal(agentKind('other').name, 'Claude Code');
});

test('every agent has a name, an icon and a program', () => {
  for (const [id, agent] of Object.entries(AGENTS)) {
    assert.ok(agent.name && agent.short && agent.icon && agent.program, id);
  }
});
