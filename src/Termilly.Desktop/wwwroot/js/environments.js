// @ts-check
// Production safety: which terminals are on production (or staging), how they look, and asking before input
// reaches them. A terminal is on an environment when it's tagged with it, its profile is (SSH hosts named like
// production start tagged prod), its SSH host matches the environment's patterns (Settings › Terminal), or a
// command running in it is `ssh` to such a host. Broadcast, paste, dropped files, snippets and API typing ask first.

import { state, profileOf, tabTitle, isSshProfile } from './store.js';
import { modal } from './dialogs.js';
import { escapeHtml } from './ui.js';
import { SETTING_VALUES } from './constants.js';

/** Marks a tag among a terminal's hosts (`tag:prod`): an SSH alias's profile tags. */
const TAG_MARK = 'tag:';

/** The choices of the settings used here (C#'s SettingValues). */
const { prodPaste } = SETTING_VALUES;

/**
 * The environments when Settings has none: production in red, staging in amber.
 * @type {EnvironmentSetting[]}
 */
export const DEFAULT_ENVIRONMENTS = [
  { id: 'prod', label: 'PROD', color: '#ff5c5c', patterns: ['*-prod*', 'prod-*', 'prod.*', '*.prod.*', '*production*'] },
  { id: 'staging', label: 'STAGING', color: '#f2a33a', patterns: ['*staging*', '*-stg*', 'stg-*'] },
];

export const environments = () => (state.settings.safety.environments?.length ? state.settings.safety.environments : DEFAULT_ENVIRONMENTS);

/**
 * A glob (`*-prod*`, `10.20.*`) as a case-insensitive regular expression for a whole host name.
 * @param {string} pattern
 */
const globRegex = pattern => new RegExp(`^${pattern.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');

/**
 * Whether a host name (or user@host, or an alias) matches any of the patterns.
 * @param {string | null | undefined} host
 * @param {string[] | null | undefined} patterns
 */
export function hostMatches(host, patterns) {
  if (!host) return false;
  const bare = host.replace(/^[^@]*@/, '').replace(/:\d+$/, '');
  return (patterns ?? []).some(p => p.trim() && (globRegex(p.trim()).test(bare) || globRegex(p.trim()).test(host)));
}

/**
 * The host an `ssh` command line goes to: its first argument that isn't an option or an option's value.
 * `ssh -p 2222 -i key deploy@db-prod-1 uptime` → deploy@db-prod-1.
 * @param {string | null | undefined} command
 */
export function sshTarget(command) {
  const words = String(command ?? '').trim().split(/\s+/);
  if (!/^(ssh|ssh\.exe|mosh|autossh)$/i.test(words[0]?.split(/[\\/]/).pop() ?? '')) return null;
  const takesValue = new Set(['-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w', '-B']);
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (takesValue.has(w)) { i++; continue; }
    if (w.startsWith('-')) continue;
    return w;
  }
  return null;
}

/**
 * The hosts a terminal is on: its SSH profile's alias and target, and an ssh command running in it.
 * @param {Tab} tab
 */
function hostsOf(tab) {
  const profile = profileOf(tab);
  /** @type {(string | undefined)[]} */
  const hosts = [];
  if (isSshProfile(profile)) {
    hosts.push(/** @type {SessionProfile} */ (profile).name, /** @type {SessionProfile} */ (profile).description?.split(' via ')[0]);
  }
  const running = sshTarget(tab.running?.command);
  if (running) {
    hosts.push(running);
    // An alias from ~/.ssh/config: its profile says where it really goes.
    const alias = state.profiles.find(p => isSshProfile(p) && p.name.toLowerCase() === running.replace(/^[^@]*@/, '').toLowerCase());
    if (alias) hosts.push(alias.description?.split(' via ')[0], ...(alias.tags ?? []).map(t => `${TAG_MARK}${t}`));
  }
  return /** @type {string[]} */ (hosts.filter(Boolean));
}

/**
 * The environment a terminal is on ({ id, label, color }), or null.
 * @param {Tab | null | undefined} tab
 */
export function environmentOf(tab) {
  if (!tab) return null;
  const profileTags = profileOf(tab)?.tags ?? [];
  const hosts = hostsOf(tab);
  for (const env of environments()) {
    if (tab.tags.includes(env.id) || profileTags.includes(env.id) || hosts.includes(`${TAG_MARK}${env.id}`)) return env;
    if (hosts.some(h => !h.startsWith(TAG_MARK) && hostMatches(h, env.patterns))) return env;
  }
  return null;
}

/** @param {Tab} tab */
export const isProduction = tab => environmentOf(tab)?.id === 'prod';

/** A pane on an environment: its class, and the CSS variable with the environment's colour. */
export const ENV_CLASS = 'env';
export const ENV_COLOR = '--env';

/** Words that make a paste worth a second look on production. */
const DANGEROUS = /\b(rm|drop|delete|truncate|shutdown|reboot|kill|mkfs|dd|format|destroy)\b/i;

/**
 * Whether pasting `text` into `tab` should ask first (Settings › Terminal › Production: paste).
 * @param {Tab} tab
 * @param {string} text
 */
export function pasteNeedsConfirm(tab, text) {
  if (!isProduction(tab)) return false;
  const rule = state.settings.safety.prodPaste ?? prodPaste.default;
  if (rule === prodPaste.never) return false;
  if (rule === prodPaste.multiline) return /\r?\n./.test(text.trimEnd()) || DANGEROUS.test(text);
  if (rule === prodPaste.dangerous) return DANGEROUS.test(text);
  return true;
}

/**
 * Asks before something reaches a production terminal: `what` says what ("Paste", "Send a snippet"…), `text`
 * is shown so the user sees exactly what would run. Resolves true to go ahead.
 * @param {Tab[]} tabs
 * @param {string} what
 * @param {string} [text]
 */
export function confirmProduction(tabs, what, text = '') {
  const prod = tabs.filter(isProduction);
  if (!prod.length) return Promise.resolve(true);
  const lines = String(text).trimEnd().split(/\r?\n/);
  return modal('confirm prod-confirm', `
    <h3><span class="env-chip" style="--env:${/** @type {EnvironmentSetting} */ (environmentOf(prod[0])).color}">${escapeHtml(/** @type {EnvironmentSetting} */ (environmentOf(prod[0])).label)}</span> ${escapeHtml(what)} on production?</h3>
    <p class="dialog-sub">${escapeHtml(prod.map(tabTitle).join(', '))} ${prod.length === 1 ? 'is' : 'are'} on production.</p>
    ${text ? `<pre class="paste-preview">${escapeHtml(lines.slice(0, 8).join('\n'))}${lines.length > 8 ? `\n… ${lines.length - 8} more` : ''}</pre>` : ''}
    <div class="dialog-actions">
      <button class="btn" data-cancel autofocus>Cancel</button>
      <button class="btn danger" data-ok>${escapeHtml(what)}</button>
    </div>`, (dialog, close) => {
    // Enter doesn't go ahead here: a reflex shouldn't run something on production.
    return { submit: () => {}, ok: () => close(true) };
  }).then(result => result === true);
}
