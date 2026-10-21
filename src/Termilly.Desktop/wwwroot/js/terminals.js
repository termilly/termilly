// @ts-check
// xterm.js terminals: one per tab, each bridged to a shell session on the host (keyed by tab id).

import { PAGE, HOST } from './protocol.js';
import { send, sendWithFiles, onHost, droppedPaths, platform, PLATFORM } from './host.js';
import {
  state, on, emit, wsById, activityChanged, agentChanged, COMMAND_DELAY, noteDir, persist, lastFolderOf, GROUPS, isSsh,
  isSshProfile, EVENTS,
} from './store.js';
import { inputTargets } from './broadcast.js';
import { promptStarted, inputStarted, commandStarted, commandEnded, commandReported } from './commands.js';
import { scanOutput, scanFrom, screenCleared } from './triggers.js';
import { quotePaths } from './quoting.js';
import { remoteReport, remoteHook, remotePrompt, watchRemote } from './remotehost.js';
import { modal } from './dialogs.js';
import { escapeHtml } from './ui.js';
import { pasteNeedsConfirm, confirmProduction } from './environments.js';
import { currentTheme, themeId, themeById, THEME_BASE } from './themes.js';
import { updateSettings } from './preferences.js';
import { resumeCommand, attachFor } from './resume.js';
import { noteRemotePrompt, noteRemoteCwd, leftRemote } from './remotecwd.js';
import { AGENT_STATE, AGENT_SOURCE } from './constants.js';
import { find, field } from './dom.js';
import { continuesOnNextRow } from './buffer.js';
import { clipboardKey, wireClipboard, PASTE_LABEL } from './termclipboard.js';

/**
 * A theme plugin's terminal colours (state.pluginThemes).
 * @typedef {import('./store.js').PluginTheme} PluginTheme
 */

/**
 * A terminal's scrollback as lines (bufferLines): `rows[i]` is the buffer row line i starts on.
 * @typedef {string[] & { rows?: number[] }} BufferLines
 */

/** Light or dark, from the theme on screen (themes.js). */
export const isLight = () => currentTheme().base === THEME_BASE.light;
/**
 * The terminal colours: a theme plugin's (Settings › Plugins) over the app theme's, or the app theme's.
 * @type {{ key: string | null, theme: any }}
 */
let pluginTheme = { key: null, theme: null };
const termTheme = () => {
  const chosen = state.settings.terminal.colors && state.pluginThemes.find(t => t.id === state.settings.terminal.colors);
  const key = chosen ? `${chosen.id}|${themeId()}` : null;
  document.documentElement.style.setProperty('--term-surface',
    (chosen || undefined)?.colors.background ?? '');
  if (!chosen) return currentTheme().terminal;
  if (pluginTheme.key !== key) {
    pluginTheme = {
      key,
      theme: { .../** @type {import('./themes.js').Theme} */ (themeById(chosen.light ? THEME_BASE.light : THEME_BASE.dark)).terminal, ...chosen.colors },
    };
  }
  return pluginTheme.theme;
};

/**
 * Monospace fonts with a real bold face (from the host; null until it has looked). In a font without one,
 * bold would be faked by smearing the regular glyphs, which looks blurry, so bold text keeps normal weight and
 * stands out by xterm's brighter bold colours instead (as Windows Terminal's "bright" intense text does).
 */
/** @type {Set<string> | null} */
let realBoldFonts = null;
/** @param {string} family */
const boldWeight = family => (!realBoldFonts || realBoldFonts.has(family) ? 'bold' : 'normal');

onHost(HOST.fonts, m => {
  realBoldFonts = new Set(m.boldFonts ?? []);
  applyTerminalSettings();
});

/** Terminal options that come from Settings. */
const settingsOptions = () => ({
  fontFamily: fontStack(state.settings.terminal.fontFamily),
  fontWeightBold: boldWeight(state.settings.terminal.fontFamily),
  fontSize: state.settings.terminal.fontSize,
  lineHeight: state.settings.terminal.lineHeight,
  cursorBlink: state.settings.terminal.cursorBlink,
  cursorStyle: state.settings.terminal.cursorStyle,
  scrollback: state.settings.terminal.scrollback,
  theme: termTheme(),
});

/**
 * The chosen family first, then fallbacks so a missing font still gives a monospace terminal.
 * @param {string} family
 */
const fontStack = family => `"${family}", Consolas, "Cascadia Mono", "DejaVu Sans Mono", monospace`;

/**
 * How long a start command waits for a shell that marks no prompt (local shells only), and how long after the
 * shell marks where input starts (PowerShell) or where its prompt starts (bash, which marks no input).
 */
const WITHOUT_MARKS_MS = 5000;
const AT_INPUT_MS = 50;
const AT_PROMPT_MS = 400;

/**
 * A terminal's shell as terminals.js follows it (tab.shell): when someone last typed, and its two timers.
 * @typedef {{ typedAt: number, promptTimer: number, commandTimer: number }} ShellTimers
 */

/**
 * A terminal's shell as this module follows it, kept here: when someone last typed into it, and the timers that wait
 * for its prompt (a start command) and for a marked command to have run long enough to show as running.
 * @param {Tab} tab
 */
const shellOf = tab => (tab.shell ??= { typedAt: 0, promptTimer: 0, commandTimer: 0 });

/** A bell this soon after typing is the shell answering a key (Tab with nothing to complete), not news. */
const TYPING_BELL_MS = 1500;

/** Erase in Display (CSI J) of the whole screen, and of the scrollback too. */
const ERASE_ALL = 2;
const ERASE_SCROLLBACK = 3;

/** xterm answering the pseudo console: cursor position, device attributes, focus in or out. */
const TERMINAL_REPLY = /^\x1b\[(\d+;\d+R|\?[\d;]*c|>[\d;]*c|[IO])$/;

/**
 * Whether `data` from xterm is its answer to the console (cursor position, attributes, focus), not the user typing.
 * @param {string} data
 */
export const isTerminalReply = data => TERMINAL_REPLY.test(data);

/** @type {(e: KeyboardEvent) => boolean} */
let keyHandler = () => true;

/**
 * Keys a feature takes before the shell sees them (`snippet:` at a prompt, snippetprompt.js); false keeps a key.
 * @type {(tab: Tab, term: any, e: KeyboardEvent) => boolean}
 */
let inputHook = () => true;
/** @param {(tab: Tab, term: any, e: KeyboardEvent) => boolean} fn */
export const setInputHook = fn => { inputHook = fn; };

/**
 * Where typing in a terminal without its own shell goes (a tmux pane: tmux.js).
 * @type {(tab: Tab, data: string) => void}
 */
let virtualInput = () => {};
/** @param {(tab: Tab, data: string) => void} fn */
export const setVirtualInput = fn => { virtualInput = fn; };

/**
 * xterm's key hook for app shortcuts (returns false to keep a key from the shell).
 * @param {(e: KeyboardEvent) => boolean} fn
 */
export function setKeyHandler(fn) {
  keyHandler = fn;
}

/** The escape sequences (OSC numbers) a terminal handles itself. */
const OSC = Object.freeze({
  /** The shell's working folder: file://host/path. */
  cwd: 7,
  /** A program copying to the clipboard: selection;base64. */
  clipboard: 52,
  /** Notifications: kitty's (metadata;payload). */
  kittyNotify: 99,
  /** Shell integration marks: A prompt, B input, C command runs, D it ended. */
  shellMark: 133,
  /** VS Code's shell integration (E: the command line) and Termilly's on a server (P;Termilly…). */
  shellReport: 633,
  /** Progress (4;state;percent) and ConEmu's notifications and commands. */
  conEmu: 9,
  /** Notifications: notify;title;body (urxvt, foot, ghostty). */
  notify: 777,
  /** iTerm2's: images, and Claude Code's hooks on a server (TermillyHook=). */
  iterm: 1337,
});

/** How much image data a terminal keeps for its inline images, in MB. */
const IMAGE_STORAGE_MB = 64;
/** A restored terminal scrolls back this share of its height, once the new shell has cleared its screen. */
const RESTORED_SCROLL = 0.6;
const RESTORED_SCROLL_AFTER_MS = 1500;

/** The width of a terminal's overview ruler (the marks beside its scrollbar). */
const RULER_WIDTH_PX = 8;
/** What an OSC 777 notification starts with (notify;title;body); other OSC 777 kinds are left alone. */
const OSC_777_NOTIFY = 'notify';
/** How long output is ignored after a shell starts (its start-up), and by default. */
const STARTING_QUIET_MS = 2500;
const QUIET_MS = 1200;
/** How long after it starts a shell that has marked nothing yet counts as still starting. */
const SHELL_STARTING_MS = 15_000;
/** How long output has to settle on what looks like a prompt before an SSH terminal's command is typed. */
const PROMPT_SETTLE_MS = 700;
/** How much of a program's notification an alert keeps, in characters. */
const MAX_ALERT_CHARS = 200;
/** A terminal a file is dragged over (app.css). */
const FILE_OVER = 'file-over';
/** How lines pasted at a prompt go, once confirmed: joined into one line, or all of them as they are. */
const PASTE = Object.freeze({ oneLine: 'one', all: 'all' });
/** The lines of a multi-line paste the question shows. */
const PASTE_PREVIEW_LINES = 8;

/**
 * Opens the tab's terminal (its view must be in the DOM so xterm can measure it) and starts its shell.
 * @param {Tab} tab
 */
export function openTerminal(tab) {
  const term = createTerminal(tab);
  emit(EVENTS.terminalOpened, tab); // the change preview adds its Ctrl+click links (js/changes.js)
  wireInput(tab, term);
  wireNotifications(tab, term);
  wireShellReports(tab, term);
  wireProgramRequests(tab, term);
  wireOutputWatch(tab, term);

  const view = tab.start?.output ? writeRestoredOutput(tab) : null;
  scanFrom(tab, term.buffer.normal.baseY + term.buffer.normal.cursorY); // old output isn't news for triggers
  startShell(tab);
  // The new shell clears its screen on start; once it has, scroll to where the terminal was.
  if (view) setTimeout(() => view.then(top => scrollRestored(term, top)), RESTORED_SCROLL_AFTER_MS);
}

/**
 * Scrolls a restored terminal: to the buffer row that was at the top of its view, to the bottom (the new prompt)
 * when it was at the bottom, or, when that isn't known (a closed terminal reopened), up so the restored output
 * shows above the new prompt. Typing snaps back to the prompt.
 * @param {any} term xterm
 * @param {number | null | undefined} top
 */
function scrollRestored(term, top) {
  if (top === undefined) term.scrollLines(-Math.floor(term.rows * RESTORED_SCROLL));
  else if (top === null) term.scrollToBottom();
  else term.scrollToLine(top);
}

/**
 * xterm in the tab's pane, with its add-ons, fitted to the pane.
 * @param {Tab} tab A tab with its view (createView).
 */
function createTerminal(tab) {
  // The overview ruler draws prompt marks (green / red by exit code) along the scrollbar; see commands.js.
  // Decorations (the marks) are a "proposed" xterm API, which has to be allowed.
  // reflowCursorLine: the line the cursor is on (usually the prompt) rewraps too when the pane gets wider or
  // narrower. xterm leaves it alone by default, for shells that redraw their prompt; PowerShell and cmd under the
  // pseudo console don't, so a prompt wrapped in a narrow pane stayed broken after it got wider.
  const term = new Terminal({ ...settingsOptions(), scrollback: scrollbackFor(tab), cursorWidth: 2, overviewRuler: { width: RULER_WIDTH_PX }, allowProposedApi: true, linkHandler: linkHandler(tab), reflowCursorLine: true });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(/** @type {TabView} */ (tab.view).body);
  fit.fit();
  // Sixel and iTerm2 inline images (the pseudo console passes both through).
  if (state.settings.terminal.inlineImages !== false) term.loadAddon(new ImageAddon.ImageAddon({ storageLimit: IMAGE_STORAGE_MB }));
  // Unicode 11 widths: emoji (🚀, ❤️) take two cells, as the programs that print them expect; xterm's default
  // (Unicode 6) gives them one, which shifts TUI borders and columns.
  term.loadAddon(new Unicode11Addon.Unicode11Addon());
  term.unicode.activeVersion = '11';
  wireDropAndPaste(tab, term);
  /** @type {TabView} */ (tab.view).term = term;
  /** @type {TabView} */ (tab.view).fit = fit;
  // No scrollbar while everything fits on screen (a new terminal): xterm would show a full-height slider.
  const noteScrollable = () =>
    /** @type {TabView} */ (tab.view).body.classList.toggle('scrollable', term.buffer.active.length > term.rows);
  term.onWriteParsed(noteScrollable);
  term.onResize(noteScrollable);
  term.buffer.onBufferChange(noteScrollable);
  noteScrollable();
  return term;
}

/**
 * Typing (to the shell, a tmux pane, or every terminal in a broadcast), resizing and the app's shortcuts.
 * @param {Tab} tab
 * @param {any} term xterm
 */
function wireInput(tab, term) {
  term.onData((/** @type {string} */ data) => {
    if (tab.virtual) {
      virtualInput(tab, data);
      return;
    }
    if (tab.exited) {
      if (tab.reconnect) return; // waiting to reconnect (reconnect.js): its bar has the buttons
      restartShell(tab);
      return;
    }
    // Broadcasting (broadcast.js) sends it to every terminal in the broadcast; otherwise just here.
    // xterm's answers to the console's queries go to this terminal only, and aren't the user typing.
    if (isTerminalReply(data)) {
      send(PAGE.input, { id: tab.id, data });
      return;
    }
    for (const target of inputTargets(tab)) {
      if (target.exited) continue;
      send(PAGE.input, { id: target.id, data });
      shellOf(target).typedAt = Date.now();
      agentInput(target, data);
    }
  });
  term.onResize((/** @type {{ cols: number, rows: number }} */ { cols, rows }) => {
    // ConPTY repaints after a resize; that output isn't news, so it mustn't raise an attention dot.
    quiet(tab);
    send(PAGE.resize, { id: tab.id, cols, rows });
  });
  term.attachCustomKeyEventHandler((/** @type {KeyboardEvent} */ e) => inputHook(tab, term, e) && clipboardKey(term, e) && keyHandler(e));
}

/**
 * What programs say to the user: progress, notifications and the bell.
 * @param {Tab} tab
 * @param {any} term xterm
 */
function wireNotifications(tab, term) {
  // OSC 9;4;state;percent: progress an app reports (Claude Code, winget, PowerShell progress bars), the sequence
  // Windows Terminal draws its tab spinner from. OSC 9;<text> is a notification (ConEmu's, which Codex sends);
  // OSC 9;1 to 9;12 are other ConEmu commands (9;9 is the working folder), left alone.
  term.parser.registerOscHandler(OSC.conEmu, (/** @type {string} */ data) => {
    const m = /^4;([0-4])(?:;(\d{1,3}))?/.exec(data);
    if (m) return progressReported(tab, Number(m[1]), Number(m[2] ?? 0));
    if (/^(1[0-2]|[1-9])(;|$)/.test(data)) return false;
    agentAlert(tab, data);
    return true;
  });
  // OSC 777;notify;title;body (urxvt, foot, ghostty) and OSC 99 (kitty: metadata;payload, base64 when e=1):
  // notifications, handled like OSC 9's. The bundled pseudo console passes both through.
  term.parser.registerOscHandler(OSC.notify, (/** @type {string} */ data) => {
    const [kind, title = '', body = ''] = data.split(';');
    if (kind !== OSC_777_NOTIFY) return false;
    agentAlert(tab, [title, body].filter(Boolean).join(': '));
    return true;
  });
  term.parser.registerOscHandler(OSC.kittyNotify, (/** @type {string} */ data) => {
    agentAlert(tab, kittyNotification(data));
    return true;
  });
  term.onBell(() => {
    // Shells ring for typing (Tab with nothing to complete, Backspace at the start), and someone looking at the
    // terminal hears it anyway: only a bell nobody caused or saw is news.
    if (Date.now() - (tab.shell?.typedAt ?? 0) < TYPING_BELL_MS) return;
    if (document.hasFocus() && tab.wsId === state.activeId && /** @type {TabView} */ (tab.view).el.classList.contains('focused')) return;
    agentAlert(tab, '');
  });
}

const MAX_PERCENT = 100;

/**
 * A program reported its progress (OSC 9;4): state 0 clears it, 1 is a percentage, 2 an error, 3 working, 4 paused.
 * True: the sequence was handled.
 * @param {Tab} tab
 * @param {number} progressState
 * @param {number} percent
 */
function progressReported(tab, progressState, percent) {
  const before = tab.progress?.state ?? 0;
  tab.progress = progressState ? { state: progressState, percent: Math.min(MAX_PERCENT, percent) } : null;
  // Claude Code clears its progress whenever it stops working, including when a prompt is denied or a turn
  // interrupted, which no hook reports. Stop (done) may come just before or after this.
  if (!progressState && tab.agent?.state === AGENT_STATE.working) tab.agent.state = AGENT_STATE.idle;
  activityChanged(tab, before !== progressState);
  return true;
}

/**
 * What the shell (and Termilly's integration on a server) reports: prompts and commands, its folder, hooks.
 * @param {Tab} tab
 * @param {any} term xterm
 */
function wireShellReports(tab, term) {
  // OSC 133 shell integration marks (shell\termilly.ps1 for PowerShell, PS0 / PROMPT_COMMAND for bash): A a prompt
  // starts, B input starts, C the command runs, D it ended (with its exit code). Commands are only trusted once
  // the shell has shown it marks prompts too, so a lone C can't leave a spinner running forever.
  term.parser.registerOscHandler(OSC.shellMark, (/** @type {string} */ data) => {
    try {
      shellMark(tab, data);
    } catch (e) {
      console.error('shell mark', data, e); // a mark that fails must never stop the terminal's output
    }
    return true;
  });
  term.parser.registerOscHandler(OSC.cwd, (/** @type {string} */ data) => shellFolder(tab, data));
  // OSC 633;E;<command line>: what bash is about to run (its PS0 sends it, as it can't mark where the prompt ends).
  // OSC 633;P;Termilly…: a server's Termilly integration reporting over ssh (remotehost.js).
  term.parser.registerOscHandler(OSC.shellReport, (/** @type {string} */ data) => {
    if (data.startsWith('P;Termilly')) return remoteReport(tab, data);
    if (!data.startsWith('E;')) return false;
    commandReported(tab, data.slice(2));
    return true;
  });
  // OSC 1337;TermillyHook=…: Claude Code's hook on a server (remotehost.js). Other OSC 1337s (iTerm2 images) go on to
  // the image addon, which registered first and so is asked after this.
  term.parser.registerOscHandler(OSC.iterm, (/** @type {string} */ data) => remoteHook(tab, data));
}

/**
 * OSC 7 file://host/path: the shell's working folder (shell\termilly.ps1 sends it at each prompt, and bash's
 * PROMPT_COMMAND on Linux). Windows paths come as /C:/dir; local folders are remembered for the "Go to" picker.
 * @param {Tab} tab
 * @param {string} data
 */
function shellFolder(tab, data) {
  const m = /^file:\/\/[^/]*(\/.*)$/.exec(data);
  if (!m) return false;
  let path = m[1];
  try { path = decodeURIComponent(path); } catch { /* keep it as sent */ }
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1).replace(/\//g, '\\');
  if (tab.cwd !== path) persist(); // where it starts after a restart (store.js lastFolderOf)
  tab.cwd = path;
  const ssh = isSshProfile(state.profiles.find(p => p.id === tab.profile));
  if (platform === PLATFORM.linux) {
    if (ssh) noteRemoteCwd(tab, path); // a shell on the other end of ssh
    else noteDir(path);
  } else if (path.startsWith('/')) {
    noteRemoteCwd(tab, path); // a shell on the other end of ssh, or in WSL
  } else if (/^[A-Za-z]:\\/.test(path)) {
    leftRemote(tab); // back from ssh or wsl typed in this terminal
    noteDir(path); // a Linux path (WSL, ssh) can't start a Windows workspace
  }
  return true;
}

/**
 * What programs ask of the terminal: to copy to the clipboard, and which terminal this is.
 * @param {Tab} tab
 * @param {any} term xterm
 */
function wireProgramRequests(tab, term) {
  // OSC 52;selection;base64: a program copying to the clipboard (neovim, tmux, helix, over ssh too). Only writes
  // are honoured: a read ('?') would hand the clipboard to whatever runs in the terminal.
  term.parser.registerOscHandler(OSC.clipboard, (/** @type {string} */ data) => {
    const text = clipboardWrite(data);
    if (text !== null && state.settings.terminal.programClipboard !== false) navigator.clipboard.writeText(text).catch(() => {});
    return true;
  });
  // XTVERSION (CSI > 0 q): which terminal this is, so programs can use what it supports.
  term.parser.registerCsiHandler({ prefix: '>', final: 'q' }, (/** @type {number[]} */ params) => {
    if (params.length > 1 || (params[0] ?? 0) !== 0) return false;
    send(PAGE.input, { id: tab.id, data: `\x1bP>|Termilly ${appVersion}\x1b\\` });
    return true;
  });
}

/**
 * Output as it's parsed: triggers and alerts, an SSH prompt's folder, a cleared screen, full-screen apps.
 * @param {Tab} tab
 * @param {any} term xterm
 */
function wireOutputWatch(tab, term) {
  // Full-screen apps (vim, less) wait for the user, so a command running in one isn't shown as busy.
  term.buffer.onBufferChange(() => { if (tab.command) activityChanged(tab, true); });
  // Triggers and alerts (triggers.js) look at each line the output completes. A cleared screen (cls: CSI 2J or 3J)
  // starts over at its top, since everything below it is new.
  term.onWriteParsed(() => {
    scanOutput(tab);
    // An SSH terminal's prompt shows its folder; the SFTP panel follows it.
    if (isSshProfile(state.profiles.find(p => p.id === tab.profile))) {
      const buffer = term.buffer.active;
      const line = buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) ?? '';
      noteRemotePrompt(tab, line);
      if (tab.start?.command) waitForPrompt(tab);
    }
  });
  term.parser.registerCsiHandler({ final: 'J' }, (/** @type {number[]} */ params) => {
    if (params[0] === ERASE_ALL || params[0] === ERASE_SCROLLBACK) screenCleared(tab);
    return false;
  });
}

/** @param {Tab} tab */
export function startShell(tab) {
  if (tab.virtual) return; // a tmux pane: tmux runs its shell (tmux.js)
  const { term } = /** @type {TabView} */ (tab.view);
  quiet(tab, STARTING_QUIET_MS);
  tab.startedAt = Date.now();
  const ssh = isSsh(tab);
  // Where it was last (a restart, or the shell started again), else where it was opened. The host falls back to the
  // second when the first is gone, and says so (start:folder).
  const opened = tab.startCwd ?? wsById(tab.wsId)?.cwd ?? null;
  const last = ssh ? null : localFolder(lastFolderOf(tab));
  send(PAGE.start, { id: tab.id, profile: tab.profile, cwd: last ?? opened, fallbackCwd: last ? opened : null, env: tab.env ?? null, cols: term.cols, rows: term.rows });
  watchRemote(tab); // an SSH or WSL terminal: is Termilly set up on the host or distribution?
  // An SSH terminal brought back after a restart goes back to the folder it was in, once its shell shows a prompt.
  // A Claude Code session to resume (snapshot.js) runs after that, in the same folder.
  const start = startOf(tab);
  if (ssh && tab.restored && !start.done) {
    const back = resumeCommand(lastFolderOf(tab), attachFor(tab));
    if (back) start.command = start.command ? `${back}; ${start.command}` : back;
  }
  start.done = true;
  // A layout's start command is typed at the first prompt (shellMark sees it), or after a while without marks. Over
  // ssh only at a prompt (waitForPrompt): before it there may be a password prompt, or nothing at all.
  if (start.command && !ssh) setTimeout(() => runPendingCommand(tab), WITHOUT_MARKS_MS);
}

// The host noticed a terminal start or stop running a command (a child process of its shell).
onHost(HOST.busy, m => {
  const tab = state.tabs.get(m.id);
  if (!tab) return;
  const before = tab.busy ?? null;
  const interactiveBefore = tab.interactive ?? null;
  tab.busy = m.busy ? m.name : null;
  tab.interactive = m.interactive ? m.name : null;
  if (tab.busy !== before || tab.interactive !== interactiveBefore) activityChanged(tab, !before !== !tab.busy || !interactiveBefore !== !tab.interactive);
});

// The folder a terminal was to start in is gone (deleted or renamed outside Termilly): it started in the next one.
onHost(HOST.startFolder, m => {
  const tab = state.tabs.get(m.id);
  if (!tab?.view?.term) return;
  tab.lastCwd = null;
  if (tab.cwd === m.missing) tab.cwd = null;
  const clean = (/** @type {unknown} */ s) => String(s ?? '').replace(/[\x00-\x1f]/g, '');
  tab.view.term.write(`\x1b[90m[${clean(m.missing)} isn't there any more, so this terminal started in ${clean(m.folder)}]\x1b[0m\r\n`);
});

// ---- Starting: what a terminal brings back, and types once its shell is up ----

/**
 * What a terminal does as its shell starts (tab.start); see startOf.
 * @typedef {{ output: { lines: string[], closedAt: number, resurrected?: boolean, scroll?: number | null } | null,
 *   command: string | null, resumeSession: string | null, done: boolean }} ShellStart
 */

/**
 * What a terminal does as its shell starts, kept here: the saved output shown above it (after a restart, or a closed
 * terminal reopened: { lines, closedAt, resurrected }), the command typed at its first prompt (a layout's, a Claude
 * Code session to resume, the folder to go back to), the session that command resumes, and whether the start has
 * run.
 * @param {Tab} tab
 */
const startOf = tab => (tab.start ??= { output: null, command: null, resumeSession: null, done: false });

/**
 * Sets what a terminal does as its shell starts (any of output, command, resumeSession): from a layout, the API, a
 * reopened terminal, a restart (snapshot.js) or a reconnect.
 * @param {Tab} tab
 * @param {{ output?: any, command?: string | null, resumeSession?: string | null }} fields
 */
export function prepareStart(tab, fields) {
  Object.assign(startOf(tab), Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)));
}

/**
 * A shell the background host kept running came back as it was: nothing is shown above it or typed into it.
 * @param {Tab} tab
 */
export function keptRunning(tab) {
  Object.assign(startOf(tab), { output: null, command: null, resumeSession: null, done: true });
}

/**
 * Adds a command to type at the first prompt, after one already waiting.
 * @param {Tab} tab
 * @param {string} command
 */
function queueCommand(tab, command) {
  const start = startOf(tab);
  start.command = start.command ? `${start.command}; ${command}` : command;
}

/**
 * Types a command into a terminal's shell: now when it's had time to show its prompt, else once it does (as a
 * start command waits, see startShell), so a terminal that's just starting (or still connecting) doesn't get it
 * typed into a login or password prompt.
 * @param {Tab} tab
 * @param {string} command
 */
export function typeAtPrompt(tab, command) {
  const starting = !tab.shellMarks && !tab.remoteCwd && Date.now() - (tab.startedAt ?? 0) < SHELL_STARTING_MS;
  if (!tab.start?.command && !starting) {
    send(PAGE.input, { id: tab.id, data: `${command}\r` });
    return;
  }
  queueCommand(tab, command);
  if (!isSsh(tab)) setTimeout(() => runPendingCommand(tab), WITHOUT_MARKS_MS);
}

/**
 * A folder on this PC a shell can start in (the others are on a server or in WSL), or null.
 * @param {string | null | undefined} folder
 */
function localFolder(folder) {
  if (!folder) return null;
  return platform === PLATFORM.linux ? (folder.startsWith('/') ? folder : null) : (/^[A-Za-z]:\\|^\\\\/.test(folder) ? folder : null);
}

/** What waits on a password, a host key question or a passphrase rather than a command. */
const NOT_A_PROMPT = /pass(word|phrase)|yes\/no|verification code|otp|login:|\(y\/n\)/i;

/**
 * An SSH terminal's command waiting for its shell (after a restart or a reconnect): typed once output settles on
 * what looks like a prompt (ends in $, #, % or >), never into a password or host-key question. A shell with Termilly's
 * integration marks its prompt instead (shellMark).
 * @param {Tab} tab
 */
function waitForPrompt(tab) {
  const shell = shellOf(tab);
  clearTimeout(shell.promptTimer);
  shell.promptTimer = setTimeout(() => {
    const term = tab.view?.term;
    if (!term || !tab.start?.command || tab.exited || term.buffer.active.type === 'alternate') return;
    const buffer = term.buffer.active;
    const line = (buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) ?? '').trimEnd();
    if (/[$#%>]$/.test(line) && !NOT_A_PROMPT.test(line)) runPendingCommand(tab);
  }, PROMPT_SETTLE_MS);
}

/** @param {Tab} tab */
export function restartShell(tab) {
  tab.exited = false;
  clearActivity(tab);
  /** @type {TabView} */ (tab.view).term.reset();
  startShell(tab);
}

/**
 * Forgets a terminal's progress, running command and agent (its process ended or is starting over).
 * @param {Tab} tab
 */
export function clearActivity(tab) {
  tab.shellMarks = false;
  tab.interactive = null;
  if (!tab.progress && !tab.busy && !tab.agent && !tab.command) return;
  tab.progress = null;
  tab.busy = null;
  tab.agent = null;
  endCommand(tab);
  activityChanged(tab, true);
}

/**
 * The shell is back at its prompt: the command it marked has ended.
 * @param {Tab} tab
 */
function endCommand(tab) {
  clearTimeout(tab.shell?.commandTimer);
  if (!tab.command) return;
  tab.command = null;
  activityChanged(tab, true);
}

/**
 * Something in the terminal asked for attention: a notification sequence or a bell. For agents without hooks
 * (Codex, Gemini CLI, any script) that's the only sign they're waiting. Where hooks report, they already said more,
 * so these are ignored there.
 * @param {Tab} tab
 * @param {string} message
 */
export function agentAlert(tab, message) {
  if (tab.agent?.source === AGENT_SOURCE.hooks) return;
  const text = String(message).replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, MAX_ALERT_CHARS);
  tab.agent = { ...tab.agent, state: AGENT_STATE.attention, source: tab.agent?.source ?? AGENT_SOURCE.alert, message: text || null, at: Date.now() };
  agentChanged(tab);
}

/** Termilly's version, for XTVERSION replies (from the host's settings message). */
let appVersion = '1.0.0';
onHost(HOST.settings, m => { if (m.about?.version) appVersion = m.about.version; });

/**
 * The text of an OSC 99 notification (kitty's: `key=value:…;payload`, base64 when e=1).
 * @param {string} data
 */
function kittyNotification(data) {
  const split = data.indexOf(';');
  const meta = split < 0 ? '' : data.slice(0, split);
  const payload = split < 0 ? data : data.slice(split + 1);
  if (!/(^|:)e=1(:|$)/.test(meta)) return payload;
  try { return new TextDecoder().decode(Uint8Array.from(atob(payload), c => c.charCodeAt(0))); } catch { return ''; }
}

/** Most an OSC 52 copy may carry (base64 characters, about 750 KB of text): more is ignored. */
const CLIPBOARD_LIMIT = 1 << 20;

/**
 * The text an OSC 52 sequence (`selection;base64`) copies, or null for a read, a clear or something too large.
 * @param {string} data
 */
function clipboardWrite(data) {
  const split = data.indexOf(';');
  const encoded = split < 0 ? '' : data.slice(split + 1);
  if (!encoded || encoded === '?' || encoded.length > CLIPBOARD_LIMIT) return null;
  try { return new TextDecoder().decode(Uint8Array.from(atob(encoded), c => c.charCodeAt(0))); } catch { return null; }
}

/**
 * OSC 8 hyperlinks (ls --hyperlink, gcc, rg, delta): Ctrl+click opens them in the default browser, or file:// links
 * in Explorer, as the terminal's other links do; hovering shows where they go. Without this, xterm would ask with
 * a confirm() and open a bare WebView2 popup.
 * @param {Tab} tab
 */
function linkHandler(tab) {
  return {
    allowNonHttpProtocols: true,
    activate: (/** @type {MouseEvent} */ event, /** @type {string} */ uri) => {
      if (!event.ctrlKey) return;
      if (/^https?:\/\//i.test(uri)) send(PAGE.openUrl, { url: uri });
      else if (/^file:\/\//i.test(uri)) {
        let path = uri.replace(/^file:\/\/[^/]*/i, '');
        try { path = decodeURIComponent(path); } catch { /* keep it as sent */ }
        if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1).replace(/\//g, '\\');
        send(PAGE.openPath, { path });
      }
    },
    hover: (/** @type {MouseEvent} */ _event, /** @type {string} */ uri) => {
      /** @type {TabView} */ (tab.view).body.title = `${uri}\nCtrl+click to open`;
    },
    leave: () => { /** @type {TabView} */ (tab.view).body.removeAttribute('title'); },
  };
}

/** Keys that answer a permission prompt or question: Enter, Esc, or an option's number (not moving between options). */
const ANSWER = /^(\r|\x1b|[1-9])$/;

/**
 * What typing tells about an agent between its hooks. Answering a question or a permission prompt sends it back
 * to work (no hook reports that until the next tool; if the answer was "no", its progress report settles it).
 * Typing after "done" or an error means it's been seen.
 * @param {Tab} tab
 * @param {string} data
 */
function agentInput(tab, data) {
  const agent = tab.agent;
  if (!agent) return;
  const before = agent.state;
  if (before === AGENT_STATE.needsInput && ANSWER.test(data)) agent.state = AGENT_STATE.working;
  else if (before === AGENT_STATE.done || before === AGENT_STATE.error || before === AGENT_STATE.attention) agent.state = AGENT_STATE.idle;
  if (agent.state !== before) agentChanged(tab);
}

/**
 * Types a layout's start command (or a resumed agent, or the folder to go back to) once, at the shell's first prompt.
 * @param {Tab} tab
 */
function runPendingCommand(tab) {
  const start = startOf(tab);
  const { command } = start;
  if (!command || tab.exited) return;
  start.command = null;
  start.resumeSession = null; // typed: from here on the agent's hooks report its session
  send(PAGE.input, { id: tab.id, data: `${command}\r` });
}

/**
 * Handles one OSC 133 mark (see the handler in openTerminal).
 * @param {Tab} tab
 * @param {string} data
 */
function shellMark(tab, data) {
  const mark = data[0];
  // PowerShell marks where input starts (B); bash doesn't, so its prompt start (A) has to do.
  if (mark === 'B' && tab.start?.command) setTimeout(() => runPendingCommand(tab), AT_INPUT_MS);
  if (mark === 'A' && tab.start?.command) setTimeout(() => runPendingCommand(tab), AT_PROMPT_MS);
  if (mark === 'A' || mark === 'D') {
    tab.shellMarks = true;
    if (mark === 'D') {
      const code = data.split(';')[1];
      commandEnded(tab, code === undefined || code === '' ? null : Number(code));
    } else {
      if (tab.running) commandEnded(tab, null); // a prompt without an end mark: the command ended unreported
      promptStarted(tab);
      remotePrompt(tab);
    }
    endCommand(tab);
  } else if (mark === 'B') {
    inputStarted(tab);
  } else if (mark === 'C' && tab.shellMarks) {
    tab.command = { startedAt: Date.now() };
    commandStarted(tab);
    const shell = shellOf(tab);
    clearTimeout(shell.commandTimer);
    shell.commandTimer = setTimeout(() => activityChanged(tab, true), COMMAND_DELAY);
  }
}

// ---- Dropping files, pasting several lines ----

/**
 * Files dropped on a terminal are typed as their paths, quoted the way its shell reads them. The page only gets
 * file names, so the files go to the host, which knows their paths (files:dropped).
 * @param {Tab} tab
 * @param {any} term xterm
 */
function wireDropAndPaste(tab, term) {
  const { body } = /** @type {TabView} */ (tab.view);
  body.addEventListener('dragover', e => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    body.classList.add(FILE_OVER);
  });
  body.addEventListener('dragleave', () => body.classList.remove(FILE_OVER));
  body.addEventListener('drop', e => {
    body.classList.remove(FILE_OVER);
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    e.stopPropagation();
    if (window.chrome?.webview) {
      sendWithFiles(PAGE.filesDrop, { id: tab.id }, e.dataTransfer.files);
    } else {
      const paths = droppedPaths(e.dataTransfer);
      if (paths.length) send(PAGE.filesDrop, { id: tab.id, paths });
    }
  });
  body.addEventListener('paste', e => {
    if (!checkPaste(tab, e.clipboardData?.getData('text/plain') ?? '')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
  // The right-click menu's Paste has no paste event: the same checks, then xterm types it.
  wireClipboard(term, body, text => { if (!checkPaste(tab, text)) term.paste(text); });
}

/**
 * Asks before a paste that needs it, and pastes once confirmed. Returns true when it asked (the paste waits for the
 * answer), false when the text can be pasted straight away.
 * @param {Tab} tab
 * @param {string} text
 */
function checkPaste(tab, text) {
  // On production, ask first (Settings › Terminal › Production); that question covers the multi-line one too.
  if (text && pasteNeedsConfirm(tab, text)) {
    confirmProduction([tab], PASTE_LABEL, text).then(ok => {
      if (ok) /** @type {TabView} */ (tab.view).term.paste(text);
      /** @type {TabView} */ (tab.view).term.focus();
    });
    return true;
  }
  // Several lines pasted at a prompt run one after another: check first (Settings › Terminal).
  if (!state.settings.safety.pasteWarning || !/\r?\n./.test(text.trimEnd()) || (state.settings.safety.pasteWarningOff ?? []).includes(tab.profile)) return false;
  confirmPaste(tab, text);
  return true;
}

onHost(HOST.filesDropped, async m => {
  const tab = state.tabs.get(m.id);
  if (!tab || !m.paths?.length || tab.exited) return;
  const shell = state.profiles.find(p => p.id === tab.profile)?.icon;
  const text = `${quotePaths(m.paths, shell)} `;
  if (!(await confirmProduction([tab], 'Drop files', text))) return;
  send(PAGE.input, { id: tab.id, data: text });
  /** @type {TabView} */ (tab.view).term.focus();
});

/**
 * @param {Tab} tab
 * @param {string} text
 */
function confirmPaste(tab, text) {
  const lines = text.trimEnd().split(/\r?\n/);
  const profile = state.profiles.find(p => p.id === tab.profile);
  modal('paste-check', `
    <h3>Paste ${lines.length} lines?</h3>
    <p class="dialog-sub">Each line runs as a command when it reaches the prompt.</p>
    <pre class="paste-preview">${escapeHtml(lines.slice(0, PASTE_PREVIEW_LINES).join('\n'))}${lines.length > PASTE_PREVIEW_LINES ? `\n… ${lines.length - PASTE_PREVIEW_LINES} more` : ''}</pre>
    <label class="paste-never"><input type="checkbox" data-never> Don’t ask again for ${escapeHtml(profile?.name ?? 'this shell')}</label>
    <div class="dialog-actions">
      <button class="btn" data-cancel>Cancel</button>
      <button class="btn" data-one>Paste as one line</button>
      <button class="btn primary" data-ok autofocus>Paste</button>
    </div>`, (dialog, close) => {
    /** @param {string} how */
    const done = how => {
      if (how && field(dialog, '[data-never]').checked) {
        updateSettings(GROUPS.safety, { pasteWarningOff: [...(state.settings.safety.pasteWarningOff ?? []), tab.profile] });
      }
      close(how);
    };
    find(dialog, '[data-one]').addEventListener('click', () => done(PASTE.oneLine));
    return { submit: () => done(PASTE.all) };
  }).then(how => {
    if (!how) return;
    /** @type {TabView} */ (tab.view).term.paste(how === PASTE.oneLine ? lines.map(l => l.trim()).filter(Boolean).join(' ') : text);
    /** @type {TabView} */ (tab.view).term.focus();
  });
}

/**
 * Ignores output for a while (shell start-up, resize repaints) when deciding what counts as new.
 * @param {Tab} tab
 * @param {number} [ms]
 */
export function quiet(tab, ms = QUIET_MS) {
  tab.quietUntil = Math.max(tab.quietUntil ?? 0, Date.now() + ms);
}

/** @param {Tab} tab */
export function disposeTerminal(tab) {
  send(PAGE.kill, { id: tab.id });
  tab.view?.term?.dispose();
}

/**
 * Shows a reopened session's saved output, dimmed, then scrolls it up out of the viewport so the new
 * shell starts on a clean screen with the old output in the scrollback above it. After a restart that's all: the
 * terminals coming back is what Termilly does, so nothing announces it. A closed terminal reopened says when it closed.
 * Resolves, once written, to the buffer row that was at the top of the view (null: it was at the bottom; undefined:
 * not known).
 * @param {Tab} tab
 * @returns {Promise<number | null | undefined>}
 */
function writeRestoredOutput(tab) {
  const { term } = /** @type {TabView} */ (tab.view);
  const start = startOf(tab);
  // Called only when there's output to bring back.
  const { lines, closedAt, resurrected, scroll } = /** @type {NonNullable<ShellStart['output']>} */ (start.output);
  /** @type {Promise<number | null | undefined>} */
  const top = new Promise(resolve => {
    term.write(`\x1b[2m${lines.join('\r\n')}\x1b[0m\r\n`, () => {
      resolve(typeof scroll === 'number' ? rowOfLine(term.buffer.normal, Math.max(0, lines.length - scroll)) : scroll);
    });
  });
  if (!resurrected) {
    const when = new Date(closedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    const color = `\x1b[${isLight() ? '38;2;109;92;240' : '38;2;139;123;255'}m`;
    term.write(`${color}── restored session · closed ${when} ──\x1b[0m\r\n`);
  }
  // Push it all up into the scrollback and start at the top of a blank screen, where the new pseudo console's
  // cursor is too: otherwise programs that place the cursor (PSReadLine) draw on the wrong row, or crash.
  term.write(`${'\r\n'.repeat(term.rows)}\x1b[H`);
  start.output = null;
  return top;
}

/**
 * The buffer row line `n` starts on (rows the terminal wrapped belong to the line before), counting from row 0.
 * @param {any} buffer xterm's buffer
 * @param {number} n
 */
function rowOfLine(buffer, n) {
  let line = -1;
  for (let y = 0; y < buffer.length; y++) {
    if (!buffer.getLine(y)?.isWrapped) line++;
    if (line === n) return y;
  }
  return buffer.length - 1;
}

/**
 * How far back the terminal is scrolled, for bringing it back after a restart: how many of `lines` (bufferLines),
 * counted from the end, the line at the top of the view is. Null when it's at the bottom.
 * @param {Tab} tab
 * @param {BufferLines} lines
 */
export function scrolledBack(tab, lines) {
  const buffer = tab.view?.term?.buffer.active;
  if (!buffer || buffer.viewportY >= buffer.baseY || !lines.rows?.length) return null;
  let i = lines.rows.length - 1;
  while (i > 0 && lines.rows[i] > buffer.viewportY) i--;
  return lines.length - i;
}

/**
 * The tab's scrollback and screen as plain text lines, without trailing blank lines. Rows the terminal wrapped
 * are joined back into one line, so a long command is searched (and redacted) whole. `lines.rows[i]` is the buffer
 * row line i starts on (it isn't saved with the lines).
 * @param {Tab} tab
 * @param {number} [max]
 * @returns {BufferLines}
 */
export function bufferLines(tab, max = state.settings.terminal.scrollback) {
  const term = tab.view?.term;
  const buffer = term?.buffer.active;
  if (!buffer) return [];
  const rows = [];
  const starts = [];
  let joinNext = false;
  for (let i = Math.max(0, buffer.length - max); i < buffer.length; i++) {
    // Untrimmed, so a space that fell at the wrap point survives the join.
    const text = buffer.getLine(i)?.translateToString(false) ?? '';
    if (joinNext && rows.length) rows[rows.length - 1] += text;
    else {
      rows.push(text);
      starts.push(i);
    }
    joinNext = continuesOnNextRow(buffer, i, term.cols);
  }
  const lines = rows.map(row => row.trimEnd());
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  /** @type {BufferLines} */ (lines).rows = starts.slice(0, lines.length);
  return lines;
}

// A theme plugin came or went: its terminal colours with it.
on(EVENTS.plugins, () => applyTerminalSettings());

/** Applies Settings (font, cursor, scrollback, theme) to every open terminal. */
export function applyTerminalSettings() {
  const options = settingsOptions();
  for (const tab of state.tabs.values()) {
    const term = tab.view?.term;
    if (!term) continue;
    for (const [key, value] of Object.entries({ ...options, scrollback: scrollbackFor(tab) })) {
      if (term.options[key] !== value) term.options[key] = value;
    }
  }
  scheduleFit();
}

/**
 * The scrollback a terminal keeps: the setting, or the smaller budget (Settings › Terminal) while its workspace is
 * out of sight. Lowering it drops the oldest lines, which don't come back when the workspace shows again.
 * @param {Tab} tab
 */
export function scrollbackFor(tab) {
  const budget = state.settings.session.hiddenScrollback;
  return budget && tab.wsId !== state.activeId ? Math.min(budget, state.settings.terminal.scrollback) : state.settings.terminal.scrollback;
}

// Switching workspaces changes which terminals are out of sight.
on(EVENTS.workspaces, () => {
  if (!state.settings.session.hiddenScrollback) return;
  for (const tab of state.tabs.values()) {
    const term = tab.view?.term;
    const lines = scrollbackFor(tab);
    if (term && term.options.scrollback !== lines) term.options.scrollback = lines;
  }
});

/** Called when Windows switches between light and dark app mode (matters for the "system" theme). */
export { onSystemThemeChange } from './themes.js';

let fitFrame = 0;

/** Refits every open terminal to its pane on the next frame (cheap; many calls in a frame fit once). */
export function scheduleFit() {
  cancelAnimationFrame(fitFrame);
  fitFrame = requestAnimationFrame(() => {
    for (const tab of state.tabs.values()) tab.view?.fit?.fit();
  });
}

window.addEventListener('resize', scheduleFit);
