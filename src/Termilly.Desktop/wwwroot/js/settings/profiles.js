// @ts-check
// Settings › Terminal: the shell profiles by where they come from, and adding, editing and deleting the user's own.

import { state, on, GROUPS, EVENTS, sourceOf } from '../store.js';
import { badgeHtml, escapeHtml, tagChipHtml, keysHtml } from '../ui.js';
import { confirmDialog, openProfileEditor, PROFILE_DELETED } from '../dialogs.js';
import { updateSettings } from '../preferences.js';
import { SECTION, redrawIfShowing } from './page.js';
import { targetOf } from '../dom.js';

/** Ctrl+Shift+1 to 9 open the first nine profiles. */
const NUMBERED_PROFILES = 9;

/**
 * The profiles from one source, with their Ctrl+Shift shortcut; custom ones get an Edit button.
 * @param {string} source
 * @param {{ editable?: boolean }} [options]
 */
export function shellList(source, { editable = false } = {}) {
  const profiles = state.profiles.filter(p => sourceOf(p) === source);
  if (!profiles.length) return '';
  return `<div class="shell-list">${profiles.map(p => {
    const i = state.profiles.indexOf(p);
    return `<div class="shell-item">${badgeHtml(p, '')}<span class="label"><span class="name">${escapeHtml(p.name)}</span>
        <span class="description">${escapeHtml(p.description)}</span></span>
        ${p.tags?.length ? `<span class="chips">${p.tags.map(t => tagChipHtml(t, { mini: true })).join('')}</span>` : ''}
        ${i < NUMBERED_PROFILES ? `<span class="keys">${keysHtml(`Ctrl Shift ${i + 1}`)}</span>` : ''}
        ${editable ? `<button class="btn small" data-edit-profile="${escapeHtml(p.id)}">Edit</button>` : ''}</div>`;
  }).join('')}</div>`;
}

const ownProfiles = () => state.settings.shells.profiles ?? [];

/**
 * Saves the user's profiles; the host re-reads every profile and sends the new list ('profiles').
 * @param {CustomProfile[]} profiles
 */
function saveProfiles(profiles) {
  updateSettings(GROUPS.shells, { profiles });
}

/** @param {string} id */
async function editProfile(id) {
  const profiles = ownProfiles();
  const profile = profiles.find(p => p.id === id);
  if (!profile) return;
  const result = await openProfileEditor(profile);
  if (result === PROFILE_DELETED) {
    if (await confirmDialog({
      title: `Delete “${profile.name}”?`,
      body: 'Open terminals keep running. New ones can’t be started from this profile any more.',
      confirm: 'Delete profile',
    })) saveProfiles(profiles.filter(p => p.id !== id));
  } else if (result) {
    saveProfiles(profiles.map(p => (p.id === id ? result : p)));
  }
}

export const profileActions = {
  async addProfile() {
    const profile = await openProfileEditor();
    // A new profile has no Delete button, so this is the profile to add.
    if (profile) saveProfiles([...ownProfiles(), /** @type {CustomProfile} */ (profile)]);
  },
};

/**
 * A profile's Edit button; true when it was one.
 * @param {MouseEvent} e
 */
export function profileClick(e) {
  const edit = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-edit-profile]'));
  if (!edit) return false;
  editProfile(/** @type {string} */ (edit.dataset.editProfile));
  return true;
}

// The profile list changed (one added, edited or removed): redraw the shell lists.
on(EVENTS.profiles, () => redrawIfShowing(SECTION.terminal));
