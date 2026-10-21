// @ts-check
// `snippet:` at a prompt: what has to be typed to start it, and which snippets match what follows. No imports, so
// the tests can load it on its own; snippetprompt.js does the typing and the popup.

/** Typed at an empty prompt, this starts picking a snippet (any case). */
export const SNIPPET_PREFIX = 'snippet:';

/**
 * Whether `typed` could still become the prefix: it's the start of it, or all of it.
 * @param {string} typed
 */
export const startsPrefix = typed => !!typed && SNIPPET_PREFIX.startsWith(typed.toLowerCase());

/**
 * Whether `typed` is the whole prefix and maybe a name after it.
 * @param {string} typed
 */
export const hasPrefix = typed => typed.toLowerCase().startsWith(SNIPPET_PREFIX);

/**
 * The snippets whose name matches `query`: an exact name first, then names that start with it, then names that
 * contain it, each group in the order given (the workspace's snippets come before the global ones). An empty query
 * matches every snippet.
 * @template {{ name: string }} T
 * @param {T[]} snippets
 * @param {string} query
 * @returns {T[]}
 */
export function matchSnippets(snippets, query) {
  const q = query.trim().toLowerCase();
  if (!q) return [...snippets];
  /** @param {T} s */
  const rank = s => {
    const name = s.name.toLowerCase();
    if (name === q) return 0;
    if (name.startsWith(q)) return 1;
    return name.includes(q) ? 2 : -1;
  };
  return snippets.map(s => ({ s, r: rank(s) })).filter(x => x.r >= 0).sort((a, b) => a.r - b.r).map(x => x.s);
}
