// A sample Termilly plugin. It runs sandboxed: `termilly` is all it can reach.
// Typing into a terminal needs Settings › Terminal › "Let scripts and agents type".

const type = (pane, text) => termilly.call('send', { pane, text, enter: false });

termilly.registerCommand({ id: 'status', label: 'Git: short status', keywords: 'git status changes' },
  ({ pane }) => type(pane, 'git status -sb'));

termilly.registerCommand({ id: 'log', label: 'Git: last 10 commits as a graph', keywords: 'git log history graph' },
  ({ pane }) => type(pane, 'git log --oneline --graph -10'));

termilly.registerCommand({ id: 'count', label: 'Git helpers: show terminal count as a status', keywords: 'status count' },
  async ({ pane }) => {
    const terminals = await termilly.call('list');
    await termilly.setStatus(pane, `${terminals.length} terminals open`);
  });
