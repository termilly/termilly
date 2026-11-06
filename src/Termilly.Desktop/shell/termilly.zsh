# Termilly's shell integration for zsh on this machine: marks where each prompt and command starts and ends (OSC 133),
# the command line (OSC 633;E) and the folder (OSC 7), as bash's marks from PS0 and PROMPT_COMMAND do
# (SessionLaunch.cs). Termilly starts zsh with ZDOTDIR at shell/zsh, whose startup files read yours first and then
# this, so your prompt and settings stay as they are. Settings > Terminal > Shell integration turns it off.

[[ -o interactive ]] || return 0
[[ -z ${__termilly_zsh-} ]] || return 0
typeset -g __termilly_zsh=1

# Before each prompt: Termilly's agent folder first on PATH (a login shell's files, macOS's path_helper too, put their
# own first), the folder, how the last command ended, and a prompt starts.
__termilly_precmd() {
  local st=$?
  if [[ -n ${TERMILLY_AGENT_DIR-} && $PATH != "$TERMILLY_AGENT_DIR":* ]]; then
    PATH="$TERMILLY_AGENT_DIR:$PATH"
  fi
  printf '\033]7;file://%s%s\007' "$HOST" "$PWD"
  printf '\033]133;D;%s\007\033]133;A\007' "$st"
}

# Before each command: its line (on one line: the mark ends at a newline), then the command starts.
__termilly_preexec() {
  printf '\033]633;E;%s\007\033]133;C\007' "${1//$'\n'/ }"
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec __termilly_preexec
# First, so $? is still the command's when it's read.
precmd_functions=(__termilly_precmd ${precmd_functions:#__termilly_precmd})
