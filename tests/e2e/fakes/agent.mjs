// @ts-check
import { appendFileSync, readFileSync } from 'node:fs';
import { emitKeypressEvents } from 'node:readline';
const [agent, ...args] = process.argv.slice(2);
if (process.env.E2E_AGENT_LOG) appendFileSync(process.env.E2E_AGENT_LOG, JSON.stringify({ agent, args, cwd: process.cwd() }) + '\n');
const scripts = process.env.E2E_AGENTS ? JSON.parse(readFileSync(process.env.E2E_AGENTS, 'utf8')) : {};
const script = scripts[agent] ?? {};
process.stdout.write(typeof script === 'string' ? script : script.stdout ?? `Fake ${agent} started\n`);
if (script.stderr) process.stderr.write(script.stderr);
if (!script.prompt) process.exit(script.exitCode ?? 0);

// A real PTY uses raw mode; pipes let fixture tests exercise the same key parser without a desktop.
const log = event => {
  if (process.env.E2E_AGENT_KEYS_LOG) appendFileSync(process.env.E2E_AGENT_KEYS_LOG, JSON.stringify({ agent, ...event }) + '\n');
};
const finish = (reason, pick = null) => {
  log({ event: 'exit', reason, pick });
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.exit(script.exitCode ?? 0);
};

emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
// An input line (Codex's "› "), when asked for: what's typed shows after it, and Enter takes it (logged) and empties it.
const mark = script.prompt.input;
let typed = '';
process.stdin.on('keypress', (text, key) => {
  log({ event: 'key', text: text ?? '', sequence: key.sequence, name: key.name ?? null });
  if ((script.prompt.picks ?? ['1', '2', '3']).includes(text)) finish('pick', text);
  if (!mark) return;
  if (key.name === 'return') {
    log({ event: 'prompt', text: typed });
    typed = '';
  } else if (text && !key.ctrl && !key.meta) typed += text;
  // As a TUI redraws its input line: a while after the key, not at once.
  setTimeout(() => process.stdout.write(`\r\x1b[2K${mark}${typed}`), script.prompt.echoMs ?? 0);
});
process.stdin.resume();
setTimeout(() => finish('timeout'), script.prompt.timeoutMs ?? 60000);
// Home and erase removes the shell's command and history, making the above-choice fallback deterministic.
process.stdout.write('\x1b[2J\x1b[H' + script.prompt.lines.join('\r\n') + '\r\n' + (mark ?? ''));
log({ event: 'ready', raw: !!process.stdin.isTTY });



