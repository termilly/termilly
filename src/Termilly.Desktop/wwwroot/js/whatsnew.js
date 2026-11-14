// @ts-check
// What's new: the first start after an update shows what changed, from the CHANGELOG.md the app ships with (js/changelog.js
// reads it). The newest version is open, a row per topic: its name, and what it is beside it. Its fixes are folded, and so
// is each version skipped in between, with the same rows inside. Settings › About and the palette
// bring it back for the version you have. A first start gets the tour instead, and nothing shows twice for a version.

import { PAGE } from './protocol.js';
import { send } from './host.js';
import { state, GROUPS } from './store.js';
import { AGENT_STATE } from './constants.js';
import { updateSettings } from './preferences.js';
import { updateStatus, onUpdateStatus } from './update.js';
import { modal } from './dialogs.js';
import { escapeHtml, ICONS } from './ui.js';
import { SECOND_MS } from './util.js';
import { parseChangelog, releasesSince } from './changelog.js';

/** @typedef {import('./changelog.js').Release} Release */
/** @typedef {import('./changelog.js').Topic} Topic */

/** The release notes, next to the page (Termilly.Desktop.csproj copies them in). */
const CHANGELOG_URL = 'CHANGELOG.md';
/** Each version's notes on the site. */
const SITE_CHANGELOG = 'https://termilly.com/changelog/#v';
const DIALOG = 'whats-new';
/** How many quiet seconds in a row before it opens by itself: the terminals are back and nothing else is showing. */
const QUIET_SECONDS = 3;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** @param {string} date 2026-11-06 */
function longDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** A changelog line as HTML: its **bold** and `code`. @param {string} text */
const inline = text => escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');

/** A topic's line on its own beside its name, so it starts a sentence. @param {string} text */
const sentence = text => text.charAt(0).toUpperCase() + text.slice(1);
/** Folded parts open with a chevron that turns. */
const CARET = `<span class="wn-caret">${ICONS.chevronRight}</span>`;

/** @type {Release[] | null} */
let releases = null;
/** The release notes, read once; null when they can't be read (then nothing counts as seen). */
async function allReleases() {
  if (releases) return releases;
  try {
    const response = await fetch(CHANGELOG_URL);
    if (response.ok) releases = parseChangelog(await response.text());
  } catch {
    // not there: tried again next time
  }
  return releases;
}

/** A row: the topic's name, and its line beside it (a line with no name has the row to itself). @param {Topic} topic */
const rowHtml = topic => `<li class="wn-row">${topic.name ? `<b>${inline(topic.name)}</b>` : ''}<span>${inline(sentence(topic.text))}</span></li>`;

/** Rows between thin lines. @param {Topic[]} topics */
const rowsHtml = topics => `<ul class="wn-rows">${topics.map(rowHtml).join('')}</ul>`;

/** @param {Topic[]} fixes */
const fixesHtml = fixes => (fixes.length
  ? `<details class="wn-fixes"><summary>${CARET}${fixes.length} ${fixes.length === 1 ? 'fix' : 'fixes'}</summary>${rowsHtml(fixes)}</details>`
  : '');

/** An older version, folded: its topics and fixes as rows. @param {Release} r */
const olderHtml = r => `<details class="wn-older"><summary>${CARET}<b>${r.version}</b><span>${longDate(r.date)}</span></summary>
  ${rowsHtml([...r.topics, ...r.fixes])}</details>`;

/**
 * Shows What's new for these versions, newest first.
 * @param {Release[]} shown
 * @param {string | null} from the version updated from, when known
 */
function openWindow(shown, from) {
  const [newest, ...older] = shown;
  const title = older.length && from ? `What's new since ${from}` : `What's new in Termilly ${newest.version}`;
  const sub = older.length && from ? `${shown.length} versions · now on ${newest.version}`
    : `${from ? `Updated from ${from} · ` : ''}${longDate(newest.date)}`;
  const on = !state.settings.uiState.whatsNewOff;
  return modal(DIALOG, `
    <div class="wn-head">
      <div><h3>${escapeHtml(title)}</h3><p class="dialog-sub">${escapeHtml(sub)}</p></div>
      <button type="button" class="pane-btn" data-cancel title="Close" aria-label="Close">${ICONS.close}</button>
    </div>
    <div class="wn-body">
      ${older.length ? `<p class="wn-version"><b>${newest.version}</b><span>${longDate(newest.date)}</span></p>` : ''}
      ${rowsHtml(newest.topics)}
      ${fixesHtml(newest.fixes)}
      ${older.map(olderHtml).join('')}
    </div>
    <div class="dialog-actions">
      <label class="wn-auto"><input type="checkbox" data-auto${on ? ' checked' : ''}>Show this after updates</label>
      <span class="spacer"></span>
      <button type="button" class="btn" data-site>Full changelog</button>
      <button type="button" class="btn primary" data-ok autofocus>Close</button>
    </div>`, (dialog, close) => {
    dialog.querySelector('[data-auto]')?.addEventListener('change', e => {
      updateSettings(GROUPS.uiState, { whatsNewOff: !(/** @type {HTMLInputElement} */ (e.target).checked) });
    });
    dialog.querySelector('[data-site]')?.addEventListener('click', () => send(PAGE.openUrl, { url: SITE_CHANGELOG + newest.version }));
    return { submit: () => close(null) };
  });
}

/** Marks this version's What's new as seen. @param {string} version */
const markSeen = version => updateSettings(GROUPS.uiState, { whatsNewSeen: version });

/** What's new for the version you have, from Settings › About or the palette. */
export async function showWhatsNew() {
  const version = updateStatus.current;
  const shown = releasesSince(await allReleases() ?? [], null, version);
  if (shown.length) await openWindow(shown, null);
}

/** Whether something else is on screen or a terminal waits on you: What's new waits for a quiet moment. */
const busy = () => !!document.querySelector('.modal-layer:not([hidden]), .tour-card')
  || !document.querySelector('.ws-layer.active .pane')
  || [...state.tabs.values()].some(t => t.agent?.state === AGENT_STATE.needsInput);

/**
 * After an update, once the terminals are back and nothing else is showing: What's new since the version last seen.
 * @param {string} version the version running
 */
async function offerFor(version) {
  const ui = state.settings.uiState;
  if (ui.whatsNewSeen === version) return;
  // A first start gets the tour, not news; turned off, or nothing in the notes for this version: only remembered.
  if (!ui.tourSeen || ui.whatsNewOff) return markSeen(version);
  const all = await allReleases();
  if (!all) return; // the notes couldn't be read: offered again at the next start
  const shown = releasesSince(all, ui.whatsNewSeen ?? null, version);
  if (!shown.length) return markSeen(version);
  let quiet = 0;
  const wait = setInterval(() => {
    quiet = busy() ? 0 : quiet + 1;
    if (quiet < QUIET_SECONDS) return;
    clearInterval(wait);
    void openWindow(shown, ui.whatsNewSeen ?? null).then(() => markSeen(version));
  }, SECOND_MS);
}

let offered = false;
/** Called once the workspaces are back (js/main.js): offers What's new as soon as the host has said which version runs. */
export function offerWhatsNewOnce() {
  /** @param {{ current: string }} status */
  const go = status => {
    if (offered || !status.current) return;
    offered = true;
    void offerFor(status.current);
  };
  go(updateStatus);
  onUpdateStatus(go);
}
