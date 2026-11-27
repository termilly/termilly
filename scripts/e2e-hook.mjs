// @ts-check
// Makes the end-to-end tests run by themselves after each commit (#97): a git post-commit hook starts
// scripts/e2e-run.mjs in the background, which tests what the commit touched on the test machine and writes its report.
// A commit with nothing to test (docs, unit tests) costs a moment. One run waits for another on the test machine.
//
// Run: node scripts/e2e-hook.mjs install | remove
// Reports go where E2E_REPORTS or `git config termilly.e2eReports` says (default tests/e2e/runs); the hook's own output
// goes to hook.log there.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Marks the hook as this one, so remove never deletes someone else's. */
const MARK = '# termilly: e2e after each commit';
const HOOK = `#!/bin/sh
${MARK} (scripts/e2e-hook.mjs). Runs in the background: the commit doesn't wait.
mkdir -p tests/e2e/runs
# The commit is read now: a second commit before the run starts gets its own run, not this one.
head=$(git rev-parse HEAD)
( node scripts/e2e-run.mjs --head "$head" >> tests/e2e/runs/hook.log 2>&1 & )
`;

/** The repository's hooks folder (a worktree's is its main repository's). */
const hookFile = () => path.resolve(root, execFileSync('git', ['rev-parse', '--git-path', 'hooks/post-commit'], { cwd: root, encoding: 'utf8' }).trim());

const [action] = process.argv.slice(2);
const file = hookFile();
const ours = existsSync(file) && readFileSync(file, 'utf8').includes(MARK);
if (action === 'install') {
  if (existsSync(file) && !ours) {
    console.error(`A post-commit hook of another kind is there (${file}): left as it is.`);
    process.exitCode = 1;
  } else {
    writeFileSync(file, HOOK);
    chmodSync(file, 0o755);
    console.log(`Installed: each commit runs the tests it needs (${file}).`);
  }
} else if (action === 'remove') {
  if (ours) rmSync(file);
  console.log(ours ? 'Removed.' : 'Nothing of ours to remove.');
} else {
  console.error('usage: node scripts/e2e-hook.mjs install | remove');
  process.exitCode = 2;
}
