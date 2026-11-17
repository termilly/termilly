import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo } from '../e2e/repo.mjs';
import { run } from '../e2e/process.mjs';

const fakes = fileURLToPath(new URL('../e2e/fakes/', import.meta.url));

test('E2E repository has commits, branches and a working bare origin, then cleans up', async () => {
  const repo = await makeRepo({ files: { 'a.txt': 'first' }, commits: [
    { files: { 'a.txt': 'second', 'nested/b.txt': 'new' }, message: 'Second commit' },
  ], branches: ['topic'], remote: 'bare' });
  try {
    assert.equal(await repo.git('rev-list', '--count', 'HEAD'), '2');
    assert.equal(await repo.git('show', 'topic:a.txt'), 'second');
    assert.equal(await repo.git('status', '--porcelain'), '');
    assert.equal(await repo.git('rev-parse', 'origin/main'), await repo.git('rev-parse', 'HEAD'));
    await writeFile(path.join(repo.folder, 'a.txt'), 'third');
    await repo.git('commit', '-am', 'Third commit');
    await repo.git('push');
    assert.equal(await run('git', ['--git-dir', repo.origin, 'show', 'main:a.txt']), 'third');
  } finally { await repo.dispose(); }
  await assert.rejects(access(repo.root), { code: 'ENOENT' });
});

test('E2E repository rejects fixture paths outside its folder', async () => {
  await assert.rejects(makeRepo({ files: { '../escape.txt': 'bad' } }), /escapes repository/);
});

test('fake gh matches exact argv before prefixes, logs calls and rejects unknown commands', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'termilly-fake-test-'));
  try {
    const scenario = path.join(folder, 'scenario.json'), log = path.join(folder, 'calls.jsonl');
    await writeFile(scenario, JSON.stringify([
      { prefix: ['issue', 'view'], response: { title: 'Fallback' } },
      { args: ['issue', 'view', '7'], response: { title: 'Exact' } },
      { args: ['auth', 'token'], response: { stderr: 'Signed out', exitCode: 1 } },
    ]));
    const env = { ...process.env, E2E_GH_SCENARIO: scenario, E2E_GH_LOG: log };
    const gh = (...args) => run(process.execPath, [path.join(fakes, 'gh.mjs'), ...args], { env });
    assert.deepEqual(JSON.parse(await gh('issue', 'view', '7')), { title: 'Exact' });
    assert.deepEqual(JSON.parse(await gh('issue', 'view', '8')), { title: 'Fallback' });
    await assert.rejects(gh('auth', 'token'), /Signed out/);
    await assert.rejects(gh('unknown'), /no scenario/);
    assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse), [
      ['issue', 'view', '7'], ['issue', 'view', '8'], ['auth', 'token'], ['unknown'],
    ]);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('fake agents use configured output and record argv without shell interpolation', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'termilly-agent-test-'));
  try {
    const scripts = path.join(folder, 'agents.json'), log = path.join(folder, 'agents.jsonl');
    await writeFile(scripts, JSON.stringify({ claude: { stdout: 'Configured agent\n' } }));
    const args = ['claude', '--prompt', 'a $literal `prompt`'];
    const output = await run(process.execPath, [path.join(fakes, 'agent.mjs'), ...args], {
      cwd: folder, env: { ...process.env, E2E_AGENTS: scripts, E2E_AGENT_LOG: log },
    });
    assert.equal(output, 'Configured agent');
    const call = JSON.parse(await readFile(log, 'utf8'));
    assert.equal(call.agent, 'claude');
    assert.deepEqual(call.args, args.slice(1));
    assert.equal(path.resolve(call.cwd), path.resolve(folder));
  } finally { await rm(folder, { recursive: true, force: true }); }
});
