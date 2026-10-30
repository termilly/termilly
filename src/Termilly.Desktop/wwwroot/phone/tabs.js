// @ts-check
// The app's bottom bar and two of its tabs: Notifications (the PC's notification center: what agents said, newest
// first) and Settings (this phone's alerts, the terminal's text size, the PC it's paired with, unpairing). The
// Terminals tab is the home (app.js).

/** The tabs (data-tab). */
export const TAB = Object.freeze({ terminals: 'terminals', notes: 'notes', settings: 'settings' });
/** What a note says about its terminal's agent (AgentStates.cs). */
const STATE_LABEL = Object.freeze({ 'needs-input': 'Needs you', attention: 'Needs you', error: 'Error', done: 'Done' });
/** What the Settings tab's buttons do (data-do). */
export const SETTING = Object.freeze({ smaller: 'smaller', bigger: 'bigger', unpair: 'unpair' });
/** The text sizes the terminal steps through (points). */
export const TEXT_SIZES = [9, 10, 11, 12, 13, 14, 16, 18, 20];

/** 24px line icons, drawn on whole pixels so they stay sharp. */
const ICON = Object.freeze({
  terminals: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9l3 3-3 3M12 15h5"/>',
  notes: '<path d="M6 16V11a6 6 0 0112 0v5l2 2H4z"/><path d="M10 20h4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
});
const LABEL = Object.freeze({ terminals: 'Terminals', notes: 'Notifications', settings: 'Settings' });

/** @param {unknown} text */
const esc = text => String(text ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/**
 * The bottom bar: each tab, the one shown marked, and how many notifications there are.
 * @param {string} current
 * @param {number} count
 */
export function navHtml(current, count) {
  return `<nav class="tabbar">${Object.values(TAB).map(t => `<button data-tab="${t}"${t === current ? ' class="on" aria-current="page"' : ''}>
    <svg viewBox="0 0 24 24" aria-hidden="true">${/** @type {Record<string, string>} */ (ICON)[t]}</svg>
    <span>${/** @type {Record<string, string>} */ (LABEL)[t]}</span>${t === TAB.notes && count ? `<b class="tab-count">${count > 99 ? '99+' : count}</b>` : ''}</button>`).join('')}</nav>`;
}

/**
 * @typedef {{ id: string, state: string, detail: string, at: number, live: boolean }} Note
 * @typedef {{ badge: (id: string) => string, title: (id: string) => string, ws: (id: string) => string, age: (at: number) => string,
 *   waiting: (id: string) => boolean, open: string, term: string }} NoteParts
 */

/**
 * The notification center as the PC has it.
 * @param {Note[]} notes
 * @param {NoteParts} parts
 */
export function notesHtml(notes, parts) {
  if (!notes.length) return '<p class="muted center">Nothing new. What an agent says when you’re not looking shows here.</p>';
  return `<div class="list">${notes.map(n => `<div class="row note${n.live ? '' : ' seen'}" data-do="${parts.waiting(n.id) ? parts.open : parts.term}" data-id="${esc(n.id)}">
      ${parts.badge(n.id)}<div class="r-text"><div class="r-name">${esc(parts.title(n.id))}<span class="note-state n-${esc(n.state)}">${esc(/** @type {Record<string, string>} */ (STATE_LABEL)[n.state] ?? n.state)}</span></div>
      <div class="r-line">${esc(n.detail)}</div><div class="r-meta">${esc(parts.ws(n.id))} · ${esc(parts.age(n.at))}</div></div></div>`).join('')}</div>`;
}

/**
 * This phone's settings.
 * @param {{ alerts: string, size: number, host: string, connected: boolean, look: string,
 *   looks: { id: string, name: string, swatch: { bg: string, accent: string } | null }[] }} now
 */
export function settingsHtml(now) {
  return `<div class="section">This phone</div><div class="list pad">${now.alerts}</div>
    <div class="section">Appearance</div><div class="list looks">${now.looks.map(l => `<button class="row look${l.id === now.look ? ' on' : ''}" data-look="${esc(l.id)}">
      ${l.swatch ? `<span class="swatch" style="background:${esc(l.swatch.bg)}"><i style="background:${esc(l.swatch.accent)}"></i></span>` : '<span class="swatch none"></span>'}
      <span class="r-text">${esc(l.name)}</span><span class="tick">${l.id === now.look ? '✓' : ''}</span></button>`).join('')}</div>
    <p class="muted hint">Same as PC follows the desktop's theme as it changes; Automatic, the phone's light or dark mode.</p>
    <div class="section">Terminal text</div><div class="list pad stepper"><button class="btn" data-do="${SETTING.smaller}" aria-label="Smaller">A−</button>
      <span>${now.size} pt</span><button class="btn" data-do="${SETTING.bigger}" aria-label="Bigger">A+</button></div>
    <div class="section">Your PC</div><div class="list pad"><p class="mono">${esc(now.host)}</p>
      <p class="muted">${now.connected ? 'Connected.' : 'Reconnecting.'}</p></div>
    <div class="section">Pairing</div><div class="list pad"><p class="muted">The PC forgets this phone; it needs a new code to come back.</p>
      <div class="w-actions"><button class="btn danger" data-do="${SETTING.unpair}">Unpair this phone</button></div></div>`;
}
