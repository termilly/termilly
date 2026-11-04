# The user's .zlogin (see .zshenv), read last: from here on ZDOTDIR is the user's again, so zsh started inside
# (and the user's own tools) see their own folder.
ZDOTDIR=$TERMILLY_USER_ZDOTDIR
[[ -f $ZDOTDIR/.zlogin ]] && builtin source "$ZDOTDIR/.zlogin"
unset __termilly_zdotdir TERMILLY_USER_ZDOTDIR
