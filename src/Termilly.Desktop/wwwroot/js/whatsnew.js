// @ts-check
// What's new: the first start after an update shows what changed, from the CHANGELOG.md the app ships with (js/changelog.js
// reads it). The newest version is open, with an Open button on each topic that has a window of its own (it does what that
// title bar button does); its fixes are folded, and so is each version skipped in between. Settings › About and the palette
// bring it back for the version you have. A first start gets the tour instead, and nothing shows twice for a version.

import { PAGE } from './protocol.js';
import { send } from './host.js';
import { state, GROUPS } from './store.js';
import { AGENT_STATE } from './constants.js';
import { updateSettings } from './preferences.js';
import { updateStatus, onUpdateStatus } from './update.js';
import { modal } from './dialogs.js';
import { escapeHtml, ICONS } from './ui.js';
import { byId } from './dom.js';
import { SECOND_MS } from './util.js';
import { parseChangelog, releasesSince } from './changelog.js';

/** @typedef {import('./changelog.js').Release} Release */
/** @typedef {import('./changelog.js').Topic} Topic */

/** The release notes, next to the page (Termilly.Desktop.csproj copies them in). */
const CHANGELOG_URL = 'CHANGELOG.md';
/** Each version's notes on the site. */
const SITE_CHANGELOG = 'https://termilly.com/changelog/#v';
const DIALOG = 'whats-new';
/**
 * Topics that have a window of their own, by name as the changelog writes them: Open does what their title bar button does,
 * and the topic shows its icon.
 */
const OPENS = Object.freeze({
  'to do': 'todo-button', schedules: 'schedules-button', notepad: 'notepad-button',
  clipboard: 'clips-button', snippets: 'snippets-button', files: 'files-button',
});
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

/** A topic's line on its own under its name, so it starts a sentence. @param {string} text */
const sentence = text => text.charAt(0).toUpperCase() + text.slice(1);
/** Folded parts open with a chevron that turns. */
const CARET = `<span class="wn-caret">${ICONS.chevronRight}</span>`;

/** @type {Release[] | null} */
let releases = null;
/** The release notes, read once. */
async function allReleases() {
  if (releases) return releases;
  try {
    releases = parseChangelog(await (await fetch(CHANGELOG_URL)).text());
  } catch {
    releases = [];
  }
  return releases;
}

/** @param {Topic} topic */
const buttonOf = topic => {
  const id = /** @type {Record<string, string>} */ (OPENS)[topic.name.toLowerCase()];
  return id ? byId(id) : null;
};

/** @param {Topic} topic */
function topicHtml(topic) {
  const button = buttonOf(topic);
  const icon = button?.querySelector('svg')?.outerHTML ?? '<span class="wn-dot"></span>';
  const open = button ? `<button type="button" class="btn small" data-open="${escapeHtml(button.id)}">Open</button>` : '';
  const name = topic.name ? `<b>${inline(topic.name)}</b>` : '';
  return `<li class="wn-topic"><span class="wn-icon">${icon}</span><span class="wn-what">${name}<span>${inline(topic.name ? sentence(topic.text) : topic.text)}</span></span>${open}</li>`;
}

/** @param {Topic[]} fixes */
const fixesHtml = fixes => (fixes.length
  ? `<details class="wn-fixes"><summary>${CARET}${fixes.length} ${fixes.length === 1 ? 'fix' : 'fixes'}</summary><ul>${fixes.map(f => `<li>${f.name ? `<b>${inline(f.name)}:</b> ` : ''}${inline(f.text)}</li>`).join('')}</ul></details>`
  : '');

/** An older version, folded: its topics as plain lines. @param {Release} r */
const olderHtml = r => `<details class="wn-older"><summary>${CARET}<b>${r.version}</b><span>${longDate(r.date)}</span></summary>
  <ul>${[...r.topics, ...r.fixes].map(t => `<li>${t.name ? `<b>${inline(t.name)}:</b> ` : ''}${inline(t.text)}</li>`).join('')}</ul></details>`;

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
      <img src="assets/mark-40.png" width="36" height="36" alt="">
      <div><h3>${escapeHtml(title)}</h3><p class="dialog-sub">${escapeHtml(sub)}</p></div>
      <button type="button" class="pane-btn" data-cancel title="Close" aria-label="Close">${ICONS.close}</button>
    </div>
    <div class="wn-body">
      ${older.length ? `<p class="wn-version"><b>${newest.version}</b><span>${longDate(newest.date)}</span></p>` : ''}
      <ul class="wn-topics">${newest.topics.map(topicHtml).join('')}</ul>
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
    for (const b of dialog.querySelectorAll('[data-open]')) {
      b.addEventListener('click', () => {
        close(null);
        byId(/** @type {HTMLElement} */ (b).dataset.open ?? '')?.click();
      });
    }
    return { submit: () => close(null) };
  });
}

/** Marks this version's What's new as seen. @param {string} version */
const markSeen = version => updateSettings(GROUPS.uiState, { whatsNewSeen: version });

/** What's new for the version you have, from Settings › About or the palette. */
export async function showWhatsNew() {
  const version = updateStatus.current;
  const shown = releasesSince(await allReleases(), null, version);
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
  const shown = ui.tourSeen && !ui.whatsNewOff ? releasesSince(await allReleases(), ui.whatsNewSeen ?? null, version) : [];
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
