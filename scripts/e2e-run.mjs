// @ts-check
// Runs the end-to-end tests a change needs on the test machine and writes a report page (#97). The commit goes to the
// machine under a ref of the run's own; the tests run there in a copy of their own (~/e2e-runs/repo), never in a
// checkout someone works in, one run at a time. Results come back as JUnit, exit codes, screenshots and app logs; the
// page goes to the reports folder with a page listing the runs.
//
// Run:  node scripts/e2e-run.mjs [--all | --release] [--base <commit>] [--head <commit>]
//       (--release: all, with the real agents; --head: the commit to test, HEAD when not given)
// Env:  E2E_HOST     the test machine: a git remote and ssh name (default optiplex)
//       E2E_REPORTS  where report pages go (default tests/e2e/runs, ignored by git)
// Exit: 0 all passed or nothing to run, 1 a test failed, 2 the run itself failed (build, connection).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync, mkdtempSync, rmSync, renameSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickBetween, testFilesAt } from './e2e-pick.mjs';
import { readJunit, reportHtml, indexHtml, failedCount, testCount, skippedCount, withExit } from './e2e-report.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = process.env.E2E_HOST ?? 'optiplex';
/** A setting from git config (this repository's, then the user's), or null. @param {string} key */
function configured(key) {
  try {
    return execFileSync('git', ['config', '--get', key], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null; // not set
  }
}
const reports = path.resolve(root, process.env.E2E_REPORTS ?? configured('termilly.e2eReports') ?? 'tests/e2e/runs');
/** Each run's commit goes to the test machine under a ref of the run's own: runs close together can't swap commits. */
const RUN_REF = 'refs/e2e/run-';
const LAST_RUN = 'last-run.json';
const RUNS = 'runs.json';
/** Held while a run updates the runs page, so two runs finishing together don't lose one. */
const PAGE_LOCK = '.runs.lock';
const PAGE_LOCK_TRIES = 600;
const PAGE_LOCK_WAIT_MS = 100;
/** How long a run waits on the test machine for the one before it, in seconds: past this something is stuck. */
const MACHINE_WAIT_S = 4 * 60 * 60;
const EXIT = Object.freeze({ passed: 0, failed: 1, broken: 2 });
const E2E = 'tests/e2e/';

/** @param {string[]} args */
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** Whether one commit is in another's history. @param {string} older @param {string} newer */
function isAncestor(older, newer) {
  try {
    git('merge-base', '--is-ancestor', older, newer);
    return true;
  } catch {
    return false; // not an ancestor, or not a commit here
  }
}

/** The commit tested last. @returns {string | null} */
function lastTested() {
  const file = path.join(reports, LAST_RUN);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).commit ?? null : null;
}

/** The commit tested last, if the tested commit has it in its history; else the one before. @param {string} head */
function baseCommit(head) {
  const last = lastTested();
  return last && isAncestor(last, head) ? last : git('rev-parse', `${head}~1`);
}

/**
 * The lock on the test machine: a folder (macOS has no flock) holding the owner's process id. A lock whose owner is
 * gone (killed, the machine restarted) is taken over; a run waits for a live one at most MACHINE_WAIT_S.
 */
const LOCK_SCRIPT = `L=~/e2e-runs/lock.d; waited=0
until mkdir "$L" 2>/dev/null; do
  owner=$(cat "$L/pid" 2>/dev/null || true)
  if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null && [ "$(cat "$L/pid" 2>/dev/null)" = "$owner" ]; then
    echo "Taking over the lock of run $owner, which is gone." >&2; mv "$L" "$L.stale.$$" && rm -rf "$L.stale.$$" || true; continue
  fi
  [ ! -d "$L" ] || [ "$waited" -lt ${MACHINE_WAIT_S} ] || { echo "Waited ${MACHINE_WAIT_S} s for the run before (process $owner)." >&2; exit 5; }
  sleep 5; waited=$((waited + 5))
done
echo $$ > "$L/pid"
trap 'rm -rf "$L"' EXIT`;

/**
 * The script the test machine runs: its copy at the commit, built, then each test file with its results kept. Each
 * step stands alone, so set -e stops the run at the first that fails.
 * @param {{ files: string[], realAgents: boolean, ref: string, commit: string, out: string }} run
 *   realAgents: with the real agents too (a release), the machine's own claude on PATH; out: the run's results folder
 */
function remoteScript({ files, realAgents, ref, commit, out }) {
  // .NET where it's installed for the user. ~/.dotnet alone isn't an install: the .NET CLI keeps its first-run marks
  // there wherever .NET is installed.
  return `set -e
export PATH="$HOME/.dotnet:$HOME/.local/node/bin:$HOME/.local/bin:$PATH"
export E2E_REAL_AGENTS=${realAgents ? 1 : 0}
if [ -x "$HOME/.dotnet/dotnet" ]; then export DOTNET_ROOT="$HOME/.dotnet"; fi
mkdir -p ~/e2e-runs
${LOCK_SCRIPT}
R=~/e2e-runs/repo; OUT=~/e2e-runs/${out}
if [ ! -d "$R/.git" ]; then git clone -q ~/Development/termilly "$R"; fi
cd "$R"
git fetch -q ~/Development/termilly ${ref}
git -C ~/Development/termilly update-ref -d ${ref}
git reset -q --hard FETCH_HEAD
git clean -fdq -e node_modules
[ "$(git rev-parse HEAD)" = "${commit}" ] || { echo "The copy is at $(git rev-parse HEAD), not ${commit}." >&2; exit 4; }
if [ ! -d node_modules ] || ! cmp -s package-lock.json ../lock-seen; then
  npm ci --silent
  cp package-lock.json ../lock-seen
fi
dotnet build src/Termilly.Linux -v q -nologo > ../build.log 2>&1 || { tail -30 ../build.log >&2; exit 3; }
rm -rf "$OUT"
mkdir -p "$OUT"
for f in ${files.map(f => `'${f}'`).join(' ')}; do
  n=$(basename "$f" .e2e.mjs); rm -rf tests/e2e/out
  code=0
  node --test --test-concurrency=1 --test-reporter=junit --test-reporter-destination="$OUT/$n.xml" --test-reporter=spec --test-reporter-destination="$OUT/$n.log" "$f" || code=$?
  echo "$code" > "$OUT/$n.exit"
  if [ -d tests/e2e/out ]; then cp -r tests/e2e/out "$OUT/$n.artifacts"; fi
done`;
}

/** Every file under a folder, its path from there. @param {string} dir @returns {string[]} */
const filesUnder = dir => (existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter(e => e.isFile()).map(e => path.join(e.parentPath, e.name)) : []);

/**
 * One test file's results from what came back, its screenshots copied next to the report.
 * @param {string} back @param {string} file @param {string} pageDir @param {string} runId
 * @returns {import('./e2e-report.mjs').FileRun}
 */
function fileRun(back, file, pageDir, runId) {
  const name = path.posix.basename(file, '.e2e.mjs');
  const xml = path.join(back, `${name}.xml`);
  const exitFile = path.join(back, `${name}.exit`);
  const exitCode = existsSync(exitFile) ? Number(readFileSync(exitFile, 'utf8').trim()) : -1;
  const tests = withExit(existsSync(xml) ? readJunit(readFileSync(xml, 'utf8')) : [], exitCode);
  const artifacts = filesUnder(path.join(back, `${name}.artifacts`));
  const screenshots = artifacts.filter(f => f.endsWith('.png')).map((f, i) => {
    const target = `${name}-${i}.png`;
    copyFileSync(f, path.join(pageDir, target));
    return `${runId}/${target}`;
  });
  const logFile = artifacts.find(f => path.basename(f) === 'app.log');
  return { file, tests, screenshots, log: logFile ? readFileSync(logFile, 'utf8') : null };
}

/** Writes a file whole or not at all: readers never see half of it. @param {string} file @param {string} text */
function writeWhole(file, text) {
  const part = `${file}.${process.pid}.part`;
  writeFileSync(part, text);
  renameSync(part, file);
}

/** Runs a change to the runs page while no other run makes one. @param {() => void} change */
function withPageLock(change) {
  const lock = path.join(reports, PAGE_LOCK);
  for (let tries = 0; ; tries++) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST' || tries >= PAGE_LOCK_TRIES) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, PAGE_LOCK_WAIT_MS);
    }
  }
  try {
    change();
  } finally {
    rmdirSync(lock);
  }
}

/** Marks a commit tested, unless a newer one already is (an older run finishing late). @param {string} commit */
function markTested(commit) {
  const last = lastTested();
  if (last && last !== commit && isAncestor(commit, last)) return;
  writeWhole(path.join(reports, LAST_RUN), JSON.stringify({ commit }));
}

/** Adds the run to the runs page. @param {import('./e2e-report.mjs').Run} run @param {string} page */
function recordRun(run, page) {
  withPageLock(() => {
    const file = path.join(reports, RUNS);
    const runs = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
    runs.unshift({ page, commit: run.commit, subject: run.subject, failed: failedCount(run), total: testCount(run), at: run.at.toISOString() });
    writeWhole(file, JSON.stringify(runs, null, 2));
    writeWhole(path.join(reports, 'index.html'), indexHtml(runs));
    markTested(run.commit);
  });
}

/** The command line: what to test and how. @param {string[]} args */
function options(args) {
  const value = (/** @type {string} */ flag) => (args.includes(flag) ? git('rev-parse', `${args[args.indexOf(flag) + 1]}^{commit}`) : null);
  const head = value('--head') ?? git('rev-parse', 'HEAD');
  const release = args.includes('--release');
  return { head, base: value('--base') ?? baseCommit(head), release, all: release || args.includes('--all') };
}

/**
 * Sends the commit, runs the tests there and brings their results back to a folder of its own.
 * @param {{ head: string, files: string[], release: boolean, runId: string }} run
 * @returns {string} the results folder here
 */
function runThere({ head, files, release, runId }) {
  const ref = `${RUN_REF}${runId}`, out = `out/${runId}`;
  execFileSync('git', ['push', '-q', '-f', host, `${head}:${ref}`], { cwd: root, stdio: 'inherit' });
  try {
    execFileSync('ssh', [host, 'bash -s'], { input: remoteScript({ files, realAgents: release, ref, commit: head, out }), stdio: ['pipe', 'inherit', 'inherit'] });
  } catch (error) {
    // Stopped before it took the ref, or after it wrote some results: neither is left behind on the machine.
    try {
      execFileSync('ssh', [host, `git -C ~/Development/termilly update-ref -d ${ref}; rm -rf ~/e2e-runs/${out}`], { stdio: 'ignore' });
    } catch { /* unreachable now: the next run's clean start doesn't depend on it */ }
    throw error;
  }
  const back = mkdtempSync(path.join(tmpdir(), 'termilly-e2e-run-'));
  execFileSync('scp', ['-q', '-r', `${host}:e2e-runs/${out}/.`, back], { stdio: 'inherit' });
  execFileSync('ssh', [host, `rm -rf ~/e2e-runs/${out}`], { stdio: 'inherit' });
  return back;
}

function main() {
  const { head, base, release, all } = options(process.argv.slice(2));
  const choice = pickBetween(base, head);
  const files = all ? testFilesAt(head) : choice.tests.map(t => `${E2E}${t}`);
  mkdirSync(reports, { recursive: true });
  if (!files.length) {
    withPageLock(() => markTested(head));
    console.log('No end-to-end tests needed for this change.');
    return EXIT.passed;
  }
  console.log(`Running ${files.length} test file(s) on ${host}: ${files.map(f => path.posix.basename(f, '.e2e.mjs')).join(', ')}`);
  const started = Date.now();
  const runId = `run-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${head.slice(0, 8)}-${process.pid}`;
  let back;
  try {
    back = runThere({ head, files, release, runId });
  } catch (error) {
    console.error(`The run itself failed: ${/** @type {Error} */ (error).message.split('\n')[0]}`);
    return EXIT.broken;
  }
  try {
    const pageDir = path.join(reports, runId);
    mkdirSync(pageDir, { recursive: true });
    const run = { commit: head, subject: git('log', '-1', '--format=%s', head), branch: git('rev-parse', '--abbrev-ref', 'HEAD'), base,
      changed: choice.changed, all: all || choice.all, files: files.map(f => fileRun(back, f, pageDir, runId)),
      seconds: (Date.now() - started) / 1000, at: new Date(), machine: host };
    const page = `${runId}.html`;
    writeWhole(path.join(reports, page), reportHtml(run));
    recordRun(run, page);
    const failed = failedCount(run), skipped = skippedCount(run) ? `, ${skippedCount(run)} skipped` : '';
    console.log(`${failed ? `${failed} of ${testCount(run)} failed` : `All ${testCount(run)} passed`}${skipped}: ${path.join(reports, page)}`);
    return failed ? EXIT.failed : EXIT.passed;
  } finally {
    rmSync(back, { recursive: true, force: true });
  }
}

process.exitCode = main();
