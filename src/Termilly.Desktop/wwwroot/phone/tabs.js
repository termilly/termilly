// @ts-check
// The app's bottom bar and two of its tabs (Notes is memos.js): Notifications (the PC's notification center: what agents said, newest
// first) and Settings (this phone's alerts, the terminal's text size, the PC it's paired with, unpairing). The
// Terminals tab is the home (app.js).

/** The tabs (data-tab). */
export const TAB = Object.freeze({ terminals: 'terminals', memos: 'memos', notes: 'notes', settings: 'settings' });
/** What a note says about its terminal's agent (AgentStates.cs). */
export const STATE_LABEL = Object.freeze({ 'needs-input': 'Needs you', attention: 'Needs you', error: 'Error', done: 'Done' });
/** What the Settings tab's buttons do (data-do). */
export const SETTING = Object.freeze({ smaller: 'smaller', bigger: 'bigger', unpair: 'unpair', page: 'page', scrolling: 'scrolling', compose: 'compose', dictation: 'dictation' });
/** Settings' pages (data-page): the list ('') opens each; themes opens from Appearance. */
export const SETTINGS_PAGE = Object.freeze({ list: '', alerts: 'alerts', appearance: 'appearance', themes: 'themes', text: 'text', scrolling: 'scrolling', compose: 'compose', dictation: 'dictation', pc: 'pc' });
/** Their titles, at the top. */
export const PAGE_TITLE = Object.freeze({ alerts: 'Alerts', appearance: 'Appearance', themes: 'More themes', text: 'Terminal text', scrolling: 'Scrolling', compose: 'Message box', dictation: 'Dictation', pc: 'Your PC' });
/** How the microphone dictates (compose.js DICTATION), as Settings offers it. */
const DICTATION_CHOICES = [['keyboard', 'Keyboard', 'Use the keyboard\'s microphone. The phone never asks'], ['termilly', 'Termilly', 'Dictates without the keyboard. iOS asks for the microphone after each restart']];
/** The boxes for writing to Claude (compose.js COMPOSE_STYLE), as Settings offers them. */
const COMPOSE_CHOICES = [['messages', 'Messages', 'A round field with the microphone, over the keys'], ['bar', 'One bar', 'Keys and the field share one row, with a switch']];
/** The ways the terminal scrolls back (gestures.js SCROLLING), as Settings offers them. */
const SCROLL_CHOICES = [['smooth', 'Smooth'], ['lines', 'Line by line']];
/** The looks at the top of Settings › Appearance; the other themes have their own page. */
const FIRST_LOOKS = Object.freeze(['pc', 'auto', 'dark', 'light']);
/** The text sizes the terminal steps through (points). */
export const TEXT_SIZES = [9, 10, 11, 12, 13, 14, 16, 18, 20];

/** 24px line icons, drawn on whole pixels so they stay sharp. */
const ICON = Object.freeze({
  terminals: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9l3 3-3 3M12 15h5"/>',
  // A page with its corner turned and lines: the PC's notes.
  memos: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4M9 12h7M9 16h5"/>',
  notes: '<path d="M6 16V11a6 6 0 0112 0v5l2 2H4z"/><path d="M10 20h4"/>',
  // The desktop's Settings button (index.html), on this grid.
  settings: '<path d="M4 7h6M16 7h4M4 17h3M13 17h7"/><circle cx="13" cy="7" r="2.75"/><circle cx="10" cy="17" r="2.75"/>',
});
const LABEL = Object.freeze({ terminals: 'Terminals', memos: 'Notes', notes: 'Notifications', settings: 'Settings' });

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
  return `${backRow(SETTINGS_PAGE.appearance)}
    <div class="list looks">${looks.filter(l => !FIRST_LOOKS.includes(l.id)).map(l => lookHtml(l, chosen)).join('')}</div>`;
}

/**
 * Back to where a page opens from.
 * @param {string} to The page ('' for the list).
 */
const backRow = to => `<button class="back-row" data-do="${SETTING.page}" data-page="${to}">‹ ${to ? /** @type {Record<string, string>} */ (PAGE_TITLE)[to] : 'Settings'}</button>`;

/**
 * A row of the list: the setting, what it's set to, and its page.
 * @param {string} page
 * @param {string} value
 */
const pageRow = (page, value) => `<button class="row look" data-do="${SETTING.page}" data-page="${page}"><span class="r-text">${/** @type {Record<string, string>} */ (PAGE_TITLE)[page]}</span>
  <span class="more-value">${esc(value)}</span><span class="chev">›</span></button>`;

/**
 * Choices with a tick on the one set.
 * @param {string[][]} list [id, name, hint?]
 * @param {string} chosen
 * @param {string} action data-do; the id goes in data-<action>
 */
const choicesHtml = (list, chosen, action) => `<div class="list looks">${list.map(([id, name, hint]) => `<button class="row look${id === chosen ? ' on' : ''}" data-do="${action}" data-${action}="${id}">
  <span class="r-text"><span class="r-name">${name}</span>${hint ? `<span class="r-line wrap">${hint}</span>` : ''}</span><span class="tick">${id === chosen ? '✓' : ''}</span></button>`).join('')}</div>`;

/**
 * The name of the choice set.
 * @param {string[][]} list
 * @param {string} id
 */
const nameOf = (list, id) => list.find(c => c[0] === id)?.[1] ?? '';

/**
 * This phone's settings: a list of rows, each with its own page.
 * @param {{ page: string, alerts: string, alertsOn: string, size: number, scrolling: string, compose: string, dictation: string, host: string, connected: boolean, look: string, looks: Look[] }} now
 */
export function settingsHtml(now) {
  const back = backRow(SETTINGS_PAGE.list);
  switch (now.page) {
    case SETTINGS_PAGE.alerts: return `${back}<div class="list pad">${now.alerts}</div>`;
    case SETTINGS_PAGE.appearance: {
      const other = FIRST_LOOKS.includes(now.look) ? null : now.looks.find(l => l.id === now.look);
      return `${back}<div class="list looks">${now.looks.filter(l => FIRST_LOOKS.includes(l.id)).map(l => lookHtml(l, now.look)).join('')}
      ${pageRow(SETTINGS_PAGE.themes, other?.name ?? '')}</div>
      <p class="muted hint">Same as PC follows the desktop's theme as it changes; System, the phone's light or dark mode.</p>`;
    }
    case SETTINGS_PAGE.text: return `${back}<div class="list pad stepper"><button class="btn" data-do="${SETTING.smaller}" aria-label="Smaller">A−</button>
      <span>${now.size} pt</span><button class="btn" data-do="${SETTING.bigger}" aria-label="Bigger">A+</button></div>`;
    case SETTINGS_PAGE.scrolling: return back + choicesHtml(SCROLL_CHOICES, now.scrolling, SETTING.scrolling);
    case SETTINGS_PAGE.compose: return `${back}${choicesHtml(COMPOSE_CHOICES, now.compose, SETTING.compose)}
      <p class="muted hint">Under a Claude terminal, for writing to Claude.</p>`;
    case SETTINGS_PAGE.dictation: return back + choicesHtml(DICTATION_CHOICES, now.dictation, SETTING.dictation);
    case SETTINGS_PAGE.pc: return `${back}<div class="list pad"><p class="mono">${esc(now.host)}</p>
      <p class="muted">${now.connected ? 'Connected.' : 'Reconnecting.'}</p></div>
      <div class="section">Pairing</div><div class="list pad"><p class="muted">The PC forgets this phone; it needs a new code to come back.</p>
      <div class="w-actions"><button class="btn danger" data-do="${SETTING.unpair}">Unpair this phone</button></div></div>`;
    default: return `<div class="section">This phone</div><div class="list looks">${pageRow(SETTINGS_PAGE.alerts, now.alertsOn)}
      ${pageRow(SETTINGS_PAGE.appearance, now.looks.find(l => l.id === now.look)?.name ?? '')}${pageRow(SETTINGS_PAGE.text, `${now.size} pt`)}
      ${pageRow(SETTINGS_PAGE.scrolling, nameOf(SCROLL_CHOICES, now.scrolling))}${pageRow(SETTINGS_PAGE.compose, nameOf(COMPOSE_CHOICES, now.compose))}
      ${pageRow(SETTINGS_PAGE.dictation, nameOf(DICTATION_CHOICES, now.dictation))}</div>
    <div class="section">Connection</div><div class="list looks">${pageRow(SETTINGS_PAGE.pc, now.connected ? 'Connected' : 'Reconnecting')}</div>`;
  }
}
