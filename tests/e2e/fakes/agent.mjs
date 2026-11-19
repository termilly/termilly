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
process.stdin.on('keypress', (text, key) => {
  log({ event: 'key', text: text ?? '', sequence: key.sequence, name: key.name ?? null });
  if ((script.prompt.picks ?? ['1', '2', '3']).includes(text)) finish('pick', text);
});
process.stdin.resume();
setTimeout(() => finish('timeout'), script.prompt.timeoutMs ?? 60000);
// Home and erase removes the shell's command and history, making the above-choice fallback deterministic.
process.stdout.write('\x1b[2J\x1b[H' + script.prompt.lines.join('\r\n') + '\r\n');
// A TUI may leave its cursor on a row of what it drew (Codex on its menu's pointer): that many rows up from the end.
if (script.prompt.cursorUp) process.stdout.write(`\x1b[${script.prompt.cursorUp}A`);
log({ event: 'ready', raw: !!process.stdin.isTTY });



