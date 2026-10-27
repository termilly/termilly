// @ts-check
// Settings › Notifications: the desktop notifications for agent news, the shortcut to the next terminal that needs
// you, and the sounds (js/sounds.js plays them): which one for what, the output they play on and how loud.

import { HOST, PAGE } from '../protocol.js';
import { onHost, send } from '../host.js';
import { getSetting, state } from '../store.js';
import { escapeHtml, ICONS } from '../ui.js';
import { SETTING_VALUES } from '../constants.js';
import { targetOf } from '../dom.js';
import { dropdown } from '../popups.js';
import { setSetting } from '../preferences.js';
import { playSound } from '../sounds.js';
import { row, toggle, group, setRange } from './controls.js';
import { SECTION, body, takenChords } from './page.js';

const { sound, soundVolume } = SETTING_VALUES;

/** The sound settings' keys start with this. */
const SOUND_SETTING = 'notifications.sound';
const DEVICE_SETTING = 'notifications.soundDevice';
const VOLUME_SETTING = 'notifications.soundVolume';
const NEEDS_INPUT_SOUND = 'notifications.soundNeedsInput';
const DEVICE_LIST = `select[data-setting="${DEVICE_SETTING}"]`;
const VOLUME_RANGE = '#sound-volume';
const VOLUME_VALUE = '#sound-volume-value';
/** The global shortcut, and Termilly's own one for the same. */
const JUMP_CHORD = 'Ctrl+Alt+J';

/** The sounds to pick from: none, then ping-1…ping-5 as Ping 1…Ping 5. */
const SOUND_CHOICES = sound.all.map(v => [v, v === sound.none ? 'Off' : v.replace(/^ping-/, 'Ping ')]);

/** @type {{ id: string, name: string }[]} the system's audio outputs, as the host last listed them */
let outputs = [];

/**
 * A sound setting's dropdown, and a button to hear the chosen sound.
 * @param {string} key notifications.sound…
 */
const soundPicker = key => `<span class="sound-pick"><select class="field" data-setting="${key}">${SOUND_CHOICES.map(([v, l]) => `<option value="${v}"${v === getSetting(key) ? ' selected' : ''}>${l}</option>`).join('')}</select>
  <button class="btn small" data-play-sound="${key}" title="Play it" aria-label="Play it">${ICONS.play}</button></span>`;

/** The output list's choices: the system's default, each output, and the chosen one while it's unplugged. */
function deviceOptions() {
  const chosen = state.settings.notifications.soundDevice;
  const choices = [['', 'System default'], ...outputs.map(o => [o.id, o.name])];
  if (chosen && !outputs.some(o => o.id === chosen)) choices.push([chosen, 'Not connected']);
  return choices.map(([id, name]) => `<option value="${escapeHtml(id)}"${id === (chosen ?? '') ? ' selected' : ''}>${escapeHtml(name)}</option>`).join('');
}

const volumeSlider = () => `<div class="size-control">
    <input id="sound-volume" class="set-range" type="range" min="${soundVolume.min}" max="${soundVolume.max}" step="1" aria-label="Volume">
    <span id="sound-volume-value" class="set-range-value"></span>
  </div>`;

/**
 * Shows a volume on the slider: its fill and the percent beside it.
 * @param {ParentNode} root
 * @param {number} volume
 */
function showVolume(root, volume) {
  const range = /** @type {HTMLInputElement | null} */ (root.querySelector(VOLUME_RANGE));
  if (!range) return;
  setRange(range, volume);
  /** @type {HTMLElement} */ (root.querySelector(VOLUME_VALUE)).textContent = `${volume}%`;
}

/** Plays the "needs you" sound, or Ping 1 while it's Off, to hear the output and volume. */
const playSample = () => playSound(getSetting(NEEDS_INPUT_SOUND) === sound.none ? sound.ping1 : getSetting(NEEDS_INPUT_SOUND));

/** Asks the host for the outputs; they may have changed since (a headset plugged in). */
const askOutputs = () => send(PAGE.soundOutputs, {});

onHost(HOST.soundOutputs, m => {
  outputs = m.outputs;
  for (const list of /** @type {NodeListOf<HTMLSelectElement>} */ (body.querySelectorAll(DEVICE_LIST))) {
    list.innerHTML = deviceOptions();
    dropdown(list);
  }
});

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


/** @type {import('./page.js').Section} */
const NOTIFICATIONS = {
  id: SECTION.notifications,
  label: 'Notifications', icon: ICONS.bell,
  html: () => group('Show notifications when', row('Agent needs you', '', toggle('notifications.needsInput'), { keywords: 'notification toast agent waits permission input attention' })
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
      + row('Output', '', `<select class="field sound-device" data-setting="${DEVICE_SETTING}" aria-label="Output">${deviceOptions()}</select>`, { keywords: 'sound audio output device speakers headphones headset' })
      + row('Volume', '', volumeSlider(), { keywords: 'sound volume loud quiet' })),
  refresh: askOutputs,
  opened: askOutputs,
  sync: root => showVolume(root, state.settings.notifications.soundVolume),
  click: playChosen,
  input(e) {
    if (targetOf(e).matches(VOLUME_RANGE)) showVolume(body, Number(/** @type {HTMLInputElement} */ (e.target).value));
  },
  change(e) {
    if (!targetOf(e).matches(VOLUME_RANGE)) return false;
    // Saved on letting go, then heard at the new volume.
    setSetting(VOLUME_SETTING, Number(/** @type {HTMLInputElement} */ (e.target).value));
    playSample();
    return true;
  },
  changed(key) {
    // A sound chosen: hear it; an output chosen: hear it there.
    if (key === DEVICE_SETTING) playSample();
    else if (key.startsWith(SOUND_SETTING)) playSound(getSetting(key));
  },
};

export default NOTIFICATIONS;
