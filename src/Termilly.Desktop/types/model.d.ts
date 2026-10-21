// The page's own model, for the type checker (jsconfig.json): workspaces, their layout trees, terminals (tabs) and tags.
// store.js holds them (state); what the host sends is in host.d.ts, the messages in js/protocol.js.

/** One tab (one terminal) in a layout. */
interface LeafNode {
  kind: 'leaf';
  tabId: string;
}

/** Two parts side by side (row) or one above the other (column); `ratio` is the first part's share. */
interface SplitNode {
  kind: 'split';
  dir: 'row' | 'column';
  ratio: number;
  a: LayoutNode;
  b: LayoutNode;
}

/** Two or more tabs in one place, one shown (`active`: its tab id). */
interface TabsNode {
  kind: 'tabs';
  items: LeafNode[];
  active: string;
}

/** The change preview's pane (js/preview.js): not a tab, never saved. */
interface PreviewNode {
  kind: 'preview';
}

/** A node of a workspace's layout tree. Trees hold only plain data, so they're saved as they are. */
type LayoutNode = LeafNode | SplitNode | TabsNode | PreviewNode;

/** A note pinned to a terminal, a host or a workspace (js/notes.js). */
interface Note {
  text: string;
  pinned?: boolean;
}

interface Workspace {
  id: string;
  name: string;
  color: string;
  /** Its folder: where its terminals start. */
  cwd: string | null;
  focusId: string | null;
  root: LayoutNode | null;
  note?: Note | null;
  /** Its own snippets (js/snippets.js). */
  snippets?: SnippetSetting[];
  /** Folded in the sidebar. */
  collapsed?: boolean;
  /** A tmux window shown as this workspace (js/tmux.js); never saved. */
  tmux?: { client: string; window: string };
  /** Saved by older versions, which could stack a workspace's terminals; read once, then dropped (store.js). */
  stacked?: boolean;
}

/** A tag: its name, and its colour (#rrggbb). */
interface Tag {
  name: string;
  color: string;
}

/** What a terminal's agent is doing, from its hooks, `claude agents`, or an alert (main.js, store.js). */
interface AgentInfo {
  /** One of AGENT_STATE (js/constants.js). */
  state: string;
  /** One of AGENT_SOURCE. */
  source?: string;
  event?: string | null;
  tool?: string | null;
  message?: string | null;
  reason?: string | null;
  session?: string | null;
  at: number;
  /** The sidebar's activity line (js/agentline.js). */
  line?: string | null;
  /** The session has had a turn, so there's a conversation to resume (js/hibernate.js). */
  hadTurn?: boolean;
  /** The folder its session belongs to (SessionStart), where it resumes after a restart (js/snapshot.js). */
  folder?: string | null;
  /** Its news arrived out of sight and hasn't been looked at (store.js agentChanged). */
  unread?: boolean;
}

/** A terminal's pane: its element, header and body, and xterm with its fit add-on (js/panes.js, js/terminals.js). */
interface TabView {
  el: HTMLElement;
  body: HTMLElement;
  header: HTMLElement;
  term: any;
  fit: any;
}

/**
 * A terminal. Its own fields come first: what it is (saved with the workspaces, see store.js serialize) and how its
 * shell is doing. A feature's state is a group of its own, made and written by that feature's module alone (others
 * read it, or call the module); a group is missing until the module first needs it.
 */
interface Tab {
  id: string;
  /** The workspace it's in. */
  wsId: string;
  /** The shell profile it runs. */
  profile: string;
  /** Its own name; null shows the shell's. */
  name: string | null;
  tags: string[];
  /** Nothing of it is kept in history. */
  noHistory: boolean;
  note?: Note | null;
  /** The folder it was opened in (a layout's, the API's). */
  startCwd?: string | null;
  /** A layout's variables for its shell. */
  env?: Record<string, string> | null;
  /** A layout's command for its first prompt. */
  startCommand?: string | null;
  /** The git worktree it was made for (js/worktree.js). */
  worktree?: { repo: string; path: string; branch: string; copied?: number } | null;
  /** Whether agents may read it, when its menu says (js/together.js). */
  agentRead?: boolean;
  /** Whether agents may type into it (js/together.js). */
  agentType?: boolean;
  /** Brought back from the saved workspaces at start. */
  restored?: boolean;
  /** It wants attention (the amber dot; js/panes.js). */
  attention: boolean;
  startedAt: number;
  view: TabView | null;
  /** The folder its shell reported (OSC 7; js/terminals.js). */
  cwd?: string | null;
  /** The folder it was in when last saved. */
  lastCwd?: string | null;
  /** The folder its shell on a server is in (js/remotecwd.js). */
  remoteCwd?: string | null;
  /** Its shell marks prompts and commands (OSC 133; js/terminals.js). */
  shellMarks?: boolean;
  /** A marked command is running (js/terminals.js). */
  command?: { startedAt: number } | null;
  /** The command running now, as js/commands.js read it. */
  running?: import('../wwwroot/js/commands.js').CommandRun | null;
  /** The last finished command (js/commands.js). */
  lastCommand?: import('../wwwroot/js/commands.js').CommandRun | null;
  /** The program its shell runs, as the host saw (js/terminals.js). */
  busy?: string | null;
  /** The same, when it's an interactive one (ssh, vim). */
  interactive?: string | null;
  /** Progress a program reported (OSC 9;4). */
  progress?: { state: number; percent: number } | null;
  /** Output until then isn't news (js/terminals.js). */
  quietUntil?: number;
  /** Its shell ended (and it waits for a key to start again). */
  exited?: boolean;
  agent?: AgentInfo | null;
  /** An agent has run in it. */
  agentSeen?: boolean;
  /** Its agent was ended, to resume (js/hibernate.js). */
  hibernated?: { session: string; at: number; folder?: string | null } | null;
  /** A tmux pane rather than a shell of its own (js/tmux.js). */
  virtual?: { kind: 'tmux'; client: string; pane: string; cols: number; rows: number } | null;
  /** An SSH connection that dropped, reconnecting (js/reconnect.js). */
  reconnect?: import('../wwwroot/js/reconnect.js').Reconnecting | null;
  /** A status set through the API (js/api.js). */
  status?: string | null;
  /** The files Claude changed in it (js/changes.js). */
  changes?: import('../wwwroot/js/changes.js').ChangedFile[];
  /** What its agent's session has cost, as Claude reported (js/cost.js). */
  cost?: { usd: number; durationMs: number | null; session: string | null } | null;
  /** The last notification sent for it (js/notify.js). */
  notified?: string | null;
  /** What it brings back and types as its shell starts (js/terminals.js). */
  start?: import('../wwwroot/js/terminals.js').ShellStart;
  /** js/terminals.js's timers for its shell. */
  shell?: import('../wwwroot/js/terminals.js').ShellTimers;
  /** Its prompts, typed input and last commands (js/commands.js). */
  commands?: import('../wwwroot/js/commands.js').CommandsState;
  /** Where the trigger scan has got to (js/triggers.js). */
  scan?: import('../wwwroot/js/triggers.js').TriggerScan;
  /** Its one-off alerts (js/triggers.js). */
  alerts?: import('../wwwroot/js/triggers.js').OneOffAlerts;
  /** Its session log (js/logging.js). */
  log?: import('../wwwroot/js/logging.js').SessionLog;
  /** Its recording (js/replay.js). */
  recording?: import('../wwwroot/js/replay.js').Recording;
  /** Its recent output kept in memory (js/replay.js). */
  rewind?: import('../wwwroot/js/replay.js').RewindBuffer;
  /** What its commands produced (js/results.js). */
  results?: import('../wwwroot/js/results.js').TabResults;
  /** Its agent's subagents (js/subagents.js). */
  subagents?: import('../wwwroot/js/subagents.js').Subagents;
  /** Claude's usage and context figures (js/claudeusage.js). */
  claude?: import('../wwwroot/js/claudeusage.js').ClaudeFigures;
  /** Other terminals' agents using it (js/together.js). */
  access?: import('../wwwroot/js/together.js').Access;
  /** What a server's Termilly integration reported (js/remotehost.js). */
  remote?: import('../wwwroot/js/remotehost.js').RemoteState;
  /** A serial port's view (js/serial.js). */
  serial?: import('../wwwroot/js/serial.js').SerialView;
}
