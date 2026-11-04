# The user's .zshrc (see .zshenv), then Termilly's integration. A shell that isn't a login shell reads no .zlogin, so
# ZDOTDIR goes back to the user's here.
__termilly_zdotdir=$ZDOTDIR
ZDOTDIR=$TERMILLY_USER_ZDOTDIR
[[ -f $ZDOTDIR/.zshrc ]] && builtin source "$ZDOTDIR/.zshrc"
TERMILLY_USER_ZDOTDIR=$ZDOTDIR
[[ -f $__termilly_zdotdir/../termilly.zsh ]] && builtin source "$__termilly_zdotdir/../termilly.zsh"
if [[ -o login ]]; then
  ZDOTDIR=$__termilly_zdotdir
else
  ZDOTDIR=$TERMILLY_USER_ZDOTDIR
  unset __termilly_zdotdir TERMILLY_USER_ZDOTDIR
fi
