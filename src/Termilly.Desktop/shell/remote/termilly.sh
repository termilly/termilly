# Termilly's shell integration on a remote host, for bash and zsh. Termilly installs it into ~/.termilly when you
# choose "Set up Termilly on this host" (RemoteIntegration.cs) and ~/.bashrc / ~/.zshrc source it. Over ssh Termilly
# only sees what reaches the terminal, so this reports what it shows for local shells as escape sequences:
#   OSC 133 prompt and command marks (with the exit code), OSC 633;E the command line, OSC 7 the folder,
#   OSC 633;P;TermillyGit= the repository's branch and changes, OSC 633;P;TermillyRemote= this script's version,
# and runs claude with hooks (termilly-hook.sh) that report what Claude Code is doing.
# It does nothing outside Termilly: only a terminal Termilly opened sets LC_TERMILLY, and ssh passes LC_* on.
# A shell Termilly started on this machine (TERM_PROGRAM, which ssh doesn't pass) has its own integration.

TERMILLY_REMOTE_VERSION=3

[ "${LC_TERMILLY-}" = 1 ] || return 0
[ "${TERM_PROGRAM-}" != Termilly ] || return 0
case $- in *i*) ;; *) return 0 ;; esac
# Loaded once per shell; an update loads again over an older version.
[ "${__termilly_loaded-}" != "$TERMILLY_REMOTE_VERSION" ] || return 0
__termilly_loaded=$TERMILLY_REMOTE_VERSION
__termilly_reported=

# An escape sequence for Termilly; inside tmux wrapped as passthrough (tmux drops it unless allow-passthrough is on).
__termilly_osc() {
  if [ -n "${TMUX-}" ]; then
    printf '\033Ptmux;\033\033]%s\007\033\\' "$1"
  else
    printf '\033]%s\007' "$1"
  fi
}

# The repository the shell is in: branch|changed files|ahead|behind|upstream|root, or nothing outside one.
__termilly_git() {
  local root out line branch upstream ab ahead behind changed
  if ! command -v git >/dev/null 2>&1 || ! root=$(git rev-parse --show-toplevel 2>/dev/null); then
    __termilly_osc '633;P;TermillyGit='
    return 0
  fi
  if command -v timeout >/dev/null 2>&1; then
    out=$(GIT_OPTIONAL_LOCKS=0 timeout 2 git status --porcelain=v2 --branch 2>/dev/null)
  else
    out=$(GIT_OPTIONAL_LOCKS=0 git status --porcelain=v2 --branch 2>/dev/null)
  fi
  branch= upstream= ahead=0 behind=0 changed=0
  while IFS= read -r line; do
    case $line in
      '# branch.head '*) branch=${line#'# branch.head '} ;;
      '# branch.upstream '*) upstream=${line#'# branch.upstream '} ;;
      '# branch.ab '*)
        ab=${line#'# branch.ab '}
        ahead=${ab%% *}; ahead=${ahead#+}
        behind=${ab##* }; behind=${behind#-} ;;
      '#'*) ;;
      ?*) changed=$((changed + 1)) ;;
    esac
  done <<TERMILLY_GIT
$out
TERMILLY_GIT
  __termilly_osc "633;P;TermillyGit=$branch|$changed|$ahead|$behind|$upstream|$root"
}

# At each prompt: the last command's end and exit code, the folder, the repository, then a prompt starts.
__termilly_prompt() {
  local code=$? # not "status": zsh has that name for $?
  __termilly_osc "133;D;$code"
  if [ -z "${__termilly_reported-}" ]; then
    __termilly_reported=1
    __termilly_osc "633;P;TermillyRemote=$TERMILLY_REMOTE_VERSION"
  fi
  __termilly_osc "7;file://${HOSTNAME:-${HOST-}}$PWD"
  __termilly_git
  __termilly_osc '133;A'
  return $code
}

# Before each command: what runs, then that it runs.
__termilly_preexec() {
  local command
  command=$(printf '%s' "$1" | tr '\n\r\007\033' '    ')
  __termilly_osc "633;E;$command"
  __termilly_osc '133;C'
}

if [ -n "${ZSH_VERSION-}" ]; then
  autoload -Uz add-zsh-hook
  add-zsh-hook precmd __termilly_prompt
  add-zsh-hook preexec __termilly_preexec
elif [ -n "${BASH_VERSION-}" ]; then
  # Once, even when an update loads this again (add-zsh-hook doesn't add a hook twice either).
  case ${PROMPT_COMMAND-} in
    *__termilly_prompt*) ;;
    *) PROMPT_COMMAND="__termilly_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
  esac
  # PS0 runs before each command (bash 4.4+); history 1 is the line about to run.
  case ${PS0-} in
    *__termilly_preexec*) ;;
    *) PS0="${PS0-}"'$(__termilly_preexec "$(HISTTIMEFORMAT= history 1 | sed "s/^ *[0-9]* *//")")' ;;
  esac
fi

# Claude Code with Termilly's hooks, as the local claude shim adds them. Claude Code runs hooks in a session of their
# own, without this terminal (/dev/tty), so the hooks get its device in TERMILLY_TTY. The function keyword keeps an
# alias named claude from breaking this line (which then wins, without hooks).
function claude {
  local tty
  # The shell's own terminal device (pts/3 on Linux, ttys003 on macOS), also when claude's input is a pipe, which
  # is all tty would name.
  tty=$(ps -o tty= -p $$ 2>/dev/null | tr -d ' ')
  case $tty in ''|'?'*) tty= ;; *) tty=/dev/$tty ;; esac
  # Inside tmux the hooks' reports go out as passthrough, which tmux drops unless the pane allows it (off by
  # default since tmux 3.3): every event would be lost, and Claude would look idle or stuck. Only this pane, and
  # only once claude runs in it. Older tmux has no such option and passes them on anyway.
  if [ -n "${TMUX-}" ]; then
    tmux set-option -p allow-passthrough on >/dev/null 2>&1
  fi
  if [ -f "$HOME/.termilly/claude-settings.json" ]; then
    TERMILLY_TTY=$tty command claude --settings "$HOME/.termilly/claude-settings.json" "$@"
  else
    command claude "$@" # removed from this host while the shell was open
  fi
}
