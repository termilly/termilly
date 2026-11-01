// @ts-check
// Termilly on a phone (Features/Phone.cs, phone/app.js, docs/phone.md): what the phones show, sent to the host
// whenever a terminal or agent changes (the host passes it to each phone that has the app open), and a phone's
// answer to an agent: Approve, Approve and don't ask again, Reject, or a reply in its own words. The terminal is
// checked to still be waiting before anything is typed.

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { state, on, wsById, tabTitle, profileOf, activityOf, runsClaude, markSeen, BADGES, EVENTS } from './store.js';
import { entryDetail, notesForPhone } from './inbox.js';
import { AGENT_STATE, CLAUDE_TOOL, PROFILE_ICON } from './constants.js';
import { debounce } from './util.js';
import { isProduction } from './environments.js';
import { screenOf } from './termscreen.js';
import { agentInput } from './terminals.js';
import { placeholders } from './snippets.js';
import { clipsForPhone } from './smartclip.js';
import { THEMES, THEME_BASE, themeId, onSystemThemeChange } from './themes.js';
import { termTheme } from './terminals.js';
import { placesForPhone } from './phonemanage.js';

/** How long changes settle before the phones hear of them. */
const SEND_AFTER_MS = 300;
/** Claude Code's permission prompt: Enter takes "Yes", 2 "Yes, and don't ask again", Esc "No, and tell Claude". */
const KEYS = Object.freeze({ approve: '\r', reject: '\x1b' });
/**
 * A permission prompt's "Yes, and don't ask again" choice (or "Yes, allow all edits"), as Claude Code draws it: its
 * number. Not every prompt has one (a command it won't remember, like rm, has only Yes and No), and where it has, it's
 * not always 2, so it's read off the screen.
 */
const ALWAYS = /^\W*(\d)\.\s*Yes, (?:and don.t ask again|allow all)/i;
/** How far above the screen's bottom the prompt's choices are looked for (lines). */
const PROMPT_LINES = 40;
const CHOICE = Object.freeze({ approve: 'approve', always: 'always', reject: 'reject', reply: 'reply' });
/** After Esc, Claude Code takes a moment to show its prompt for what to do instead; then the text, then Enter. */
const AFTER_ESC_MS = 400;
const ENTER_DELAY_MS = 200;
/** What a waiting terminal waits for, as the phone shows it. */
const WAITING = Object.freeze({ permission: 'permission', question: 'question', attention: 'attention', error: 'error' });
/** The badge marks the phone draws: the desktop's pixel words as text. */
const WORDS = { [PROFILE_ICON.serial]: 'COM', [PROFILE_ICON.ssh]: 'SSH', [PROFILE_ICON.wsl]: 'WSL' };
const CLAUDE_BADGE = 'claude';
/**
 * A badge's text for a profile's icon, as the PC's sidebar shows it.
 * @param {string} icon
 */
const badgeOf = icon => /** @type {Record<string, string>} */ (WORDS)[icon] ?? /** @type {Record<string, string>} */ (BADGES)[icon] ?? '>_';

/**
 * Waiting on a permission prompt (not a question, which needs typing).
 * @param {Tab} tab
 */
const awaitsPermission = tab => tab.agent?.state === AGENT_STATE.needsInput && !!tab.agent.tool && tab.agent.tool !== CLAUDE_TOOL.askUserQuestion;

/**
 * The key that picks the prompt's "don't ask again" choice, read off the terminal's screen; null when it has none.
 * @param {Tab} tab
 */
function alwaysKey(tab) {
  const term = tab.view?.term;
  if (!term) return null;
  const buffer = term.buffer.active;
  for (let y = buffer.length - 1; y >= Math.max(0, buffer.length - PROMPT_LINES); y--) {
    const found = ALWAYS.exec(buffer.getLine(y)?.translateToString(true) ?? '');
    if (found) return found[1];
  }
  return null;
}

/**
 * What a terminal waits for, or null.
 * @param {Tab} tab
 */
function waitingFor(tab) {
  const a = tab.agent;
  if (!a) return null;
  const kind = awaitsPermission(tab) ? WAITING.permission
    : a.state === AGENT_STATE.needsInput ? WAITING.question
    : a.state === AGENT_STATE.attention ? WAITING.attention
    : a.state === AGENT_STATE.error ? WAITING.error : null;
  return kind && { kind, tool: a.tool ?? null, target: a.target ?? null, text: entryDetail(tab), at: a.at,
    always: kind === WAITING.permission && !!alwaysKey(tab) };
}

/** A resuming terminal's line on the phone. */
const RESUMING_LINE = 'Resuming the Claude session';

/** @param {Tab} tab */
function terminalOf(tab) {
  const profile = profileOf(tab);
  const icon = runsClaude(tab) ? CLAUDE_BADGE : profile?.icon ?? '';
  const activity = activityOf(tab);
  return {
    id: tab.id, ws: tab.wsId, title: tabTitle(tab), icon, note: tab.note ?? null,
    badge: badgeOf(icon),
    agent: tab.agent?.state ?? null,
    activity: activity?.kind ?? (tab.exited ? 'exited' : null),
    percent: activity?.percent ?? null,
    hint: activity?.title ?? null,
    line: tab.resuming ? RESUMING_LINE : tab.agent?.line ?? activity?.title ?? null,
    waiting: waitingFor(tab),
    production: isProduction(tab),
    // Its Claude session is resuming on the PC (js/resuming.js): the phone waits before opening it.
    resuming: !!tab.resuming,
    // The terminal's size: the phone starts at it, then asks for its own (Features/Phone.cs, phone:size).
    cols: tab.view?.term?.cols ?? null, rows: tab.view?.term?.rows ?? null,
  };
}

/**
 * A snippet as the phone runs it (its key bar's snip): the workspace it's for (null: every one), and its placeholders.
 * @param {SnippetSetting} s
 * @param {string | null} ws
 */
const phoneSnippet = (s, ws) => ({ ws, name: s.name, description: s.description ?? '', command: s.command, enter: s.enter !== false, fields: placeholders(s.command) });

/** The snippets, for typing them from a phone: the global ones, then each workspace's. */
const snippetsForPhone = () => [
  ...(state.settings.commands.snippets ?? []).map(s => phoneSnippet(s, null)),
  ...state.workspaces.flatMap(w => (w.snippets ?? []).map(s => phoneSnippet(s, w.id))),
];

/**
 * The desktop's themes as a phone draws itself with them (phone/theme.js): its few colours, and the terminal's.
 * @param {import('./themes.js').Theme} t
 */
const phoneTheme = t => ({
  id: t.id, name: t.name, light: t.base === THEME_BASE.light, terminal: t.terminal,
  ui: { bg: t.window.background, raised: t.preview.side, line: t.preview.line, text: t.window.text, muted: t.preview.text, accent: t.window.accent },
});
const PHONE_THEMES = THEMES.map(phoneTheme);

/** What the phones show: this PC's workspaces, in order, their terminals, and whether a phone may type into them. */
function snapshot() {
  const typing = !!state.settings.phone?.allowTyping;
  return {
    typing,
    snippets: typing ? snippetsForPhone() : [],
    // Smart Clip's text clips to paste (their first lines; the PC pastes the whole one): Settings › Phone.
    clips: typing && state.settings.phone?.clips !== false ? clipsForPhone() : [],
    notes: notesForPhone(),
    // Its themes, the one it shows now and its terminals' colours then (a theme plugin's, if one is chosen).
    themes: PHONE_THEMES, pcTheme: themeId(), pcTerminal: termTheme(),
    workspaces: state.workspaces.map(w => ({ id: w.id, name: w.name, color: w.color, cwd: w.cwd ?? null, note: w.note ?? null })),
    // What a phone may open a terminal on, and where it opens by default (only while it may type: js/phonemanage.js).
    places: typing ? placesForPhone(badgeOf) : [], activeWs: state.activeId,
    terminals: [...state.tabs.values()].filter(t => t.wsId && wsById(t.wsId) && !t.virtual).map(terminalOf),
  };
}

const publish = debounce(() => {
  if (state.settings.phone?.enabled) send(PAGE.phoneState, { state: snapshot() });
}, SEND_AFTER_MS);

for (const event of [EVENTS.agent, EVENTS.tab, EVENTS.tabClosed, EVENTS.workspaces, EVENTS.settings, EVENTS.profiles, EVENTS.clips]) on(event, publish);
// Windows switched light and dark: the "system" theme is the other one now.
onSystemThemeChange(publish);
// A terminal resized on the PC: the phones draw it at its new size.
on(EVENTS.terminalOpened, tab => tab.view?.term?.onResize(() => publish()));

/** @param {number} ms */
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Types a phone's answer into a terminal that still waits for one.
 * @param {{ pane?: string, choice?: string, text?: string }} args
 */
async function answer({ pane, choice, text }) {
  const tab = state.tabs.get(pane ?? '');
  if (!tab || tab.exited) throw new Error('That terminal is gone.');
  if (choice === CHOICE.reply) {
    if (!text?.trim()) throw new Error('The reply is empty.');
    if (!waitingFor(tab)) throw new Error('That terminal isn’t waiting for you any more.');
    // A permission prompt first gets "No, tell Claude what to do instead" (Esc); then the words, then Enter.
    if (awaitsPermission(tab)) {
      send(PAGE.input, { id: tab.id, data: KEYS.reject });
      await pause(AFTER_ESC_MS);
    }
    send(PAGE.input, { id: tab.id, data: text });
    await pause(ENTER_DELAY_MS);
    send(PAGE.input, { id: tab.id, data: '\r' });
    agentInput(tab, '\r');
    return { answered: choice };
  }
  if (!awaitsPermission(tab)) throw new Error('That terminal isn’t waiting for a yes or no any more.');
  const key = choice === CHOICE.always ? alwaysKey(tab) : /** @type {Record<string, string>} */ (KEYS)[choice ?? ''];
  if (!key) throw new Error(choice === CHOICE.always ? 'This prompt has no "don\'t ask again". Nothing was typed.' : 'Not an answer.');
  send(PAGE.input, { id: tab.id, data: key });
  agentInput(tab, key); // answered, as from the keyboard here: no longer waiting
  return { answered: choice };
}

// A phone shows a terminal: it takes the phone's size, so it fills the phone and what it prints fits it, drawn here in
// a phone with that phone's name and address under it; it gets its pane's size back when no phone shows it. The phone
// keeps its full height when the phone's keyboard takes rows away: its tallest size while it shows the terminal.
onHost(HOST.phoneSize, m => {
  const tab = state.tabs.get(m.id);
  const view = tab?.view;
  if (!tab || !view?.term) return;
  const before = tab.phoneSize;
  // The phone's keyboard came or went: the same columns, rows no more than its tallest. The phone keeps its size and
  // font; only its rows change (fitting again drew it at Settings' font for a frame, and the pane's scrollbar blinked).
  if (before && m.cols === before.cols && m.rows && m.rows <= (before.tallest ?? 0)) {
    tab.phoneSize = { ...before, rows: m.rows };
    if (view.term.rows !== m.rows) view.term.resize(m.cols, m.rows);
    return;
  }
  tab.phoneSize = m.cols && m.rows
    ? { cols: m.cols, rows: m.rows, tallest: before?.cols === m.cols ? Math.max(before.tallest ?? 0, m.rows) : m.rows }
    : null;
  view.body.classList.toggle('phone-sized', !!tab.phoneSize);
  if (tab.phoneSize) {
    view.body.dataset.phone = [m.name ?? 'A phone', m.address].filter(Boolean).join(' · ');
    view.term.resize(tab.phoneSize.cols, tab.phoneSize.rows);
    phoneTabs.set(view.body, tab);
    resized.observe(view.body);
    requestAnimationFrame(() => fitPhone(tab)); // once the new size is drawn
  } else {
    delete view.body.dataset.phone;
    resized.unobserve(view.body);
    if (view.term.element) view.term.element.style.minHeight = '';
    view.term.options.fontSize = state.settings.terminal.fontSize;
    view.fit?.fit();
  }
});

/** Room in a phone-sized pane for its padding and the phone's name under the phone (app.css). */
const PHONE_ROOM = Object.freeze({ width: 40, height: 84 });
/** Where xterm draws the characters: its size is the grid's. */
const TERM_SCREEN = '.xterm-screen';
/** The smallest font a phone's terminal gets here: it shows what the phone shows, smaller than one would type in. */
const PHONE_MIN_FONT = 4;
/** @type {WeakMap<Element, Tab>} */
const phoneTabs = new WeakMap();
const resized = new ResizeObserver(entries => {
  for (const e of entries) {
    const tab = phoneTabs.get(e.target);
    if (tab?.phoneSize) fitPhone(tab);
  }
});

/**
 * The frame around a phone's terminal (app.css): its padding and border.
 * @param {HTMLElement} element
 */
function phoneFrame(element) {
  const s = getComputedStyle(element), px = (/** @type {string[]} */ ...names) => names.reduce((n, k) => n + parseFloat(s.getPropertyValue(k)), 0);
  return { width: px('padding-left', 'padding-right', 'border-left-width', 'border-right-width'), height: px('padding-top', 'padding-bottom', 'border-top-width', 'border-bottom-width') };
}

/**
 * A terminal a phone shows, in its phone, fits its pane: its font gets smaller as needed (never bigger than Settings'),
 * as it keeps the phone's columns and rows. The phone is as tall as its tallest rows, so the keyboard doesn't shrink it.
 * @param {Tab} tab
 */
function fitPhone(tab) {
  const view = tab.view, term = view?.term, screen = term?.element?.querySelector(TERM_SCREEN);
  if (!view || !term?.element || !screen) return;
  const full = state.settings.terminal.fontSize;
  if (term.options.fontSize !== full) {
    term.options.fontSize = full;
    requestAnimationFrame(() => fitPhone(tab)); // measured at Settings' font, once drawn
    return;
  }
  const inner = screen.getBoundingClientRect(), frame = phoneFrame(term.element);
  const tall = inner.height * tallestOf(tab) / term.rows;
  const scale = Math.min(1,
    (view.body.clientWidth - PHONE_ROOM.width - frame.width) / inner.width,
    (view.body.clientHeight - PHONE_ROOM.height - frame.height) / tall);
  if (scale < 1) term.options.fontSize = Math.max(PHONE_MIN_FONT, Math.floor(full * scale * 2) / 2);
  requestAnimationFrame(() => holdHeight(tab)); // at the new font, once drawn
}

/** @param {Tab} tab */
const tallestOf = tab => Math.max(tab.phoneSize?.tallest ?? 0, tab.view?.term?.rows ?? 1);

/**
 * The phone keeps its tallest height: rows the keyboard took stay as empty screen under the terminal.
 * @param {Tab} tab
 */
function holdHeight(tab) {
  const term = tab.view?.term, screen = term?.element?.querySelector(TERM_SCREEN);
  if (!tab.phoneSize || !term?.element || !screen) return;
  const tall = screen.getBoundingClientRect().height * tallestOf(tab) / term.rows;
  term.element.style.minHeight = `${Math.ceil(tall + phoneFrame(term.element).height)}px`;
}

// A phone starts showing a terminal (already at its size): what it shows now, once what it printed is drawn.
onHost(HOST.phoneScreen, async m => {
  const term = state.tabs.get(m.args?.pane)?.view?.term;
  if (term) await new Promise(resolve => term.write('', resolve));
  send(PAGE.apiResult, { requestId: m.requestId, result: { data: term ? screenOf(term) : '' } });
});

// A key typed on a phone's terminal view: an answer to an agent counts as one typed here.
onHost(HOST.phoneTyped, m => {
  const tab = state.tabs.get(m.id);
  if (tab) agentInput(tab, m.data);
});

// A phone has the terminal on its screen: its news is seen there, so here too (unread, the Windows notification).
onHost(HOST.phoneSeen, m => {
  const tab = state.tabs.get(m.id);
  if (tab) markSeen(tab);
});

onHost(HOST.phoneAnswer, async m => {
  try {
    send(PAGE.apiResult, { requestId: m.requestId, result: await answer(m.args ?? {}) });
  } catch (e) {
    send(PAGE.apiResult, { requestId: m.requestId, error: /** @type {Error} */ (e).message });
  }
});
