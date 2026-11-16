// @ts-check
// Web addresses in a line of terminal text (weblinks.js makes them links): http:// and https:// only, and only real
// ones, with a host; what a sentence or Markdown puts around an address (a full stop, a closing bracket or quote,
// **bold**, _italic_, ~~struck~~) isn't part of it. Agents write Markdown, and an address that took the closing "**"
// with it opens as "not found". No imports, so the tests can load it on its own.

/** An address as it appears in text: the scheme, then anything up to a space, quote or angle bracket. Not when it
 * follows a letter or digit ("xhttp://"), but after "_" or "*" it is: Markdown's markers. */
export const WEB_ADDRESS = /(?<![A-Za-z0-9])https?:\/\/[^\s"'<>`]+/g;
/** What ends a sentence or a bracket after an address rather than belonging to it. */
const TRAILING = /[.,;:!?'"]+$/;
/** Markdown's bold, italic and strikethrough markers after an address: an address doesn't end in "*" or "~". */
const MARKERS = /[*~]+$/;
/** "_" can end a real address (a_b_), so it's only dropped when one opened italic earlier on the line ("_see"). */
const UNDERSCORES = /_+$/;
const ITALIC_OPENED = /(?:^|[\s([{"'*~])_/;
const CLOSERS = Object.freeze({ ')': '(', ']': '[', '}': '{' });
/** What may stand around an address the selection holds alone: markers, brackets, quotes and sentence ends. */
const AROUND_BEFORE = /^[*_~([{"']*$/;
const AROUND_AFTER = /^[*_~)\]}"'.,;:!?]*$/;

/**
 * Whether the address ends with a closing bracket it didn't open itself.
 * @param {string} text
 */
function strayCloser(text) {
  const last = /** @type {keyof typeof CLOSERS} */ (text.slice(-1));
  return !!CLOSERS[last] && text.split(CLOSERS[last]).length <= text.split(last).length - 1;
}

/**
 * The address without what follows it in a sentence or in Markdown: trailing punctuation and markers, and a
 * closing bracket the address didn't open itself ("(see https://a.b/c)" ends at c, "https://a.b/wiki/X_(y)" keeps
 * its bracket), in any order ("(**https://a.b/c**).").
 * @param {string} text the address as found
 * @param {string} [before] the text before it on the line, which says whether a trailing "_" closes italic
 */
export function cleanWebAddress(text, before = '') {
  const italic = ITALIC_OPENED.test(before);
  let out = text;
  for (;;) {
    const was = out;
    out = out.replace(TRAILING, '').replace(MARKERS, '');
    if (italic) out = out.replace(UNDERSCORES, '');
    if (strayCloser(out)) out = out.slice(0, -1);
    if (out === was) return out;
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
    const address = cleanWebAddress(m[0], text.slice(0, m.index));
    try {
      if (!new URL(address).hostname) continue;
    } catch {
      continue; // not an address after all ("http://" alone, a broken one)
    }
    found.push({ start: m.index, end: m.index + address.length, text: address });
  }
  return found;
}

/**
 * The web address a selection holds alone, maybe in Markdown markers, brackets or quotes ("**https://a.b/c**"),
 * without them; null when the selection is anything else.
 * @param {string} text
 */
export function webAddressAlone(text) {
  const trimmed = text.trim();
  const found = findWebLinks(trimmed);
  if (found.length !== 1) return null;
  const [{ start, end, text: address }] = found;
  return AROUND_BEFORE.test(trimmed.slice(0, start)) && AROUND_AFTER.test(trimmed.slice(end)) ? address : null;
}
