// Autocomplete at a bash prompt (js/autocomplete.js): bash marks where its prompt ends (133;B at the end of PS1,
// SessionLaunch.cs), so a command run there comes back in grey as it's typed again, and → takes it.
// Run with: npm run e2e (on Linux, under Xvfb).
// Covers: js/autocomplete.js js/suggest.js src/Termilly.App/Features/History*.cs src/Termilly.Desktop/shell/termilly.bash
import { test, before, after } from 'node:test';
import { startApp } from './harness.mjs';

const COMMAND = 'ls -la /tmp';
const TYPED = 'ls -';

let app;
let failed = false;

/** A test that marks the run failed (with a screenshot of the moment) when it throws. @param {string} name @param {() => Promise<void>} run */
const step = (name, run) => test(name, async () => {
  try {
    await run();
  } catch (e) {
    failed = true;
    await app?.screenshot(name.replace(/\W+/g, '-')).catch(() => null);
    throw e;
  }
});

/** The first terminal's prompt state: where its input starts, and the line typed after it. */
const prompt = () => app.eval(async t => {
  const { state } = await t.import('store.js');
  const { lineAt } = await t.import('autocomplete.js');
  const tab = [...state.tabs.values()].find(x => x.view?.term);
  return { input: !!tab.commands?.input, running: !!tab.running, line: lineAt(tab) };
});

/**
 * Keys pressed in the first terminal, one by one: the key goes down where Termilly's key hooks see it, and unless one
 * took it, what it types goes to the shell (a made-up key event types nothing in xterm by itself).
 * @param {string[]} keys
 */
const press = keys => app.eval(async (t, keys) => {
  const { state } = await t.import('store.js');
  const tab = [...state.tabs.values()].find(x => x.view?.term);
  const term = tab.view.term;
  term.focus();
  const text = { Enter: '\r' };
  for (const key of keys) {
    const init = { key, bubbles: true, cancelable: true };
    const kept = term.textarea.dispatchEvent(new globalThis.KeyboardEvent('keydown', init));
    term.textarea.dispatchEvent(new globalThis.KeyboardEvent('keyup', init));
    if (kept && (key.length === 1 || key in text)) term.input(text[key] ?? key, true);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}, keys);

/** Waits until a check on the prompt holds. @param {(p: any) => boolean} ok @param {string} what */
async function until(ok, what) {
  const end = Date.now() + 10000;
  let seen;
  while (Date.now() < end) {
    seen = await prompt();
    if (ok(seen)) return seen;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${what}: ${JSON.stringify(seen)}`);
}

before(async () => {
  app = await startApp({ name: 'autocomplete-bash' });
  await app.waitFor('.pane .xterm');
});

after(async () => { await app?.stop({ failed }); });

step('bash marks where its prompt ends', async () => {
  await until(p => p.input && p.line?.typed === '', 'no prompt end at the first prompt');
});

step('a command run in bash is offered in grey when typed again, and → takes it', async () => {
  await press([...COMMAND, 'Enter']);
  await until(p => !p.running && p.line?.typed === '', 'the command did not end at a new prompt');
  await press([...TYPED]);
  await until(p => p.line?.typed === TYPED, 'what was typed is not read after the prompt');
  await app.waitFor('.ac-ghost', { text: COMMAND.slice(TYPED.length) });
  await app.screenshot('ghost');
  await press(['ArrowRight']);
  await until(p => p.line?.typed === COMMAND, '→ did not take the grey text');
});

step('a prompt rebuilt after Termilly\'s mark (as Starship does) still gets it, from the first key typed there', async () => {
  await press(['Enter']); // runs what → put on the line
  await until(p => !p.running && p.line?.typed === '', 'the taken command did not run');
  // The user's own prompt command, after Termilly's: PS1 is made again without the prompt's end mark.
  await press([...'PROMPT_COMMAND="$PROMPT_COMMAND; PS1=\'rebuilt> \'"', 'Enter']);
  await until(p => !p.running && !p.input, 'the rebuilt prompt still marks its end');
  await press([...COMMAND, 'Enter']);
  await until(p => !p.running && !p.input, 'the command did not end at a new prompt');
  await press([...TYPED]);
  await until(p => p.line?.typed === TYPED, 'what was typed is not read after the rebuilt prompt');
  await app.waitFor('.ac-ghost', { text: COMMAND.slice(TYPED.length) });
});
