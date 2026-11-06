# Termilly's shell integration for tcsh: marks where each prompt and command starts and ends (OSC 133), the command
# line (OSC 633;E) and the folder (OSC 7), as bash's marks do (SessionLaunch.cs). Read last by shell/tcsh/.tcshrc,
# after your own .tcshrc. Settings > Terminal > Shell integration turns it off.

# Termilly's agent folder first on PATH (a login shell's files, macOS's path_helper too, put their own first).
if ($?TERMILLY_AGENT_DIR) then
  if ("$PATH" !~ "${TERMILLY_AGENT_DIR}:*") setenv PATH "${TERMILLY_AGENT_DIR}:${PATH}"
endif

# Before each prompt: the folder, how the last command ended, and a prompt starts. Before each command: its line,
# then the command starts. tcsh runs postcmd for an empty Enter and for its own start too, so only a line that made a
# new history entry counts as a command. A precmd or postcmd alias of your own still runs, after Termilly's (only when
# there is one: tcsh removes an alias that fails).
set __termilly_event = "`history 1`"
set __termilly_precmd = "`alias precmd`"
set __termilly_postcmd = "`alias postcmd`"
set __termilly_mark = 'set __termilly_status = $status; set __termilly_event = "`history 1`"; printf "\033]7;file://%s%s\007\033]133;D;%s\007\033]133;A\007" "$HOST" "$cwd" "$__termilly_status"'
set __termilly_run = 'if ("`history 1`" != "$__termilly_event") printf "\033]633;E;%s\007\033]133;C\007" "`history -h 1`"'
if ("$__termilly_precmd" == "") then
  alias precmd "$__termilly_mark"
else
  alias precmd "$__termilly_mark"'; eval "$__termilly_precmd"'
endif
if ("$__termilly_postcmd" == "") then
  alias postcmd "$__termilly_run"
else
  alias postcmd "$__termilly_run"'; eval "$__termilly_postcmd"'
endif
unset __termilly_mark __termilly_run
