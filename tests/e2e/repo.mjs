// @ts-check
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from './process.mjs';

/** Creates an isolated Git fixture. Commits are { files, message }; branches are names or { name, start }. */
export async function makeRepo({ files = {}, commits = [], branches = [], remote = null } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'termilly-repo-'));
  const folder = path.join(root, 'work');
  await mkdir(folder);
  const config = path.join(root, 'gitconfig');
  await writeFile(config, '');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => run('git', args.flat(), { cwd: folder, env });
  const dispose = () => rm(root, { recursive: true, force: true });
  try {
    await git('init', '-b', 'main');
    await git('config', 'user.name', 'Termilly E2E');
    await git('config', 'user.email', 'e2e@example.invalid');
    await git('config', 'commit.gpgsign', 'false');
    await writeFiles(folder, files);
    if (Object.keys(files).length) {
      await git('add', '.');
      await git('commit', '-m', 'Initial files');
    }
    for (const commit of commits) {
      await writeFiles(folder, commit.files ?? {});
      await git('add', '-A');
      await git('commit', '--allow-empty', '-m', typeof commit === 'string' ? commit : commit.message ?? 'Fixture commit');
    }
    for (const branch of branches) await git('branch', ...(typeof branch === 'string' ? [branch] : [branch.name, branch.start ?? 'HEAD']));
    const origin = remote === 'bare' ? path.join(root, 'origin.git') : null;
    if (origin) {
      await run('git', ['init', '--bare', '-b', 'main', origin], { env });
      await git('remote', 'add', 'origin', origin);
      await git('push', '-u', 'origin', '--all');
    }
    return { folder, path: folder, root, origin, git, dispose, stop: dispose };
  } catch (error) { await dispose(); throw error; }
}

async function writeFiles(folder, files) {
  for (const [name, content] of Object.entries(files)) {
    const target = path.resolve(folder, name);
    if (!target.startsWith(folder + path.sep)) throw new Error(`Fixture file escapes repository: ${name}`);
    if (content === null) await rm(target, { force: true });
    else { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content); }
  }
}
