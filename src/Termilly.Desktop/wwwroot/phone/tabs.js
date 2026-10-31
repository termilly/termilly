// @ts-check
// The app's bottom bar and two of its tabs: Notifications (the PC's notification center: what agents said, newest
// first) and Settings (this phone's alerts, the terminal's text size, the PC it's paired with, unpairing). The
// Terminals tab is the home (app.js).

/** The tabs (data-tab). */
export const TAB = Object.freeze({ terminals: 'terminals', notes: 'notes', settings: 'settings' });
/** What a note says about its terminal's agent (AgentStates.cs). */
const STATE_LABEL = Object.freeze({ 'needs-input': 'Needs you', attention: 'Needs you', error: 'Error', done: 'Done' });
/** What the Settings tab's buttons do (data-do). */
export const SETTING = Object.freeze({ smaller: 'smaller', bigger: 'bigger', unpair: 'unpair', themes: 'themes', back: 'back', scrolling: 'scrolling', compose: 'compose' });
/** The boxes for writing to Claude (compose.js COMPOSE_STYLE), as Settings offers them. */
const COMPOSE_CHOICES = [['messages', 'Messages', 'A round field with the microphone; the keys step aside while you write'], ['bar', 'One bar', 'Keys and the field share one row, with a switch']];
/** The ways the terminal scrolls back (gestures.js SCROLLING), as Settings offers them. */
const SCROLL_CHOICES = [['smooth', 'Smooth'], ['lines', 'Line by line']];
/** The looks at the top of Settings › Appearance; the other themes have their own page. */
const FIRST_LOOKS = Object.freeze(['pc', 'auto', 'dark', 'light']);
/** The text sizes the terminal steps through (points). */
export const TEXT_SIZES = [9, 10, 11, 12, 13, 14, 16, 18, 20];

/** 24px line icons, drawn on whole pixels so they stay sharp. */
const ICON = Object.freeze({
  terminals: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9l3 3-3 3M12 15h5"/>',
  notes: '<path d="M6 16V11a6 6 0 0112 0v5l2 2H4z"/><path d="M10 20h4"/>',
  // The desktop's Settings button (index.html), on this grid.
  settings: '<path d="M4 7h6M16 7h4M4 17h3M13 17h7"/><circle cx="13" cy="7" r="2.75"/><circle cx="10" cy="17" r="2.75"/>',
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

/** @typedef {{ id: string, name: string, swatch: { bg: string, accent: string } | null }} Look */

/**
 * One look to pick, with its colours and a tick when it's the one.
 * @param {Look} l
 * @param {string} chosen
 */
const lookHtml = (l, chosen) => `<button class="row look${l.id === chosen ? ' on' : ''}" data-look="${esc(l.id)}">
  ${l.swatch ? `<span class="swatch" style="background:${esc(l.swatch.bg)}"><i style="background:${esc(l.swatch.accent)}"></i></span>` : '<span class="swatch none"></span>'}
  <span class="r-text">${esc(l.name)}</span><span class="tick">${l.id === chosen ? '✓' : ''}</span></button>`;

/**
 * The other themes, on their own page (Settings › Appearance › More themes).
 * @param {Look[]} looks
 * @param {string} chosen
 */
export function themesHtml(looks, chosen) {
  return `<button class="back-row" data-do="${SETTING.back}">‹ Settings</button>
    <div class="list looks">${looks.filter(l => !FIRST_LOOKS.includes(l.id)).map(l => lookHtml(l, chosen)).join('')}</div>`;
}

/**
 * This phone's settings.
 * @param {{ alerts: string, size: number, scrolling: string, compose: string, host: string, connected: boolean, look: string, looks: Look[] }} now
 */
export function settingsHtml(now) {
  const other = FIRST_LOOKS.includes(now.look) ? null : now.looks.find(l => l.id === now.look);
  return `<div class="section">This phone</div><div class="list pad">${now.alerts}</div>
    <div class="section">Appearance</div><div class="list looks">${now.looks.filter(l => FIRST_LOOKS.includes(l.id)).map(l => lookHtml(l, now.look)).join('')}
      <button class="row look more" data-do="${SETTING.themes}"><span class="r-text">More themes</span><span class="more-value">${esc(other?.name ?? '')}</span><span class="chev">›</span></button></div>
    <p class="muted hint">Same as PC follows the desktop's theme as it changes; System, the phone's light or dark mode.</p>
    <div class="section">Terminal text</div><div class="list pad stepper"><button class="btn" data-do="${SETTING.smaller}" aria-label="Smaller">A−</button>
      <span>${now.size} pt</span><button class="btn" data-do="${SETTING.bigger}" aria-label="Bigger">A+</button></div>
    <div class="section">Scrolling</div><div class="list looks">${SCROLL_CHOICES.map(([id, name]) => `<button class="row look${id === now.scrolling ? ' on' : ''}" data-do="${SETTING.scrolling}" data-scrolling="${id}">
      <span class="r-text">${name}</span><span class="tick">${id === now.scrolling ? '✓' : ''}</span></button>`).join('')}</div>
    <div class="section">Message box</div><div class="list looks">${COMPOSE_CHOICES.map(([id, name, hint]) => `<button class="row look${id === now.compose ? ' on' : ''}" data-do="${SETTING.compose}" data-compose="${id}">
      <span class="r-text"><span class="r-name">${name}</span><span class="r-line">${hint}</span></span><span class="tick">${id === now.compose ? '✓' : ''}</span></button>`).join('')}</div>
    <p class="muted hint">Under a Claude terminal, for writing or dictating to Claude.</p>
    <div class="section">Your PC</div><div class="list pad"><p class="mono">${esc(now.host)}</p>
      <p class="muted">${now.connected ? 'Connected.' : 'Reconnecting.'}</p></div>
    <div class="section">Pairing</div><div class="list pad"><p class="muted">The PC forgets this phone; it needs a new code to come back.</p>
      <div class="w-actions"><button class="btn danger" data-do="${SETTING.unpair}">Unpair this phone</button></div></div>`;
}
