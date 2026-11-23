// @ts-check
// Leaving out what a program draws again (js/earlier.js): runs of lines that are exactly what a terminal kept already.
// They're compared without their spaces, so a redraw at another width, wrapped differently, still counts as the same;
// a line that only looks like one kept (the same phrases, other words) is new and stays, and so does a short line
// that comes again (real output).

/** Only runs of kept lines this long (characters, spaces left out) are left out. */
const LEAST_RUN = 300;
/** How much of what's kept is compared with (characters, spaces left out): the newest. */
const MOST_TEXT = 500_000;

/**
 * What a terminal kept, as one text without spaces (the newest MOST_TEXT characters).
 * @typedef {{ text: string }} Kept
 */

/** @param {string} line */
const bareOf = line => line.replace(/\s+/g, '');

/**
 * What's kept, from the lines the host has (its last ones, after a restart).
 * @param {string[]} [lines]
 * @returns {Kept}
 */
export const keptFrom = (lines = []) => ({ text: lines.map(bareOf).join('').slice(-MOST_TEXT) });

// Searching all that's kept for every new line made a flood of output (300,000 short lines) take minutes. What's kept
// is indexed instead: a GRAM-long piece at every STEP-th place. A run long enough to leave out spans one of them
// whole (STEP + GRAM - 1 <= LEAST_RUN), so only the places a piece of the run is found at are compared.
const GRAM = 32;
const STEP = 64;

/** @type {WeakMap<Kept, { text: string, at: Map<string, number[]> }>} the index of each Kept, for its text */
const indexes = new WeakMap();

/** @param {Kept} kept */
function indexOf(kept) {
  const known = indexes.get(kept);
  if (known?.text === kept.text) return known.at;
  /** @type {Map<string, number[]>} */
  const at = new Map();
  for (let p = 0; p + GRAM <= kept.text.length; p += STEP) {
    const gram = kept.text.slice(p, p + GRAM);
    const places = at.get(gram);
    if (places) places.push(p);
    else at.set(gram, [p]);
  }
  indexes.set(kept, { text: kept.text, at });
  return at;
}

/**
 * Whether the lines from `from`, up to the first LEAST_RUN characters (whole lines), are in what's kept: a run too
 * short to leave out ends before that.
 * @param {string[]} bare
 * @param {number} from
 * @param {Kept} kept
 */
function startsLongRun(bare, from, kept) {
  let head = '';
  for (let i = from; i < bare.length && head.length < LEAST_RUN; i++) head += bare[i];
  if (head.length < LEAST_RUN) return false;
  const at = indexOf(kept);
  for (let j = 0; j < STEP; j++) {
    for (const p of at.get(head.slice(j, j + GRAM)) ?? []) {
      if (p >= j && kept.text.startsWith(head, p - j)) return true;
    }
  }
  return false;
}

/**
 * How many lines from `from` make a run that is in what's kept, exactly and in order (blank lines go along).
 * @param {string[]} bare the lines without their spaces
 * @param {number} from
 * @param {Kept} kept
 * @returns {{ end: number, size: number }} the line after the run, and the run's length in characters
 */
function runFrom(bare, from, kept) {
  if (!startsLongRun(bare, from, kept)) return { end: from, size: 0 };
  let end = from, run = '', at = -1;
  while (end < bare.length) {
    const line = bare[end];
    if (line) {
      // Most often the run goes on right where it was found; else the longer text is looked for anew.
      const found = at >= 0 && kept.text.startsWith(line, at + run.length) ? at : kept.text.indexOf(run + line);
      if (found < 0) break;
      at = found;
      run += line;
    }
    end++;
  }
  return { end, size: run.length };
}

/**
 * The lines without the long runs kept already (a program drawing again what it drew before). What stays is kept.
 * @param {string[]} lines
 * @param {Kept} kept
 */
export function leaveOutRepeats(lines, kept) {
  const bare = lines.map(bareOf);
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const fresh = [];
  for (let i = 0; i < lines.length;) {
    const { end, size } = runFrom(bare, i, kept);
    if (size >= LEAST_RUN) {
      i = end;
      continue;
    }
    out.push(lines[i]);
    fresh.push(bare[i]);
    i++;
  }
  kept.text = (kept.text + fresh.join('')).slice(-MOST_TEXT);
  return out;
}
