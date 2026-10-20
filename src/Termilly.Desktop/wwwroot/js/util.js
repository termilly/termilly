// @ts-check
// Small helpers with no page or state of their own: timing and wording.

/** Seconds in a minute, an hour and a day. */
export const MINUTE_S = 60;
export const HOUR_S = 3600;
export const DAY_S = 86400;
/** Days in a week: past that many days, a time is a date. */
export const WEEK_DAYS = 7;
const THOUSAND = 1000;
const MILLION = 1e6;
/** Below these, one more decimal: 1.2k under 10k, 1.25M under 10M. */
const FINE_THOUSANDS = 10_000;
const FINE_MILLIONS = 1e7;
const MS_PER_SECOND = 1000;

/** Durations in milliseconds. */
export const SECOND_MS = MS_PER_SECOND;
export const MINUTE_MS = MINUTE_S * SECOND_MS;
export const HOUR_MS = HOUR_S * SECOND_MS;
export const DAY_MS = DAY_S * SECOND_MS;
/** How a date is written: "12 Mar" this year, "12 Mar 2024" another. */
/** @type {Intl.DateTimeFormatOptions} */
const THIS_YEAR = { day: 'numeric', month: 'short' };
/** @type {Intl.DateTimeFormatOptions} */
const OTHER_YEAR = { day: 'numeric', month: 'short', year: 'numeric' };

/**
 * A function that runs `fn` once `ms` after the last call to it, with that call's arguments: for work that follows
 * a burst of changes (saving, refreshing) and only needs to happen once at the end.
 * @template {any[]} A
 * @param {(...args: A) => void} fn
 * @param {number} ms
 * @returns {((...args: A) => void) & { cancel: () => void }}
 */
export function debounce(fn, ms) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const run = /** @type {((...args: A) => void) & { cancel: () => void }} */ ((...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  });
  run.cancel = () => clearTimeout(timer);
  return run;
}

/**
 * How long ago a time was, in words: "just now", "3 min ago", "2 h ago", then "yesterday" and "4 days ago" (unless
 * `days` is false), then the date ("12 Mar", "12 Mar 2024" for another year).
 * @param {number} at milliseconds since 1970
 * @param {{ days?: boolean }} [options]
 */
export function timeAgo(at, { days = true } = {}) {
  const s = (Date.now() - at) / MS_PER_SECOND;
  if (s < MINUTE_S) return 'just now';
  if (s < HOUR_S) return `${Math.round(s / MINUTE_S)} min ago`;
  if (s < DAY_S) return `${Math.round(s / HOUR_S)} h ago`;
  if (!days) return new Date(at).toLocaleDateString();
  if (s < 2 * DAY_S) return 'yesterday';
  if (s < WEEK_DAYS * DAY_S) return `${Math.round(s / DAY_S)} days ago`;
  const d = new Date(at);
  return d.toLocaleDateString(undefined, d.getFullYear() === new Date().getFullYear() ? THIS_YEAR : OTHER_YEAR);
}

/**
 * Tokens in short: 950, 12.3k, 1.25M.
 * @param {number} n
 */
export function formatTokens(n) {
  if (n < THOUSAND) return String(n);
  if (n < MILLION) return `${n < FINE_THOUSANDS ? (n / THOUSAND).toFixed(1) : Math.round(n / THOUSAND)}k`;
  return `${(n / MILLION).toFixed(n < FINE_MILLIONS ? 2 : 1).replace(/\.?0+$/, '')}M`;
}
