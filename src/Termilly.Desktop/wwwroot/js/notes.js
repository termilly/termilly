// @ts-check
// Notes on terminals, workspaces and SSH hosts ("staging DB is read-only until Friday", "this box needs sudo -u
// deploy"). A terminal's or workspace's note is saved with the workspace (encrypted with the rest) and kept in
// the closed-terminal history; a host's note lives in Settings and shows on every terminal opened to it. They're
// written in To do (js/todopanel.js), above the tasks of the same terminal, workspace or host.

import { state, emit, persist, profileOf, wsById, GROUPS, isSshProfile, EVENTS } from './store.js';
import { updateSettings } from './preferences.js';

/**
 * A note as a terminal's hover and header show it: where it's from ('terminal', 'host' or 'workspace') and its text.
 * @typedef {{ kind: string, text: string, pinned: boolean }} NoteEntry
 */

/** Where a note is from: a terminal's own, its SSH host's (kept in Settings), or its workspace's. */
export const NOTE_KIND = Object.freeze({ terminal: 'terminal', host: 'host', workspace: 'workspace' });

/**
 * The first non-empty line of a note, without markdown's heading and list marks.
 * @param {string | null | undefined} text
 */
export const firstLine = text => (text ?? '').split(/\r?\n/).map(l => l.replace(/^\s*(#+|[-*]|\d+\.)\s+/, '').trim()).find(Boolean) ?? '';

/**
 * A host's note (SSH profiles), or null.
 * @param {Tab} tab
 */
export const profileNote = tab => {
  const profile = profileOf(tab);
  return isSshProfile(profile) ? state.settings.shells.notes?.[/** @type {SessionProfile} */ (profile).id] ?? null : null;
};

/**
 * What a terminal's hover and header show: its own note, its workspace's pinned one, and its host's.
 * @param {Tab} tab
 */
export function notesFor(tab) {
  const ws = wsById(tab.wsId);
  return /** @type {NoteEntry[]} */ ([
    tab.note?.text ? { kind: NOTE_KIND.terminal, text: tab.note.text, pinned: !!tab.note.pinned } : null,
    profileNote(tab) ? { kind: NOTE_KIND.host, text: profileNote(tab), pinned: true } : null,
    ws?.note?.text && ws.note.pinned ? { kind: NOTE_KIND.workspace, text: ws.note.text, pinned: true } : null,
  ].filter(Boolean));
}

/**
 * Hover text for a row with notes: the first lines, each with where it's from.
 * @param {NoteEntry[]} notes
 */
export function noteTitle(notes) {
  return notes.map(n => `${n.kind === NOTE_KIND.terminal ? 'Note' : n.kind === NOTE_KIND.host ? 'Host note' : 'Workspace note'}: ${firstLine(n.text)}`).join('\n');
}

/**
 * Adds text to the end of a terminal's or workspace's note, as a new paragraph (the Notepad's Copy to note).
 * @param {string} kind 'terminal' or 'workspace'
 * @param {Tab | Workspace} target
 * @param {string} text
 */
export function appendNote(kind, target, text) {
  const note = target.note;
  const joined = note?.text ? `${note.text}\n\n${text.trim()}` : text.trim();
  setNote(kind, target, joined, !!note?.pinned);
}

/**
 * @param {string} kind
 * @param {Tab | Workspace | string} target
 * @param {string} text
 * @param {boolean} pinned
 */
export function setNote(kind, target, text, pinned) {
  if (kind === NOTE_KIND.host) {
    /** @type {Record<string, string>} */
    const notes = { ...(state.settings.shells.notes ?? {}) };
    if (text) notes[/** @type {string} */ (target)] = text; else delete notes[/** @type {string} */ (target)];
    updateSettings(GROUPS.shells, { notes });
    emit(EVENTS.todo);
    return;
  }
  /** @type {Tab | Workspace} */ (target).note = text ? { text, pinned } : null;
  if (kind === NOTE_KIND.terminal) emit(EVENTS.tab, target);
  else {
    for (const tab of state.tabs.values()) if (tab.wsId === /** @type {Workspace} */ (target).id) emit(EVENTS.tab, tab);
    emit(EVENTS.workspaces);
  }
  emit(EVENTS.todo);
  persist();
}
