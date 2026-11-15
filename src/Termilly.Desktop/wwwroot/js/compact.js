// @ts-check
// The compact view of an agent terminal (Claude Code or Codex): instead of the terminal, one line per step, read from
// the agent's session file by the host (Features/CompactFeed.cs) and drawn by compactlines.js, with a prompt box of
// its own that types into the agent. The terminal keeps running underneath at its size, so switching never redraws
// the agent; a switch in the pane's header (header.js) flips between the views, remembered per terminal. The minimal
// view is the same with only the prompts and the agent's final answers (no tools, thinking or words in between).

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { state, on, runningAgent, runsClaude, persist, EVENTS } from './store.js';
import { AGENT_STATE, COMPACT_LIMIT, COMPACT_VERB, CLAUDE_TOOL } from './constants.js';
import { agentKind } from './agentkinds.js';
import { escapeHtml, ICONS } from './ui.js';
import { showMenu } from './popups.js';
import { find } from './dom.js';
import { agentInput, fontStack } from './terminals.js';
import { beforeEnter } from './api.js';
import { showsInput } from './together.js';
import { linesHtml } from './compactlines.js';
import { lineLinks, clickLink, wireCtrl } from './compactlinks.js';
import { readMenu, questionMenu, cardHtml, menuKey } from './compactcard.js';
import { wireInput } from './compactinput.js';
import { liveRow, screenRows } from './compactdrawer.js';

/** @typedef {import('./compactlines.js').CompactLine} CompactLine */

/** The views the header's view button picks between. */
export const COMPACT_VIEW = Object.freeze({ minimal: 'minimal', compact: 'compact', full: 'full' });

/** Each view as the view button and its menu show it. */
const VIEWS = Object.freeze([
  { view: COMPACT_VIEW.minimal, label: 'Minimal', icon: ICONS.viewMinimal, title: 'Only your prompts and the agent’s final answers, with a prompt box' },
  { view: COMPACT_VIEW.compact, label: 'Compact', icon: ICONS.viewCompact, title: 'One line per step, with a prompt box' },
  { view: COMPACT_VIEW.full, label: 'Full', icon: ICONS.viewFull, title: 'The agent’s own screen' },
]);

/** The header's view button (header.js has it). */
export const VIEW_BUTTON = '.view-btn';

/** Enter, as a terminal gets it. */
const ENTER = '\r';
/** The view's class while its drawer shows the terminal's own rows under it. */
const DRAWER_CLASS = 'drawer';
/** The pane's class while it shows the compact view (the terminal is hidden under it). */
const SHOWN_CLASS = 'compact-on';
/** The prompt box. */
const INPUT = '.cv-input';
/** The feed's button that shows the terminal (while the agent waits on a question). */
const OPEN_TERMINAL = '.cv-open-terminal';
/** A card in the feed: data-menu holds the key of the menu it shows. */
const CARD = '.cv-card';
/** A card's choice buttons: data-choice holds the key that picks it. */
const CHOICE = '[data-choice]';
/** A choice picked on a card isn't pressed again on the same menu for this long (the agent takes a moment to move on). */
const REPICK_MS = 2000;
/** Within this many pixels of the bottom, the feed counts as following the newest line. */
const FOLLOW_SLACK_PX = 40;
/** The view's text size and font: the terminals', so its text looks as the terminal's does (app.css sizes the rest from it). */
const TEXT_SIZE = '--cv-size';
const TEXT_FONT = '--cv-font';
/** Bracketed paste: a text of several lines goes in as one, so its newlines don't send it line by line. */
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

const VIEW_HTML = `
  <div class="cv-feed" tabindex="-1"></div>
  <div class="cv-live">Live terminal below: keys go to the agent</div>
  <div class="cv-picks" hidden></div>
  <div class="cv-composer">
    <textarea class="cv-input" rows="1" spellcheck="false"></textarea>
    <button class="cv-send" title="Send (Enter)">Send</button>
  </div>
  <div class="cv-hint">Enter sends, Shift+Enter adds a line</div>`;

/**
 * A terminal's compact view: what the host sent of its session, the elements showing it, and the prompt being typed.
 * @typedef {{ lines: CompactLine[], session: string | null, el: HTMLElement | null, frame: number, frameWin: Window | null, sending: Promise<void>, writes: { dispose(): void } | null,
 *   picked?: { menu: string, at: number }, ready?: boolean, drawer?: boolean, drawerFrame?: number, drawerWin?: Window,
 *   resizes?: { dispose(): void }, drawerRow?: number }} CompactState
 */

/**
 * @param {Tab} tab
 * @returns {CompactState}
 */
const compactOf = tab => /** @type {CompactState} */ (tab.compact ??= { lines: [], session: null, el: null, frame: 0, frameWin: null, sending: Promise.resolve(), writes: null });

/**
 * The view the user picked for the terminal (saved as true for the compact view, as before there was a minimal one).
 * @param {Tab} tab
 * @returns {string} a COMPACT_VIEW
 */
const pickedView = tab => tab.compactView === COMPACT_VIEW.minimal ? COMPACT_VIEW.minimal : tab.compactView ? COMPACT_VIEW.compact : COMPACT_VIEW.full;

/**
 * Whether the terminal shows its compact view (or the minimal one): the user switched it on, and an agent runs there.
 * @param {Tab} tab
 */
export const isCompact = tab => !!tab.compactView && !!runningAgent(tab);

/**
 * Whether the view shows only the prompts and the final answers.
 * @param {Tab} tab
 */
const isMinimal = tab => pickedView(tab) === COMPACT_VIEW.minimal;

/**
 * Whether the header shows the switch: an agent runs in the terminal.
 * @param {Tab} tab
 */
export const hasCompact = tab => !!runningAgent(tab);

/**
 * Switches the terminal between its minimal view, its compact view and the terminal.
 * @param {Tab} tab
 * @param {string} view a COMPACT_VIEW
 */
function setView(tab, view) {
  const was = pickedView(tab);
  if (was === view) return;
  tab.compactView = view === COMPACT_VIEW.minimal ? COMPACT_VIEW.minimal : view === COMPACT_VIEW.compact ? true : undefined;
  persist();
  // Between the two views only what the feed shows changes.
  if (was !== COMPACT_VIEW.full && view !== COMPACT_VIEW.full) {
    updateSwitch(tab);
    render(tab);
    return;
  }
  apply(tab);
  if (view !== COMPACT_VIEW.full) focusInput(tab);
  else tab.view?.term?.focus();
}

/**
 * Shows or hides the view as the switch and the agent say, and follows the agent's session while it shows.
 * @param {Tab} tab
 */
function apply(tab) {
  const view = tab.view;
  if (!view) return;
  const shown = isCompact(tab);
  view.el.classList.toggle(SHOWN_CLASS, shown);
  const c = compactOf(tab);
  if (shown && !c.el) c.el = build(tab);
  if (c.el) c.el.hidden = !shown;
  // While the agent waits on a question, its card follows the screen (a choice picked with the keys, a new question).
  if (c.el && view.term && !c.writes) c.writes = view.term.onWriteParsed(() => onScreen(tab));
  // A resized pane moves the terminal's rows: the drawer follows them.
  if (c.el && view.term && !c.resizes) c.resizes = view.term.onResize(() => placeDrawerSoon(tab));
  updateSwitch(tab);
  const session = shown ? sessionOf(tab) : null;
  if (session !== c.session) {
    c.session = session;
    c.lines = [];
    send(PAGE.compactWatch, { id: tab.id, session, agent: runningAgent(tab) });
  }
  if (shown) render(tab);
  placeDrawerSoon(tab);
}

/**
 * The session the view follows: the one the agent reported, or else the one Termilly resumed in it (Codex reports
 * nothing before its first prompt, so a session restored at start would show nothing until then).
 * @param {Tab} tab
 */
const sessionOf = tab => tab.agent?.session ?? tab.start?.resumeSession ?? null;

/**
 * The agent's screen changed: the card follows it while the agent waits on a question (a choice picked with the
 * keys, the next question), and the prompt box comes on once the agent is at its prompt (Codex reports nothing
 * before its first prompt, so its screen is all there is to go by).
 * @param {Tab} tab
 */
function onScreen(tab) {
  if (!isCompact(tab)) return;
  const c = compactOf(tab);
  const ready = atPrompt(tab);
  // While it starts, anything it draws may be a menu of its own (a trust question): drawn as it comes.
  if (waitsForAnswer(tab) || !ready || ready !== c.ready) render(tab);
  c.ready = ready;
  placeDrawerSoon(tab);
}

/**
 * Places the drawer on the next frame (the screen changes in bursts).
 * @param {Tab} tab
 */
function placeDrawerSoon(tab) {
  const c = compactOf(tab);
  if (!c.el) return;
  // As with the feed's frames: one asked of another window (the pane moved between windows) is asked again here.
  const win = c.el.ownerDocument.defaultView ?? window;
  if (c.drawerFrame && c.drawerWin === win) return;
  if (c.drawerFrame && c.drawerWin && !c.drawerWin.closed) c.drawerWin.cancelAnimationFrame(c.drawerFrame);
  c.drawerWin = win;
  c.drawerFrame = win.requestAnimationFrame(() => {
    c.drawerFrame = 0;
    placeDrawer(tab);
  });
}

/**
 * Opens the drawer on the terminal's own rows when the agent's screen wants keys the view doesn't draw (compactdrawer.js),
 * by leaving the bottom of the pane uncovered from that row down, with the keyboard in the terminal; closes it, and
 * gives the prompt box the keyboard back, once the agent is back at its plain prompt.
 * @param {Tab} tab
 */
function placeDrawer(tab) {
  const c = compactOf(tab);
  const view = tab.view;
  if (!c.el || !view?.term) return;
  // Open, it stays open while the user works in the terminal and the agent waits (the cursor moved home in what
  // they typed, or onto its second line, says nothing of whether there are words there).
  const stays = !!c.drawer && view.term.element?.contains(view.body.ownerDocument.activeElement) && !tab.exited
    && tab.agent?.state !== AGENT_STATE.working && tab.agent?.state !== AGENT_STATE.needsInput;
  const found = isCompact(tab) ? liveRow(tab) : -1;
  const row = found < 0 && stays && isCompact(tab) ? c.drawerRow ?? -1 : found;
  c.drawerRow = row;
  const open = row >= 0;
  c.el.style.bottom = open ? `${Math.max(0, view.body.clientHeight - rowTop(view, row))}px` : '';
  c.el.classList.toggle(DRAWER_CLASS, open);
  if (open === !!c.drawer) return;
  c.drawer = open;
  // Only a pane that has the keyboard hands it over: a drawer opening in another pane mustn't take what's typed here.
  const here = view.body.contains(view.body.ownerDocument.activeElement);
  if (open && here) view.term.focus();
  else if (!open && here && isCompact(tab)) focusInput(tab);
}

/**
 * Where a screen row's top is in the pane's body (pixels from its top).
 * @param {TabView} view
 * @param {number} row
 */
function rowTop(view, row) {
  const screen = view.term.element?.querySelector('.xterm-screen');
  if (!screen) return 0;
  const box = screen.getBoundingClientRect();
  return box.top - view.body.getBoundingClientRect().top + row * (box.height / view.term.rows);
}

/**
 * The menu a card shows now, when it can be told apart (it has a key): the question the agent waits on, or the menu it
 * shows as it starts; null when there's none.
 * @param {Tab} tab
 */
function shownMenu(tab) {
  const menu = waitsForAnswer(tab) ? menuOf(tab) : !atPrompt(tab) ? screenMenu(tab) : null;
  const key = menu ? menuKey(menu) : '';
  // The card drawn now, not only the menu read now: a new question waits a frame for its card.
  const drawn = /** @type {HTMLElement | null | undefined} */ (compactOf(tab).el?.querySelector(CARD))?.dataset.menu;
  return key && key === drawn ? menu : null;
}

/**
 * A key the prompt box passes on, typed into the agent as its terminal would get it; Enter answers what it waits on.
 * @param {Tab} tab
 * @param {string} data
 */
function passKey(tab, data) {
  if (tab.exited || !runningAgent(tab)) return;
  // Enter picks: only what a card shows (the user sees what it picks), never a question the view can't show.
  if (data === ENTER && !shownMenu(tab)) return;
  send(PAGE.input, { id: tab.id, data });
  agentInput(tab, data);
}

/**
 * Builds the view in the pane's body, over the terminal.
 * @param {Tab} tab
 */
function build(tab) {
  const view = /** @type {TabView} */ (tab.view);
  const el = document.createElement('div');
  el.className = 'compact-view';
  el.innerHTML = VIEW_HTML;
  view.body.append(el);
  sizeText(el);
  const input = /** @type {HTMLTextAreaElement} */ (find(el, INPUT));
  wireInput(tab, el, {
    submit: () => submit(tab, input),
    passKey: data => passKey(tab, data),
    agent: () => runningAgent(tab),
    folder: () => tab.agent?.folder ?? tab.cwd ?? tab.lastCwd ?? null,
  });
  input.addEventListener('input', () => fitInput(input));
  find(el, '.cv-send').addEventListener('click', () => submit(tab, input));
  // Buttons drawn in the feed are handled here: a terminal in a window of its own has that window's elements.
  el.addEventListener('click', e => {
    const target = /** @type {Element} */ (e.target);
    if (clickLink(tab, e)) return;
    if (target.closest?.(OPEN_TERMINAL)) setView(tab, COMPACT_VIEW.full);
    const choice = /** @type {HTMLElement | null} */ (target.closest?.(CHOICE));
    const card = /** @type {HTMLElement | null} */ (target.closest?.(CARD));
    if (choice) pick(tab, choice.dataset.choice ?? '', card?.dataset.menu ?? '');
  });
  wireCtrl(el);
  // The terminal's right-click menu and copy-on-select (termclipboard.js) are the terminal's, not the view's.
  for (const type of ['contextmenu', 'mouseup']) el.addEventListener(type, e => e.stopPropagation());
  // The terminal underneath still takes the focus when its pane is clicked or focused (panes.js): the prompt box
  // takes it instead while the view shows.
  view.body.addEventListener('focusin', e => {
    if (isCompact(tab) && !compactOf(tab).drawer && !el.contains(/** @type {Node} */ (e.target))) focusInput(tab);
  });
  return el;
}

/**
 * The view's text is in the terminals' font, and grows and shrinks with it (Ctrl + and Ctrl -, Settings › Terminal).
 * @param {HTMLElement} el the view
 */
function sizeText(el) {
  el.style.setProperty(TEXT_SIZE, `${state.settings.terminal.fontSize}px`);
  el.style.setProperty(TEXT_FONT, fontStack(state.settings.terminal.fontFamily));
}

/**
 * The prompt box grows with its text, up to a few lines (CSS caps it).
 * @param {HTMLTextAreaElement} input
 */
function fitInput(input) {
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
}

/** @param {Tab} tab */
function focusInput(tab) {
  /** @type {HTMLTextAreaElement | null | undefined} */ (compactOf(tab).el?.querySelector(INPUT))?.focus();
}

/**
 * Whether the agent waits on a question of its own (a permission, a choice): what's typed would answer it, so the
 * prompt box waits too, and the feed shows the question as a card.
 * @param {Tab} tab
 */
const waitsForAnswer = tab => tab.agent?.state === AGENT_STATE.needsInput;

/**
 * Whether the agent is at its own prompt, so what's typed is a prompt: its hooks have reported (Claude Code's do as it
 * starts), or it's Codex, whose hooks report only once it's asked something, and its input line shows. Before that an
 * agent may show a screen of its own (Claude Code's "Do you trust this folder?"), which typing would answer.
 * @param {Tab} tab
 */
function atPrompt(tab) {
  if (runsClaude(tab)) return true;
  const kind = agentKind(runningAgent(tab));
  return !kind.hookAtStart && showsInput(tab, kind);
}

/**
 * Whether the prompt box's text may go to the agent now: it still runs there, is at its prompt, and isn't asking a
 * question of its own.
 * @param {Tab} tab
 */
const canSend = tab => !tab.exited && !!runningAgent(tab) && atPrompt(tab) && !waitsForAnswer(tab);

/**
 * Sends the prompt box's text to the agent. One prompt at a time per terminal: a second one sent while the first
 * waits for its Enter would run into it.
 * @param {Tab} tab
 * @param {HTMLTextAreaElement} input
 */
function submit(tab, input) {
  const text = input.value.trim();
  if (!text || !canSend(tab)) return;
  input.value = '';
  fitInput(input);
  const c = compactOf(tab);
  c.sending = c.sending.then(() => typePrompt(tab, text));
}

/**
 * Types a prompt into the agent and presses Enter, as the user would (Claude Code and Codex both take a prompt while
 * they work, and queue it). Checked again before each part: the agent may have left, or asked something, meanwhile.
 * @param {Tab} tab
 * @param {string} text
 */
async function typePrompt(tab, text) {
  if (!canSend(tab)) return;
  send(PAGE.input, { id: tab.id, data: text.includes('\n') ? `${PASTE_START}${text}${PASTE_END}` : text });
  await beforeEnter(tab);
  if (!canSend(tab)) return;
  send(PAGE.input, { id: tab.id, data: '\r' });
  agentInput(tab, '\r');
}

/**
 * Draws the view on the next frame (lines arrive in bursts while the agent works).
 * @param {Tab} tab
 */
function render(tab) {
  const c = compactOf(tab);
  if (!c.el) return;
  // The frame of the window it shows in: one of its own may be in front while the main window is minimized. A frame
  // asked of another window (the pane came back from one that closed) may never come: it's asked again here.
  const win = c.el.ownerDocument.defaultView ?? window;
  if (c.frame && c.frameWin === win) return;
  if (c.frame && c.frameWin && !c.frameWin.closed) c.frameWin.cancelAnimationFrame(c.frame);
  c.frameWin = win;
  c.frame = win.requestAnimationFrame(() => {
    c.frame = 0;
    draw(tab);
  });
}

/**
 * What each feed shows now, as drawn.
 * @type {WeakMap<HTMLElement, string>}
 */
const drawn = new WeakMap();

/** @param {Tab} tab */
function draw(tab) {
  const c = compactOf(tab);
  if (!c.el || c.el.hidden) return;
  const feed = find(c.el, '.cv-feed');
  const following = feed.scrollHeight - feed.scrollTop - feed.clientHeight < FOLLOW_SLACK_PX;
  const html = c.lines.length || waitsForAnswer(tab)
    ? linesHtml(c.lines, lineLinks(tab, c.lines, () => render(tab)), { minimal: isMinimal(tab), live: waitsForAnswer(tab) || tab.agent?.state === AGENT_STATE.working })
      + workingHtml(tab)
    : emptyHtml(tab);
  // Drawn again only when it changed: new elements under a pressed mouse button would lose its click (a press on a
  // card moves the focus about, which draws the view again), and a selection in the feed would be lost.
  if (drawn.get(feed) !== html) {
    feed.innerHTML = html;
    drawn.set(feed, html);
  }
  if (following) feed.scrollTop = feed.scrollHeight;
  updateComposer(tab, c.el);
}

/**
 * The menu on the agent's screen now (its question and numbered choices); null when it shows none it can read.
 * @param {Tab} tab
 */
function screenMenu(tab) {
  const term = tab.view?.term;
  // The screen as it shows now, not the lines scrolled above it (an earlier menu, a list in the agent's words).
  return term ? readMenu(screenRows(term)) : null;
}

/**
 * Claude Code's question (AskUserQuestion) the agent waits on: its line in the feed, which has its questions.
 * @param {Tab} tab
 */
function pendingQuestion(tab) {
  if (tab.agent?.tool !== CLAUDE_TOOL.askUserQuestion) return null;
  return compactOf(tab).lines.findLast(line => line.verb === COMPACT_VERB.ask && !line.done && line.questions?.length) ?? null;
}

/**
 * The plan Claude Code asks the user to approve (ExitPlanMode), as the host read it from its file; null for none.
 * @param {Tab} tab
 */
function pendingPlan(tab) {
  if (tab.agent?.tool !== CLAUDE_TOOL.exitPlanMode) return null;
  return compactOf(tab).lines.findLast(line => line.verb === COMPACT_VERB.plan && !line.done)?.body ?? null;
}

/**
 * The question the agent waits on, as the card shows it. Claude Code's own questions come from the session file, as
 * the agent asked them, since a short terminal scrolls their choices out of sight: the one whose title the screen
 * shows, or the only one there is. Questions with several picks, a question the screen doesn't name, the review
 * after the last question, and everything else (permissions, plan approval's choices, Codex's approvals) are read
 * off the screen.
 * @param {Tab} tab
 * @returns {import('./compactcard.js').Menu & { last?: boolean } | null}
 */
function menuOf(tab) {
  const screen = screenMenu(tab);
  // A plan up for approval: its choices from the screen, the plan itself from its file (the screen has room for neither).
  const plan = pendingPlan(tab);
  if (plan && screen) return { ...screen, context: plan.split('\n') };
  const ask = pendingQuestion(tab);
  if (!ask?.questions) return screen;
  const only = ask.questions.length === 1 ? ask.questions[0] : undefined;
  const named = screen ? ask.questions.find(q => q.question === screen.title) : undefined;
  // A screen that asks another question than these (the next AskUserQuestion, before its line is here) wins.
  if (!named && screen?.title.endsWith('?')) return screen;
  const question = named ?? only;
  if (!question || question.multi) return screen;
  // Claude Code goes on to its next question, or to its review of them, after this one; the last one is answered.
  return { ...questionMenu(question), last: question === only };
}

/**
 * Picks a choice of the question the agent waits on (or the menu it shows as it starts), by pressing its number as
 * the user would: only while the agent still waits on the very menu the card showed (the screen may have moved on to another question with a "1. Yes" of
 * its own), and once per menu (its number pressed twice would answer the next question too).
 * @param {Tab} tab
 * @param {string} key
 * @param {string} shown the card's menu, by menuKey
 */
function pick(tab, key, shown) {
  if (!(waitsForAnswer(tab) || !atPrompt(tab)) || tab.exited) return;
  const menu = menuOf(tab);
  const c = compactOf(tab);
  const now = menu ? menuKey(menu) : '';
  if (!menu || !now || now !== shown || !menu.choices.some(choice => choice.key === key)
      || (c.picked?.menu === now && Date.now() - c.picked.at < REPICK_MS)) {
    render(tab);
    return;
  }
  c.picked = { menu: now, at: Date.now() };
  send(PAGE.input, { id: tab.id, data: key });
  // Answered, as from the keyboard: no longer waiting. Not while Claude Code goes on to its next question or review.
  if (menu.last !== false) agentInput(tab, key);
}

/**
 * The card for the question the agent waits on.
 * @param {Tab} tab
 * @param {string} name the agent's short name, escaped
 */
const cardOf = (tab, name) => cardHtml(menuOf(tab), name, OPEN_TERMINAL.slice(1));

/**
 * The agent's state under the newest line: working, or the card for the question it waits on.
 * @param {Tab} tab
 */
function workingHtml(tab) {
  const name = escapeHtml(agentKind(runningAgent(tab)).short);
  if (waitsForAnswer(tab)) return cardOf(tab, name);
  return tab.agent?.state === AGENT_STATE.working ? `<div class="cv-working"><i></i>${name} is working</div>` : '';
}

/**
 * The feed before the session has anything in it.
 * @param {Tab} tab
 */
function emptyHtml(tab) {
  const name = escapeHtml(agentKind(runningAgent(tab)).short);
  if (!atPrompt(tab)) {
    // A menu of its own as it starts (Codex's "Trust and continue"): a card too.
    const menu = screenMenu(tab);
    if (menu && menuKey(menu)) return cardHtml(menu, name, OPEN_TERMINAL.slice(1));
    return `<div class="cv-empty">${name} is starting. Anything it asks first is in the terminal.<br><button class="${OPEN_TERMINAL.slice(1)}">Open terminal</button></div>`;
  }
  return `<div class="cv-empty">${compactOf(tab).session ? `Nothing yet. Ask ${name} something below.` : `Ask ${name} something below.`}</div>`;
}

/**
 * The prompt box: what it says, and whether it takes text now.
 * @param {Tab} tab
 * @param {HTMLElement} el
 */
function updateComposer(tab, el) {
  const name = agentKind(runningAgent(tab)).short;
  const input = /** @type {HTMLTextAreaElement} */ (find(el, INPUT));
  const waiting = waitsForAnswer(tab);
  const starting = !atPrompt(tab);
  input.placeholder = waiting ? `${name} is waiting for your answer above` : starting ? `${name} is starting` : `Message ${name}`;
  // Read-only, not disabled: its keys still go to the agent (Esc, Up and Down, Enter on a question's choices).
  input.readOnly = waiting || starting || !!tab.exited;
}

/**
 * The view that shows now: the one picked, or Full where the agent has left.
 * @param {Tab} tab
 */
const shownView = tab => (isCompact(tab) ? pickedView(tab) : COMPACT_VIEW.full);

/**
 * The header's view button: shown where an agent runs, with the icon of the view that shows.
 * @param {Tab} tab
 */
export function updateSwitch(tab) {
  const button = /** @type {HTMLElement | null | undefined} */ (tab.view?.header?.querySelector(VIEW_BUTTON));
  if (!button) return;
  button.hidden = !hasCompact(tab);
  const shown = VIEWS.find(v => v.view === shownView(tab)) ?? VIEWS[VIEWS.length - 1];
  const html = `${shown.icon}<span class="view-caret">${ICONS.caret}</span>`;
  if (button.dataset.view !== shown.view) {
    button.innerHTML = html;
    button.dataset.view = shown.view;
    button.title = `View: ${shown.label}`;
  }
}

/**
 * The view button's menu: the three views, the one that shows ticked.
 * @param {Tab} tab
 * @param {HTMLElement} anchor
 */
export function openViewMenu(tab, anchor) {
  const shown = shownView(tab);
  showMenu(VIEWS.map(v => ({ label: v.label, icon: v.icon, title: v.title, hint: v.view === shown ? ICONS.tick : '', action: () => setView(tab, v.view) })), anchor);
}

/**
 * The host's lines: all of them (the view was switched on, or the session is new), or what changed since. The view
 * keeps as many as the host does, so it shows the same ones when it's switched on again.
 * @param {CompactState} c
 * @param {import('./protocol.js').Host_compactLines} m
 */
function takeLines(c, m) {
  if (m.reset) {
    c.lines = [...m.lines];
    return;
  }
  const at = new Map(c.lines.map((line, i) => [line.key, i]));
  for (const line of m.lines) {
    const i = at.get(line.key);
    if (i === undefined) c.lines.push(line);
    else c.lines[i] = line;
  }
  if (c.lines.length > COMPACT_LIMIT.maxLines) c.lines.splice(0, c.lines.length - COMPACT_LIMIT.maxLines);
}

onHost(HOST.compactLines, m => {
  const tab = state.tabs.get(m.id);
  if (!tab) return;
  const c = compactOf(tab);
  if (m.session !== c.session) return; // an answer for a session the view has left
  takeLines(c, m);
  render(tab);
});

// The agent started, changed session (a /clear, a resume), changed state or left: the view follows.
on(EVENTS.agent, apply);
on(EVENTS.terminalOpened, apply);
on(EVENTS.settings, () => {
  for (const tab of state.tabs.values()) {
    const c = tab.compact;
    if (c?.el) {
      sizeText(c.el);
      fitInput(/** @type {HTMLTextAreaElement} */ (find(c.el, INPUT)));
    }
  }
});
// Termilly saw the agent's program start or stop (a session restored at start: Codex reports nothing before its first
// prompt), so the view comes or goes with it.
on(EVENTS.tab, tab => {
  if (tab.view && isCompact(tab) !== tab.view.el.classList.contains(SHOWN_CLASS)) apply(tab);
});
on(EVENTS.tabClosed, tab => {
  tab.compact?.writes?.dispose();
  tab.compact?.resizes?.dispose();
  if (tab.compact?.session) send(PAGE.compactWatch, { id: tab.id, session: null });
});
