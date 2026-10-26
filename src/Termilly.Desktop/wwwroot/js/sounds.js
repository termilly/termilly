// @ts-check
// Notification sounds (Settings › Terminal › Sounds): a short ping when an agent needs you, stops with an error or
// finishes in a terminal you aren't looking at, and when quitting asks first because something still runs. The
// sounds are wwwroot/sounds/ping-1.mp3 to ping-5.mp3, chosen per event, or none.

import { state, on, isInView, EVENTS } from './store.js';
import { AGENT_STATE, SETTING_VALUES } from './constants.js';

const { sound } = SETTING_VALUES;
const FOLDER = 'sounds/';
const EXTENSION = '.mp3';
const PERCENT = 100;
/** Agents restored at start report their state at once: those aren't news, so the first moments stay quiet. */
const QUIET_AT_START_MS = 5000;
const startedAt = Date.now();

/**
 * Which sound setting (notifications.*) each agent state plays.
 * @type {Record<string, 'soundNeedsInput' | 'soundError' | 'soundDone'>}
 */
const FOR_STATE = {
  [AGENT_STATE.needsInput]: 'soundNeedsInput',
  [AGENT_STATE.attention]: 'soundNeedsInput',
  [AGENT_STATE.error]: 'soundError',
  [AGENT_STATE.done]: 'soundDone',
};

/** @type {Map<string, HTMLAudioElement>} one player per sound, made when it first plays */
const players = new Map();
/** @type {WeakMap<Tab, string>} each terminal's last agent news that played, so it plays once */
const played = new WeakMap();

/**
 * Plays a sound at the volume Settings give; none (or nothing) is silence.
 * @param {string | null | undefined} name ping-1…ping-5
 */
export function playSound(name) {
  if (!name || name === sound.none) return;
  let audio = players.get(name);
  if (!audio) {
    audio = new Audio(`${FOLDER}${name}${EXTENSION}`);
    players.set(name, audio);
  }
  audio.volume = state.settings.notifications.soundVolume / PERCENT;
  audio.currentTime = 0;
  audio.play().catch(() => {}); // the system has no audio device, or it's busy: a missed ping is no error
}

/** The sound for quitting when Termilly asks first (quit.js). */
export const playQuitSound = () => playSound(state.settings.notifications.soundQuit);

on(EVENTS.agent, tab => {
  const agent = tab.agent;
  const setting = agent ? FOR_STATE[agent.state] : undefined;
  if (!setting || isInView(tab) || Date.now() - startedAt < QUIET_AT_START_MS) return;
  const news = `${agent.state}@${agent.at}`;
  if (played.get(tab) === news) return;
  played.set(tab, news);
  playSound(state.settings.notifications[setting]);
});
