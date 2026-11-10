// @ts-check
// Notepad and agents: what the MCP tools list_notepad_pages, read_notepad_page, add_notepad_page, write_notepad_page and
// rename_notepad_page can do. An agent lists and reads the pages, adds one with the name it gives, writes to one (its text
// replaced, or added at its end or top) and renames one. It never closes a page, so nothing the user wrote is lost.

import { addApiMethods } from './api.js';
import { state } from './store.js';
import { notepadPages, addNamedPage, changePage } from './notepad.js';

/** @typedef {import('./store.js').NotepadPage} NotepadPage */

/** How write_notepad_page writes: the page's text replaced, or added at its end or its top. */
const MODE = Object.freeze({ replace: 'replace', append: 'append', prepend: 'prepend' });
/** The longest a tab's name may be. */
const MAX_NAME = 80;
const LF = '\n';

/**
 * A page as an agent sees it in the list.
 * @param {NotepadPage} p
 */
const describePage = p => ({
  id: p.id, name: p.name, ...(p.path ? { file: p.path, saved: p.text === p.saved } : {}),
  lines: p.text ? p.text.split(LF).length : 0, chars: p.text.length, shown: p.id === state.notepad.activeId,
});

/**
 * The page an agent names: by its id, else its name (any case). Two pages with that name: it's asked for the id.
 * @param {Record<string, any>} args
 */
function pageFor(args) {
  const asked = String(args.page ?? '').trim();
  if (!asked) throw new Error('Name the page: its id from list_notepad_pages, or its name.');
  const byId = notepadPages().find(p => p.id === asked);
  if (byId) return byId;
  const named = notepadPages().filter(p => p.name === asked);
  const found = named.length ? named : notepadPages().filter(p => p.name.toLowerCase() === asked.toLowerCase());
  if (found.length > 1) throw new Error(`${found.length} pages are named "${asked}": give its id (${found.map(p => p.id).join(', ')}).`);
  if (!found.length) throw new Error(`There's no Notepad page "${asked}". list_notepad_pages shows them.`);
  return found[0];
}

/**
 * A tab's name as given: one line, not empty, not too long.
 * @param {unknown} name
 */
function nameOf(name) {
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('A page needs a name.');
  if (clean.length > MAX_NAME) throw new Error(`A page's name is at most ${MAX_NAME} characters.`);
  return clean;
}

/**
 * Writes text to a page: in its place, or on a line of its own at its end or its top.
 * @param {Record<string, any>} args
 */
function writePage(args) {
  const page = pageFor(args);
  const text = String(args.text ?? '');
  const mode = String(args.mode ?? MODE.replace).trim().toLowerCase() || MODE.replace;
  if (mode === MODE.append) {
    changePage(page, { text: page.text && !page.text.endsWith(LF) ? `${page.text}${LF}${text}` : `${page.text}${text}` });
  } else if (mode === MODE.prepend) {
    const added = page.text && !text.endsWith(LF) ? `${text}${LF}` : text;
    changePage(page, { text: `${added}${page.text}`, before: added.length });
  } else if (mode === MODE.replace) changePage(page, { text });
  else throw new Error('mode is replace, append or prepend.');
  return describePage(page);
}

addApiMethods({
  notepad_pages: () => ({ pages: notepadPages().map(describePage) }),
  notepad_read: args => {
    const page = pageFor(args);
    return { id: page.id, name: page.name, text: page.text };
  },
  notepad_add: args => describePage(addNamedPage(nameOf(args.name), String(args.text ?? ''), args.show !== false)),
  notepad_write: args => writePage(args),
  notepad_rename: args => {
    const page = pageFor(args);
    changePage(page, { name: nameOf(args.name) });
    return describePage(page);
  },
});
