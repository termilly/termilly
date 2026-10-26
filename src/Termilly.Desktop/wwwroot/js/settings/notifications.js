// @ts-check
// Settings › Notifications: the desktop notifications for agent news, the shortcut to the next terminal that needs
// you, and the sounds (js/sounds.js plays them).

import { sys, SYSTEM_NAME } from '../host.js';
import { getSetting } from '../store.js';
import { ICONS } from '../ui.js';
import { SETTING_VALUES } from '../constants.js';
import { targetOf } from '../dom.js';
import { playSound } from '../sounds.js';
import { row, seg, toggle, group } from './controls.js';
import { SECTION, takenChords } from './page.js';

const { sound, soundVolume } = SETTING_VALUES;

/** The sound settings' keys start with this; the volume is one of them, and plays the "needs you" sound. */
const SOUND_SETTING = 'notifications.sound';
const VOLUME_SETTING = 'notifications.soundVolume';
const NEEDS_INPUT_SOUND = 'notifications.soundNeedsInput';
/** The global shortcut, and Termilly's own one for the same. */
const JUMP_CHORD = 'Ctrl+Alt+J';

/** The sounds to pick from: none, then ping-1…ping-5 as Ping 1…Ping 5. */
const SOUND_CHOICES = sound.all.map(v => [v, v === sound.none ? 'Off' : v.replace(/^ping-/, 'Ping ')]);

/**
 * A sound setting's dropdown, and a button to hear the chosen sound.
 * @param {string} key notifications.sound…
 */
const soundPicker = key => `<span class="sound-pick"><select class="field" data-setting="${key}">${SOUND_CHOICES.map(([v, l]) => `<option value="${v}"${v === getSetting(key) ? ' selected' : ''}>${l}</option>`).join('')}</select>
  <button class="btn small" data-play-sound="${key}" title="Play it" aria-label="Play it">${ICONS.play}</button></span>`;

/**
 * A sound's play button; true when it was one.
 * @param {MouseEvent} e
 */
function playChosen(e) {
  const key = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-play-sound]'))?.dataset.playSound;
  if (!key) return false;
  playSound(getSetting(key));
  return true;
}

const where = () => (sys.name === SYSTEM_NAME.linux ? 'A desktop' : 'A Windows');

/** @type {import('./page.js').Section} */
const NOTIFICATIONS = {
  id: SECTION.notifications,
  label: 'Notifications', icon: ICONS.bell,
  html: () => group('When you can’t see the terminal', row('Agent needs you', `${where()} notification; clicking it opens the terminal.`, toggle('notifications.needsInput'), { keywords: 'notification toast agent waits permission input attention' })
      + row('Agent stopped with an error', '', toggle('notifications.error'), { keywords: 'notification toast error' })
      + row('Agent finished', '', toggle('notifications.done'), { keywords: 'notification toast done finished' }))
    + group('Shortcut', row('Next terminal that needs you, from any app', takenChords.has(JUMP_CHORD)
        ? '<span class="warn">Another app uses Ctrl Alt J. Inside Termilly, Ctrl Shift J works.</span>'
        : 'Ctrl Alt J, bringing Termilly forward. Inside it: Ctrl Shift J.',
      toggle('notifications.jumpHotkey'), { keywords: 'global shortcut hotkey jump ctrl alt j' }))
    + group('Sounds', row('Agent needs you', '', soundPicker('notifications.soundNeedsInput'), { keywords: 'sound ping beep audio agent waits' })
      + row('Agent stopped with an error', '', soundPicker('notifications.soundError'), { keywords: 'sound ping audio error' })
      + row('Agent finished', '', soundPicker('notifications.soundDone'), { keywords: 'sound ping audio done finished' })
      + row('Quitting while something runs', '', soundPicker('notifications.soundQuit'), { keywords: 'sound ping audio quit close busy' })
      + row('Volume', '', seg('notifications.soundVolume', [[soundVolume.quiet, 'Quiet'], [soundVolume.medium, 'Medium'], [soundVolume.loud, 'Loud']]), { keywords: 'sound volume loud quiet' })),
  click: playChosen,
  changed(key) {
    // A sound chosen, or the volume changed: hear it.
    if (key.startsWith(SOUND_SETTING)) playSound(getSetting(key === VOLUME_SETTING ? NEEDS_INPUT_SOUND : key));
  },
};

export default NOTIFICATIONS;
