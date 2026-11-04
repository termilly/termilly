# Termilly's shell integration for ksh (ksh93): marks where each prompt and command starts and ends (OSC 133), the
# command line (OSC 633;E) and the folder (OSC 7), as bash's marks do (SessionLaunch.cs). Termilly starts ksh with ENV
# at this file, which reads your own ENV file (or ~/.kshrc) first. Settings > Terminal > Shell integration turns it off.

# Your ENV is yours again, for this shell and the ones it starts.
if [[ -n ${TERMILLY_USER_ENV-} ]]; then export ENV=$TERMILLY_USER_ENV; else unset ENV; fi
unset TERMILLY_USER_ENV
if [[ -n ${ENV-} && -r $ENV ]]; then . "$ENV"; elif [[ -r ~/.kshrc ]]; then . ~/.kshrc; fi

[[ $- == *i* ]] || return 0
# ksh93 only (a mksh or pdksh named ksh has none of what follows).
case ${KSH_VERSION-} in *93*) ;; *) return 0 ;; esac
[[ -z ${__termilly_ksh-} ]] || return 0
__termilly_ksh=1

# Termilly's agent folder first on PATH (a login shell's files, macOS's path_helper too, put their own first).
if [[ -n ${TERMILLY_AGENT_DIR-} && $PATH != "$TERMILLY_AGENT_DIR":* ]]; then PATH="$TERMILLY_AGENT_DIR:$PATH"; fi

# Each time the prompt shows: the folder, how the last command ended, and a prompt starts (in front of your PS1).
__termilly_ready=
function PS1.get {
  typeset st=$?
  .sh.value=$'\e]7;file://'"${HOSTNAME:-$(hostname)}$PWD"$'\a\e]133;D;'"$st"$'\a\e]133;A\a'"${.sh.value}"
  __termilly_ready=1
}
# Before the first command after a prompt: its line, then the command starts. Not when you have a DEBUG trap of
# your own (yours stays).
if [[ -z $(trap -p DEBUG) ]]; then
  trap '[[ -n $__termilly_ready && ${.sh.command} != __termilly_ready=1 ]] && { __termilly_ready=; print -rn -- $'"'"'\e]633;E;'"'"'"${.sh.command}"$'"'"'\a\e]133;C\a'"'"'; }' DEBUG
fi
