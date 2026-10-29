// @ts-check
// The Files panel's work on files (filepanel.js), each action one note at the bottom of the window (toasts.js),
// however many files it takes: "Downloading 3 items", then "Downloaded 3 items to Downloads" with Show, or what
// failed. The host answers each file (files:done); a job counts them and speaks when the last one is in.

import { PAGE, HOST } from './protocol.js';
import { send, onHost, platform, PLATFORM } from './host.js';
import { showToast, TOAST } from './toasts.js';
import { parentOf } from './filepaths.js';

/** What a job does. */
export const JOB_KIND = Object.freeze({ put: 'put', get: 'get', rename: 'rename', delete: 'delete', mkdir: 'mkdir', open: 'open', copy: 'copy' });
/** Where this machine's deleted files go, and what shows them. */
export const BIN = platform === PLATFORM.windows ? 'the Recycle Bin' : 'the trash';
export const FILE_MANAGER = platform === PLATFORM.windows ? 'Explorer' : 'the file manager';

/**
 * What a job is called while it runs, once it's done, and when it fails ("Couldn't download …").
 * @typedef {{ doing: string, done: string, verb: string }} JobWords
 */
/** @type {Record<string, JobWords>} */
const WORDS = {
  [JOB_KIND.get]: { doing: 'Downloading', done: 'Downloaded', verb: 'download' },
  [JOB_KIND.put]: { doing: 'Uploading', done: 'Uploaded', verb: 'upload' },
  [JOB_KIND.copy]: { doing: 'Copying', done: 'Copied', verb: 'copy' },
  [JOB_KIND.delete]: { doing: 'Deleting', done: 'Deleted', verb: 'delete' },
  [JOB_KIND.rename]: { doing: 'Renaming', done: 'Renamed', verb: 'rename' },
  [JOB_KIND.mkdir]: { doing: 'Making folder', done: 'Made folder', verb: 'make folder' },
  [JOB_KIND.open]: { doing: 'Opening', done: 'Opened', verb: 'open' },
};
/** Copying in and deleting are other words on this machine: a copy, and a move to the bin. */
const HERE_WORDS = {
  [JOB_KIND.put]: { doing: 'Copying', done: 'Copied', verb: 'copy' },
  [JOB_KIND.delete]: { doing: 'Moving', done: 'Moved', verb: 'move' },
};

/**
 * A job: what it does to which files, where (said after "to"), its note, how many are done or failed (the last
 * failure's reason), where downloads went, and what to do once it's over (list a folder again).
 * @typedef {{ kind: string, names: string[], here: boolean, where: string | null, toast: import('./toasts.js').Toast | null,
 *   done: number, failed: number, error: string | null, locals: string[], after: (() => void) | null }} Job
 */
/** What a job is told when it starts. */
/** @typedef {{ kind: string, here?: boolean, where?: string | null, after?: (() => void) | null }} JobOptions */

/** @type {Map<string, Job>} */
const jobs = new Map();
/** Jobs whose files the host names once they're picked (an upload's, a "Download to"'s): request id → what they are. */
/** @type {Map<string, JobOptions>} */
const pending = new Map();
let requests = 0;

/** An id for the requests of one job: the host's answers carry it. */
export const newRequestId = () => `files${++requests}`;

/**
 * "a.txt", or "3 items".
 * @param {string[]} names
 */
const what = names => (names.length === 1 ? names[0] : `${names.length} items`);

/** @param {Job} job */
const wordsOf = job => (job.here && /** @type {Record<string, JobWords>} */ (HERE_WORDS)[job.kind]) || WORDS[job.kind];

/**
 * Where a job's files went, said after them: downloads where they were saved, a move to the bin.
 * @param {Job} job
 */
function whereOf(job) {
  if (job.kind === JOB_KIND.get && job.locals.length) return parentOf(job.locals[0]);
  if (job.kind === JOB_KIND.delete && job.here) return BIN;
  return job.where;
}

/**
 * Starts a job of `names`: its note says it's under way (opening a file says nothing unless it fails).
 * @param {string} requestId
 * @param {string[]} names
 * @param {JobOptions} options
 */
export function startJob(requestId, names, { kind, here = false, where = null, after = null }) {
  /** @type {Job} */
  const job = { kind, names, here, where, toast: null, done: 0, failed: 0, error: null, locals: [], after };
  if (kind !== JOB_KIND.open) {
    const to = job.where ? ` to ${job.where}` : '';
    job.toast = showToast({ text: `${wordsOf(job).doing} ${what(names)}${to}`, state: TOAST.running });
  }
  jobs.set(requestId, job);
}

/**
 * A job whose files the host names once they're picked: it starts when they're known (files:queued).
 * @param {string} requestId
 * @param {JobOptions} options
 */
export const expectJob = (requestId, options) => pending.set(requestId, options);

/**
 * What's said once every file is in: all done, some failed, or none could be.
 * @param {Job} job
 */
function finish(job) {
  const words = wordsOf(job);
  const where = whereOf(job);
  const to = where ? ` to ${where}` : '';
  const total = job.names.length;
  // A download can be shown where it went: the file, or the folder of several.
  const action = job.kind === JOB_KIND.get && job.locals.length
    ? { label: 'Show', run: () => send(PAGE.openPath, { path: job.locals.length === 1 ? job.locals[0] : parentOf(job.locals[0]) }) }
    : null;
  let text;
  if (!job.failed) text = `${words.done} ${what(job.names)}${to}`;
  else if (job.failed === total) text = `Couldn’t ${words.verb} ${what(job.names)}: ${job.error}`;
  else text = `${words.done} ${job.done} of ${total} items${to}. ${job.failed} failed: ${job.error}`;
  const state = job.failed ? TOAST.failed : TOAST.done;
  if (job.toast) job.toast.update({ text, state, action });
  else if (job.failed) showToast({ text, state });
  job.after?.();
}

onHost(HOST.filesDone, answer => {
  // files:done has a shape for each answer: a download says where it went, a failure why.
  const m = /** @type {{ requestId: string | null, ok: boolean, local?: string | null, message?: string }} */ (answer);
  const job = jobs.get(/** @type {string} */ (m.requestId));
  if (!job) return;
  if (m.ok) {
    job.done++;
    if (m.local) job.locals.push(m.local);
  } else {
    job.failed++;
    job.error = m.message ?? null;
  }
  if (job.done + job.failed < job.names.length) return;
  jobs.delete(/** @type {string} */ (m.requestId));
  finish(job);
});

// The files picked for an upload, or the ones a "Download to" downloads once its folder was picked.
onHost(HOST.filesQueued, m => {
  const options = pending.get(/** @type {string} */ (m.requestId));
  const names = /** @type {string[]} */ ((m.files ?? []).filter(Boolean));
  pending.delete(/** @type {string} */ (m.requestId));
  if (options && names.length) startJob(/** @type {string} */ (m.requestId), names, options);
});
