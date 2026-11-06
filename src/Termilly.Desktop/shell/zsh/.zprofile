# The user's .zprofile (see .zshenv).
__termilly_zdotdir=$ZDOTDIR
ZDOTDIR=$TERMILLY_USER_ZDOTDIR
[[ -f $ZDOTDIR/.zprofile ]] && builtin source "$ZDOTDIR/.zprofile"
TERMILLY_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$__termilly_zdotdir
