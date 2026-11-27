// @ts-check
// The machine's Claude Code login, lent to a test with the real agents (#100) and taken back after. Claude Code refreshes
// an expired login by trading its refresh token for a new pair, and the old refresh token stops working: a test that
// refreshed its copy has the only login that still works, so it goes back to the machine, unless the machine's own is
// newer by then (Claude Code there refreshed it too).
import { copyFile, readFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** Where Claude Code keeps its login under a home folder (Linux; macOS keeps it in the keychain). @param {string} home */
export const loginFile = home => path.join(home, '.claude', '.credentials.json');

/** When a login's access expires, in ms since 1970, or 0 when it can't be read. @param {string} text */
export function expiresAt(text) {
  try {
    return Number(JSON.parse(text)?.claudeAiOauth?.expiresAt) || 0;
  } catch {
    return 0; // not a login
  }
}

/** Whether a test's login should replace the machine's: it's the newer one. @param {string} test @param {string} machine */
export const isNewer = (test, machine) => expiresAt(test) > expiresAt(machine);

/** Lends the machine's login to a test's home. @param {string} testHome */
export async function lendLogin(testHome) {
  const own = loginFile(homedir());
  if (existsSync(own)) await copyFile(own, loginFile(testHome));
}

/** Takes the login back from a test's home, if the test refreshed it. @param {string} testHome */
export async function takeLoginBack(testHome) {
  const lent = loginFile(testHome), own = loginFile(homedir());
  if (!existsSync(lent) || !existsSync(own)) return;
  const [test, machine] = await Promise.all([readFile(lent, 'utf8'), readFile(own, 'utf8')]);
  if (!isNewer(test, machine)) return;
  const part = `${own}.${process.pid}.part`;
  await copyFile(lent, part);
  await rename(part, own); // whole or not at all: Claude Code on the machine never reads half a login
}
