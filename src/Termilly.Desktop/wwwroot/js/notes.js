// @ts-check
// Notes on terminals, workspaces and SSH hosts ("staging DB is read-only until Friday", "this box needs sudo -u
// deploy"). A terminal's or workspace's note is saved with the workspace (encrypted with the rest) and kept in
// the closed-terminal history; a host's note lives in Settings and shows on every terminal opened to it.

import { state, emit, persist, profileOf, wsById, GROUPS, isSshProfile, EVENTS } from './store.js';
import { modal } from './dialogs.js';
import { escapeHtml } from './ui.js';
import { updateSettings } from './preferences.js';

/**
 * A note as a terminal's hover and header show it: where it's from ('terminal', 'host' or 'workspace') and its text.
 * @typedef {{ kind: string, text: string, pinned: boolean }} NoteEntry
 */

/** Where a note is from: a terminal's own, its SSH host's (kept in Settings), or its workspace's. */
export const NOTE_KIND = Object.freeze({ terminal: 'terminal', host: 'host', workspace: 'workspace' });

/** Longest note kept, in characters. */
const MAX_NOTE = 4000;

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
 * Edits a note. `kind` is 'terminal' (target a tab), 'workspace' (a workspace) or 'host' (a profile id).
 * Saving empty text removes the note.
 * @param {string} kind
 * @param {Tab | Workspace | string} target
 */
export function editNote(kind, target) {
  const current = kind === NOTE_KIND.host
    ? { text: state.settings.shells.notes?.[/** @type {string} */ (target)] ?? '', pinned: true }
    : /** @type {Tab | Workspace} */ (target).note ?? { text: '', pinned: false };
  const what = kind === NOTE_KIND.terminal ? 'this terminal'
    : kind === NOTE_KIND.workspace ? `“${escapeHtml(/** @type {Workspace} */ (target).name)}”`
    : `${escapeHtml(state.profiles.find(p => p.id === target)?.name ?? 'this host')}`;
  return modal('note-editor', `
    <h3>Note on ${what}</h3>
    <p class="dialog-sub">${kind === NOTE_KIND.host ? 'Shows on every terminal opened to this host: runbook links, who to ask, what not to do.'
      : 'Markdown is fine. The first line shows when you hover its row in the sidebar.'}</p>
    <textarea class="field note-text" rows="8" maxlength="${MAX_NOTE}" spellcheck="true" placeholder="e.g. staging DB is read-only until Friday">${escapeHtml(current.text)}</textarea>
    ${kind === NOTE_KIND.host ? '' : `<label class="note-pin"><input type="checkbox" data-pin ${current.pinned ? 'checked' : ''}> Pin the first line to ${kind === NOTE_KIND.terminal ? 'the terminal’s header' : 'the header of its terminals'}</label>`}
    <div class="dialog-actions">
      ${current.text ? '<button class="btn" data-remove>Remove note</button>' : ''}
      <span class="spacer"></span>
      <button class="btn" data-cancel>Cancel</button>
      <button class="btn primary" data-ok>Save</button>
    </div>`, (dialog, close) => {
    const area = /** @type {HTMLTextAreaElement} */ (dialog.querySelector('.note-text'));
    setTimeout(() => { area.focus(); area.setSelectionRange(area.value.length, area.value.length); });
    /** @param {string} text */
    const save = text => {
      setNote(kind, target, text.trim().slice(0, MAX_NOTE),
        !!(/** @type {HTMLInputElement | null} */ (dialog.querySelector('[data-pin]')))?.checked);
      close(true);
    };
    dialog.querySelector('[data-remove]')?.addEventListener('click', () => save(''));
    // Enter makes new lines; Ctrl+Enter saves (modal()).
    return { submit: () => save(area.value) };
  });
}

/**
 * @param {string} kind
 * @param {Tab | Workspace | string} target
 * @param {string} text
 * @param {boolean} pinned
 */
function setNote(kind, target, text, pinned) {
  if (kind === NOTE_KIND.host) {
    /** @type {Record<string, string>} */
    const notes = { ...(state.settings.shells.notes ?? {}) };
    if (text) notes[/** @type {string} */ (target)] = text; else delete notes[/** @type {string} */ (target)];
    updateSettings(GROUPS.shells, { notes });
    return;
  }
  /** @type {Tab | Workspace} */ (target).note = text ? { text, pinned } : null;
  if (kind === NOTE_KIND.terminal) emit(EVENTS.tab, target);
  else {
    for (const tab of state.tabs.values()) if (tab.wsId === /** @type {Workspace} */ (target).id) emit(EVENTS.tab, tab);
    emit(EVENTS.workspaces);
  }
  persist();
}
