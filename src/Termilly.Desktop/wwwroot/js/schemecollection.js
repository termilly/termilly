// @ts-check
// The iTerm2 Color Schemes collection on GitHub (github.com/mbadolato/iTerm2-Color-Schemes), for the Import dialog's
// Browse (themeimport.js): its list of schemes, fetched once a session when asked, and a scheme fetched when picked.
// Nothing of it ships with Termilly; a scheme is kept only once it's used (then with the user's imported themes).

import { readSchemes } from './schemes.js';

/** The collection in its Windows Terminal form: the list of schemes, and one scheme's file. */
const COLLECTION = Object.freeze({
  list: 'https://api.github.com/repos/mbadolato/iTerm2-Color-Schemes/contents/windowsterminal',
  file: (/** @type {string} */ name) => `https://raw.githubusercontent.com/mbadolato/iTerm2-Color-Schemes/master/windowsterminal/${encodeURIComponent(name)}.json`,
  extension: '.json',
});

/** The collection's scheme names, once fetched (for the rest of the session). */
/** @type {string[] | null} */
let names = null;

/** The collection's scheme names as fetched so far, or none. */
export const collectionNames = () => names ?? [];

/** The collection's scheme names, fetched once. */
export async function fetchCollection() {
  if (names) return names;
  const response = await fetch(COLLECTION.list);
  if (!response.ok) throw new Error(`GitHub said ${response.status}`);
  const files = /** @type {{ name: string, type: string }[]} */ (await response.json());
  names = files.filter(f => f.type === 'file' && f.name.endsWith(COLLECTION.extension))
    .map(f => f.name.slice(0, -COLLECTION.extension.length));
  return names;
}

/** @param {string} name one of the collection's */
export async function fetchScheme(name) {
  const response = await fetch(COLLECTION.file(name));
  if (!response.ok) throw new Error(`GitHub said ${response.status}`);
  return readSchemes(`${name}${COLLECTION.extension}`, await response.text()).schemes[0];
}
