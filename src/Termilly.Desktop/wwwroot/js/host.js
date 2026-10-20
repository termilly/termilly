// @ts-check
// Bridge to the host: WebView2 messages on Windows (WPF), Photino's window.external on Linux (strings, so JSON).
// The messages and what they carry are in protocol.js (made from the host's records).

import { PAGE } from './protocol.js';

/** @typedef {import('./protocol.js').PageMessages} PageMessages */
/** @typedef {import('./protocol.js').HostMessages} HostMessages */

const webview = window.chrome?.webview;
/** @type {Map<string, Array<(message: any) => void>>} message type -> its handlers */
const handlers = new Map();
/** @type {Map<string, (message: any) => void>} request id -> what its answer resolves */
const pending = new Map();
let requests = 0;

/** The hosts a page runs in. */
export const PLATFORM = Object.freeze({ windows: 'windows', linux: 'linux' });
/** Which host this page runs in (the Linux build has no WebView2). */
export const platform = webview ? PLATFORM.windows : PLATFORM.linux;
document.documentElement.dataset.platform = platform;

/**
 * The paths of files dropped from a file manager, on Linux: the drop carries their file:// URLs (WebKitGTK's File
 * objects have no paths). On Windows the files themselves go to the host instead, which knows their paths.
 * @param {DataTransfer | null | undefined} dataTransfer
 */
export function droppedPaths(dataTransfer) {
  return (dataTransfer?.getData('text/uri-list') || '').split(/\r?\n/)
    .filter(u => u.startsWith('file://')).map(u => decodeURIComponent(new URL(u).pathname));
}

const linux = platform === PLATFORM.linux;

/** The systems' names as the page writes them (sys.name). */
export const SYSTEM_NAME = Object.freeze({ linux: 'Linux', windows: 'Windows' });

/** What the page says differently on each system: where secrets are kept, what unlocks history, path examples. */
export const sys = {
  name: linux ? SYSTEM_NAME.linux : SYSTEM_NAME.windows,
  credentials: linux ? 'the system keyring' : 'Windows Credential Manager',
  /** How saved workspaces and history unlock without asking. */
  unlocks: linux ? 'with a key file only your user can read' : 'with your Windows account',
  /** When the recovery code is needed. */
  lostKey: linux ? 'If that key file is ever lost' : 'If an administrator ever resets your Windows password',
  keyExample: linux ? '~/.ssh/id_ed25519' : 'C:\\Users\\you\\.ssh\\id_ed25519',
};

/** @param {any} message */
function dispatch(message) {
  // An answer to request(): its promise resolves (and the message still reaches its handlers, if any).
  const answer = message.requestId == null ? undefined : pending.get(message.requestId);
  if (answer) {
    pending.delete(message.requestId);
    answer(message);
  }
  for (const handler of handlers.get(message.type) ?? []) handler(message);
}

/**
 * Sends the host a message: one of PAGE, with what that message carries.
 * @template {keyof PageMessages} K
 * @param {K} type
 * @param {PageMessages[K]} [payload]
 */
export function send(type, payload) {
  const message = { ...payload, type };
  if (webview) webview.postMessage(message);
  else window.external.sendMessage(JSON.stringify(message));
}

/**
 * Sends a message with files the user dropped or picked, on Windows: WebView2 gives the host their paths (the
 * browser doesn't give them to the page). Linux has no such channel; there the page sends the paths it read itself.
 * @template {keyof PageMessages} K
 * @param {K} type
 * @param {PageMessages[K]} payload
 * @param {FileList | File[]} files
 */
export function sendWithFiles(type, payload, files) {
  webview?.postMessageWithAdditionalObjects({ ...payload, type }, files);
}

/**
 * Sends a message that the host answers (with the same requestId, whatever the answer's type): resolves with the
 * answer.
 * @template {keyof PageMessages} K
 * @param {K} type
 * @param {PageMessages[K]} [payload]
 * @returns {Promise<any>}
 */
export function request(type, payload) {
  const requestId = `r${++requests}`;
  return new Promise(resolve => {
    pending.set(requestId, resolve);
    send(type, /** @type {PageMessages[K]} */ ({ ...payload, requestId }));
  });
}

/**
 * Registers a handler for one of the host's messages (HOST).
 * @template {keyof HostMessages} K
 * @param {K} type
 * @param {(message: HostMessages[K]) => void} handler
 */
export function onHost(type, handler) {
  if (!handlers.has(type)) handlers.set(type, []);
  handlers.get(type)?.push(handler);
}

if (webview) webview.addEventListener('message', e => dispatch(e.data));
else window.external.receiveMessage(text => dispatch(JSON.parse(text)));

// Linux: errors in the page go to the host's log (stderr), as WebKitGTK has no remote DevTools.
if (!webview) {
  /** @param {unknown} message @param {unknown} where */
  const report = (message, where) => send(PAGE.pageError, { message: String(message), where: String(where ?? '') });
  window.addEventListener('error', e => report(e.message, `${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', e => report(e.reason?.stack ?? e.reason, 'promise'));
}
