// @ts-check
// Web addresses in a line of terminal text (weblinks.js makes them links): http:// and https:// only, and only real
// ones, with a host; what a sentence puts after an address (a full stop, a closing bracket or quote) isn't part of
// it. No imports, so the tests can load it on its own.

/** An address as it appears in text: the scheme, then anything up to a space, quote or angle bracket. */
export const WEB_ADDRESS = /\bhttps?:\/\/[^\s"'<>`]+/g;
/** What ends a sentence or a bracket after an address rather than belonging to it. */
const TRAILING = /[.,;:!?'"]+$/;
const CLOSERS = Object.freeze({ ')': '(', ']': '[', '}': '{' });

/**
 * The address without what follows it in a sentence: trailing punctuation, and a closing bracket the address
 * didn't open itself ("(see https://a.b/c)" ends at c, "https://a.b/wiki/X_(y)" keeps its bracket).
 * @param {string} text
 */
function trimEnd(text) {
  let out = text;
  for (;;) {
    const before = out;
    out = out.replace(TRAILING, '');
    const last = /** @type {keyof typeof CLOSERS} */ (out.slice(-1));
    if (CLOSERS[last] && out.split(CLOSERS[last]).length <= out.split(last).length - 1) out = out.slice(0, -1);
    if (out === before) return out;
  }
}

/**
 * The web addresses in a logical line: { start, end, text } by character offset, each one a URL with a host.
 * @param {string} text
 * @returns {Array<{ start: number, end: number, text: string }>}
 */
export function findWebLinks(text) {
  const found = [];
  WEB_ADDRESS.lastIndex = 0;
  for (let m; (m = WEB_ADDRESS.exec(text));) {
    const address = trimEnd(m[0]);
    try {
      if (!new URL(address).hostname) continue;
    } catch {
      continue; // not an address after all ("http://" alone, a broken one)
    }
    found.push({ start: m.index, end: m.index + address.length, text: address });
  }
  return found;
}
