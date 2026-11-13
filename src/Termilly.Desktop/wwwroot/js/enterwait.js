// @ts-check
// The wait before an Enter typed after text into a terminal (js/api.js, the compact view, hibernation): typed together,
// an agent takes them for a paste. Its own module, with few imports, so anything that types can use it.

import { runningAgent } from './store.js';
import { agentKind } from './agentkinds.js';

/**
 * How long after the text the API's Enter goes: typed together, a TUI such as Claude Code takes a long text and its
 * Enter as one paste, and the Enter only adds a line instead of submitting (50 ms was enough when measured).
 */
const ENTER_DELAY_MS = 200;
/**
 * For an agent that needs it (agentkinds.js enterAfterQuiet: Codex), the Enter waits instead until its screen has shown
 * the text and then been still this long, and at most ENTER_MAX_MS.
 */
const ENTER_QUIET_MS = 300;
const ENTER_MAX_MS = 3000;

/**
 * Waits before the API's Enter: ENTER_DELAY_MS, or for an agent that takes a long text for a paste, until its screen
 * settles. Codex draws nothing while it takes in a long text (0.4 s for 1,100 characters, measured), and an Enter in that
 * time is lost, so its stillness only counts once its screen has shown the text.
 * @param {Tab} tab
 * @param {boolean} [typed] whether text was typed just before; with none, nothing will show it, so only ENTER_DELAY_MS
 */
export function beforeEnter(tab, typed = true) {
  const term = tab.view?.term;
  const agent = runningAgent(tab);
  if (!typed || !term || !agent || !agentKind(agent).enterAfterQuiet) return new Promise(resolve => setTimeout(resolve, ENTER_DELAY_MS));
  return new Promise(resolve => {
    let quiet = 0;
    const end = () => {
      clearTimeout(quiet);
      clearTimeout(cap);
      writes.dispose();
      resolve(undefined);
    };
    const writes = term.onWriteParsed(() => {
      clearTimeout(quiet);
      quiet = window.setTimeout(end, ENTER_QUIET_MS);
    });
    const cap = window.setTimeout(end, ENTER_MAX_MS);
  });
}

