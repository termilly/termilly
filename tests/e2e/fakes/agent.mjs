// @ts-check
import { appendFileSync, readFileSync } from 'node:fs';
const [agent, ...args] = process.argv.slice(2);
if (process.env.E2E_AGENT_LOG) appendFileSync(process.env.E2E_AGENT_LOG, JSON.stringify({ agent, args, cwd: process.cwd() }) + '\n');
const scripts = process.env.E2E_AGENTS ? JSON.parse(readFileSync(process.env.E2E_AGENTS, 'utf8')) : {};
const script = scripts[agent] ?? {};
process.stdout.write(typeof script === 'string' ? script : script.stdout ?? `Fake ${agent} started\n`);
if (script.stderr) process.stderr.write(script.stderr);
process.exit(script.exitCode ?? 0);
