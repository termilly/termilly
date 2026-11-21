// @ts-check
import { readFileSync, appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.E2E_GH_LOG) appendFileSync(process.env.E2E_GH_LOG, JSON.stringify(args) + '\n');
const scenario = JSON.parse(readFileSync(process.env.E2E_GH_SCENARIO, 'utf8'));
// Exact argv entries win; prefix entries allow tests to ignore generated flags and comment bodies.
const entries = Array.isArray(scenario) ? scenario : Object.entries(scenario).map(([match, response]) => ({ match, response }));
const entry = entries.find(e => Array.isArray(e.args) && JSON.stringify(e.args) === JSON.stringify(args))
  ?? entries.find(e => e.match === args.join(' '))
  ?? entries.find(e => e.prefix && (Array.isArray(e.prefix) ? e.prefix.every((arg, i) => args[i] === arg) : args.join(' ').startsWith(e.prefix + ' ') || args.join(' ') === e.prefix));
if (!entry) { console.error(`Fake gh: no scenario for ${JSON.stringify(args)}`); process.exit(1); }
const response = entry.response ?? entry;
const structured = response && typeof response === 'object' && ('stdout' in response || 'stderr' in response || 'exitCode' in response || 'json' in response);
const stdout = structured ? response.stdout ?? response.json : response;
if (stdout !== undefined) process.stdout.write(typeof stdout === 'string' ? stdout : JSON.stringify(stdout));
if (structured && response.stderr) process.stderr.write(response.stderr);
process.exit(structured ? response.exitCode ?? 0 : 0);
