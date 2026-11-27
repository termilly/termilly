// @ts-check
// Runs the end-to-end tests a change needs on the test machine and writes a report page (#97). The commit goes to the
// machine as refs/e2e/run; the tests run there in a copy of their own (~/e2e-runs/repo), never in a checkout someone
// works in, one run at a time. Results come back as JUnit, screenshots and app logs; the page goes to the reports
// folder with a page listing the runs.
//
// Run:  node scripts/e2e-run.mjs [--all | --release] [--base <commit>]   (--release: all, with the real agents)
// Env:  E2E_HOST     the test machine: a git remote and ssh name (default optiplex)
//       E2E_REPORTS  where report pages go (default tests/e2e/runs, ignored by git)
// Exit: 0 all passed or nothing to run, 1 a test failed, 2 the run itself failed (build, connection).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pick, coverageOf, importersOf } from './e2e-pick.mjs';
import { readJunit, reportHtml, indexHtml, failedCount, testCount } from './e2e-report.mjs';

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
/** Each run's commit goes to the test machine under a ref of its own: runs close together can't swap commits. */
const RUN_REF = 'refs/e2e/run-';
const LAST_RUN = 'last-run.json';
const RUNS = 'runs.json';
const EXIT = Object.freeze({ passed: 0, failed: 1, broken: 2 });
const E2E = 'tests/e2e/';

/** @param {string[]} args */
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** The commit tested last, if this branch still has it; else the one before HEAD. */
function baseCommit() {
  const file = path.join(reports, LAST_RUN);
  const last = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).commit : null;
  if (last) {
    try {
      git('merge-base', '--is-ancestor', last, 'HEAD');
      return last;
    } catch { /* not on this branch: from the commit before */ }
  }
  return git('rev-parse', 'HEAD~1');
}

/** The tests between two commits, as e2e-pick.mjs picks them. @param {string} base @param {string} head */
function picked(base, head) {
  const changed = git('diff', '--name-only', base, head).split('\n').filter(Boolean);
  const tests = new Map(git('ls-tree', '--name-only', head, E2E).split('\n').filter(f => f.endsWith('.e2e.mjs'))
    .map(f => [path.posix.basename(f), coverageOf(git('show', `${head}:${f}`))]));
  const modules = new Map(git('ls-tree', '-r', '--name-only', head, 'src/Termilly.Desktop/wwwroot/js/').split('\n').filter(f => f.endsWith('.js'))
    .map(f => [f, git('show', `${head}:${f}`)]));
  return { changed, ...pick({ changed, tests, importers: importersOf(modules) }) };
}

/**
 * The script the test machine runs: its copy at the commit, built, then each test file with its results kept.
 * @param {string[]} files
 * @param {boolean} realAgents with the real agents too (a release): the machine's own claude on PATH
 * @param {string} ref the commit's ref there
 */
function remoteScript(files, realAgents, ref) {
  // Linux and macOS alike: a lock folder (macOS has no flock), and .NET where it's installed for the user.
  return `set -e
export PATH="$HOME/.dotnet:$HOME/.local/node/bin:$HOME/.local/bin:$PATH"
export E2E_REAL_AGENTS=${realAgents ? 1 : 0}
[ -d "$HOME/.dotnet" ] && export DOTNET_ROOT="$HOME/.dotnet"
mkdir -p ~/e2e-runs
until mkdir ~/e2e-runs/lock.d 2>/dev/null; do sleep 5; done
trap 'rmdir ~/e2e-runs/lock.d' EXIT
R=~/e2e-runs/repo; OUT=~/e2e-runs/out
[ -d "$R/.git" ] || git clone -q ~/Development/termilly "$R"
cd "$R" && git fetch -q ~/Development/termilly ${ref} && git reset -q --hard FETCH_HEAD && git clean -fdq -e node_modules
git -C ~/Development/termilly update-ref -d ${ref}
if [ ! -d node_modules ] || ! cmp -s package-lock.json ../lock-seen; then npm ci --silent && cp package-lock.json ../lock-seen; fi
dotnet build src/Termilly.Linux -v q -nologo > ../build.log 2>&1 || { tail -30 ../build.log >&2; exit 3; }
rm -rf "$OUT" && mkdir -p "$OUT"
for f in ${files.map(f => `'${f}'`).join(' ')}; do
  n=$(basename "$f" .e2e.mjs); rm -rf tests/e2e/out
  node --test --test-concurrency=1 --test-reporter=junit --test-reporter-destination="$OUT/$n.xml" --test-reporter=spec --test-reporter-destination="$OUT/$n.log" "$f" || true
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
  const tests = existsSync(xml) ? readJunit(readFileSync(xml, 'utf8')) : [{ name: 'the test file ran', seconds: 0, failure: 'No results: the file did not run.', skipped: false }];
  const artifacts = filesUnder(path.join(back, `${name}.artifacts`));
  const screenshots = artifacts.filter(f => f.endsWith('.png')).map((f, i) => {
    const target = `${name}-${i}.png`;
    copyFileSync(f, path.join(pageDir, target));
    return `${runId}/${target}`;
  });
  const logFile = artifacts.find(f => path.basename(f) === 'app.log');
  return { file, tests, screenshots, log: logFile ? readFileSync(logFile, 'utf8') : null };
}

/** Adds the run to the runs page. @param {import('./e2e-report.mjs').Run} run @param {string} page */
function recordRun(run, page) {
  const file = path.join(reports, RUNS);
  const runs = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  runs.unshift({ page, commit: run.commit, subject: run.subject, failed: failedCount(run), total: testCount(run), at: run.at.toISOString() });
  writeFileSync(file, JSON.stringify(runs, null, 2));
  writeFileSync(path.join(reports, 'index.html'), indexHtml(runs));
  writeFileSync(path.join(reports, LAST_RUN), JSON.stringify({ commit: run.commit }));
}

function main() {
  const args = process.argv.slice(2);
  const head = git('rev-parse', 'HEAD');
  const base = args.includes('--base') ? git('rev-parse', args[args.indexOf('--base') + 1]) : baseCommit();
  const choice = picked(base, head);
  const release = args.includes('--release');
  const files = (release || args.includes('--all') ? [...new Set(git('ls-tree', '--name-only', head, E2E).split('\n').filter(f => f.endsWith('.e2e.mjs')))]
    : choice.tests.map(t => `${E2E}${t}`));
  mkdirSync(reports, { recursive: true });
  if (!files.length) {
    writeFileSync(path.join(reports, LAST_RUN), JSON.stringify({ commit: head }));
    console.log('No end-to-end tests needed for this change.');
    return EXIT.passed;
  }
  console.log(`Running ${files.length} test file(s) on ${host}: ${files.map(f => path.posix.basename(f, '.e2e.mjs')).join(', ')}`);
  const started = Date.now();
  try {
    execFileSync('git', ['push', '-q', '-f', host, `${head}:${RUN_REF}${head}`], { cwd: root, stdio: 'inherit' });
    execFileSync('ssh', [host, 'bash -s'], { input: remoteScript(files, release, `${RUN_REF}${head}`), stdio: ['pipe', 'inherit', 'inherit'] });
  } catch (error) {
    console.error(`The run itself failed: ${/** @type {Error} */ (error).message.split('\n')[0]}`);
    return EXIT.broken;
  }
  const back = mkdtempSync(path.join(tmpdir(), 'termilly-e2e-run-'));
  try {
    execFileSync('scp', ['-q', '-r', `${host}:e2e-runs/out/.`, back], { stdio: 'inherit' });
    const runId = `run-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${head.slice(0, 8)}`;
    const pageDir = path.join(reports, runId);
    mkdirSync(pageDir, { recursive: true });
    const run = { commit: head, subject: git('log', '-1', '--format=%s', head), branch: git('rev-parse', '--abbrev-ref', 'HEAD'), base,
      changed: choice.changed, all: release || args.includes('--all') || choice.all, files: files.map(f => fileRun(back, f, pageDir, runId)),
      seconds: (Date.now() - started) / 1000, at: new Date(), machine: host };
    const page = `${runId}.html`;
    writeFileSync(path.join(reports, page), reportHtml(run));
    recordRun(run, page);
    const failed = failedCount(run);
    console.log(`${failed ? `${failed} of ${testCount(run)} failed` : `All ${testCount(run)} passed`}: ${path.join(reports, page)}`);
    return failed ? EXIT.failed : EXIT.passed;
  } finally {
    rmSync(back, { recursive: true, force: true });
  }
}

process.exitCode = main();
