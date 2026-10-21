// @ts-check
// Bringing terminals back after a restart or crash (SessionSnapshot.cs keeps it, encrypted): every half minute,
// and once more on exit, each terminal's last lines and running agent session are saved. At the next start they
// come back dimmed above a fresh prompt, without a word about it: that's what Termilly does. A Claude Code session
// that was running picks up again by itself (`claude --resume <session>` at the first prompt, in the folder it was
// in); a hibernated one stays hibernated until its terminal is opened.

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { state } from './store.js';
import { bufferLines, scrolledBack, prepareStart } from './terminals.js';
import { markHibernated } from './hibernate.js';
import { SETTING_VALUES } from './constants.js';

/** The choices of the settings used here (C#'s SettingValues). */
const { restoreSession } = SETTING_VALUES;

const EVERY = 30000;
const LINES = 500;
const SESSION_ID = /^[0-9a-f][0-9a-f-]{7,63}$/i;

/**
 * Where a saved terminal was scrolled to: lines back from the end, or null for the bottom (also when the snapshot
 * doesn't say, one from before 1.1.0).
 * @param {any} s
 */
const scrollOf = s => (Number.isInteger(s.scroll) && s.scroll > 0 ? s.scroll : null);

/** What each open terminal shows now, in SessionSnapshot's shape. */
function snapshot() {
  /** @type {Record<string, object>} */
  const tabs = {};
  for (const tab of state.tabs.values()) {
    if (!tab.view?.term || tab.noHistory) continue;
    // A session still waiting to resume (its shell hasn't shown a prompt yet) is kept for the next start too.
    const session = tab.agent?.session ?? tab.hibernated?.session ?? tab.start?.resumeSession;
    const lines = bufferLines(tab, LINES);
    tabs[tab.id] = {
      lines,
      scroll: scrolledBack(tab, lines), // null at the bottom
      agentSession: session && SESSION_ID.test(session) ? session : null,
      hibernated: !tab.agent?.session && !!tab.hibernated,
    };
  }
  return { savedAt: Date.now(), tabs };
}

const enabled = () => state.settings.session.restore === restoreSession.scrollback;

setInterval(() => {
  if (enabled() && state.tabs.size) send(PAGE.snapshotSave, { snapshot: snapshot() });
}, EVERY);

// Termilly is closing: one last, current snapshot, then the host closes.
onHost(HOST.snapshotRequest, () => send(PAGE.snapshotSave, { snapshot: snapshot(), final: true }));

/**
 * At start: gives each restored terminal its saved lines (shown dimmed by writeRestoredOutput). A Claude Code
 * session that was running resumes by itself at the shell's first prompt (terminals.js types its start command);
 * a hibernated one waits for its terminal to be opened (hibernate.js). Nothing else runs by itself.
 * @param {any} saved
 */
export function applySnapshot(saved) {
  if (!enabled() || !saved?.tabs) return;
  for (const tab of state.tabs.values()) {
    const s = saved.tabs[tab.id];
    if (!s) continue;
    if (Array.isArray(s.lines) && s.lines.length) prepareStart(tab, { output: { lines: s.lines, closedAt: saved.savedAt, resurrected: true, scroll: scrollOf(s) } });
    const session = s.agentSession && SESSION_ID.test(s.agentSession) ? s.agentSession : null;
    if (session && s.hibernated) {
      markHibernated(tab, session, saved.savedAt);
    } else if (session) {
      prepareStart(tab, { resumeSession: session, command: `claude --resume ${session}` });
    }
  }
}
