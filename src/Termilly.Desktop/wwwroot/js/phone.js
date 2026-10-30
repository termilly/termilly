// @ts-check
// Termilly on a phone (Features/Phone.cs, phone/app.js, docs/phone.md): what the phones show, sent to the host
// whenever a terminal or agent changes (the host passes it to each phone that has the app open), and a phone's
// answer to an agent: Approve, Approve and don't ask again, Reject, or a reply in its own words. The terminal is
// checked to still be waiting before anything is typed.

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { state, on, wsById, tabTitle, profileOf, activityOf, runsClaude, BADGES, EVENTS } from './store.js';
import { entryDetail } from './inbox.js';
import { AGENT_STATE, CLAUDE_TOOL, PROFILE_ICON } from './constants.js';
import { debounce } from './util.js';
import { isProduction } from './environments.js';

/** How long changes settle before the phones hear of them. */
const SEND_AFTER_MS = 300;
/** Claude Code's permission prompt: Enter takes "Yes", 2 "Yes, and don't ask again", Esc "No, and tell Claude". */
const KEYS = Object.freeze({ approve: '\r', always: '2', reject: '\x1b' });
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
 * Waiting on a permission prompt (not a question, which needs typing).
 * @param {Tab} tab
 */
const awaitsPermission = tab => tab.agent?.state === AGENT_STATE.needsInput && !!tab.agent.tool && tab.agent.tool !== CLAUDE_TOOL.askUserQuestion;

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
  return kind && { kind, tool: a.tool ?? null, target: a.target ?? null, text: entryDetail(tab), at: a.at };
}

/** @param {Tab} tab */
function terminalOf(tab) {
  const profile = profileOf(tab);
  const icon = runsClaude(tab) ? CLAUDE_BADGE : profile?.icon ?? '';
  const activity = activityOf(tab);
  return {
    id: tab.id, ws: tab.wsId, title: tabTitle(tab), icon,
    badge: /** @type {Record<string, string>} */ (WORDS)[icon] ?? /** @type {Record<string, string>} */ (BADGES)[icon] ?? '>_',
    agent: tab.agent?.state ?? null,
    activity: activity?.kind ?? (tab.exited ? 'exited' : null),
    line: tab.agent?.line ?? activity?.title ?? null,
    waiting: waitingFor(tab),
    production: isProduction(tab),
    // The terminal's size: the phone starts at it, then asks for its own (Features/Phone.cs, phone:size).
    cols: tab.view?.term?.cols ?? null, rows: tab.view?.term?.rows ?? null,
  };
}

/** What the phones show: this PC's workspaces, in order, their terminals, and whether a phone may type into them. */
function snapshot() {
  return {
    typing: !!state.settings.phone?.allowTyping,
    workspaces: state.workspaces.map(w => ({ id: w.id, name: w.name, color: w.color })),
    terminals: [...state.tabs.values()].filter(t => t.wsId && wsById(t.wsId) && !t.virtual).map(terminalOf),
  };
}

const publish = debounce(() => {
  if (state.settings.phone?.enabled) send(PAGE.phoneState, { state: snapshot() });
}, SEND_AFTER_MS);

for (const event of [EVENTS.agent, EVENTS.tab, EVENTS.tabClosed, EVENTS.workspaces, EVENTS.settings]) on(event, publish);
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
    return { answered: choice };
  }
  if (!awaitsPermission(tab)) throw new Error('That terminal isn’t waiting for a yes or no any more.');
  const key = /** @type {Record<string, string>} */ (KEYS)[choice ?? ''];
  if (!key) throw new Error('Not an answer.');
  send(PAGE.input, { id: tab.id, data: key });
  return { answered: choice };
}

// A phone shows a terminal: it takes the phone's size, so it fills the phone and what it prints fits it; it gets its
// pane's size back when no phone shows it.
onHost(HOST.phoneSize, m => {
  const tab = state.tabs.get(m.id);
  const view = tab?.view;
  if (!tab || !view?.term) return;
  tab.phoneSize = m.cols && m.rows ? { cols: m.cols, rows: m.rows } : null;
  view.body.classList.toggle('phone-sized', !!tab.phoneSize);
  if (tab.phoneSize) view.term.resize(tab.phoneSize.cols, tab.phoneSize.rows);
  else view.fit?.fit();
});

onHost(HOST.phoneAnswer, async m => {
  try {
    send(PAGE.apiResult, { requestId: m.requestId, result: await answer(m.args ?? {}) });
  } catch (e) {
    send(PAGE.apiResult, { requestId: m.requestId, error: /** @type {Error} */ (e).message });
  }
});
