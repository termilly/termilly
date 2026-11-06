# Termilly starts zsh with ZDOTDIR here (SessionLaunch.cs); each of these files reads the user's own first, from
# their ZDOTDIR (TERMILLY_USER_ZDOTDIR, else ~). Their files may move ZDOTDIR: that's kept as theirs.
__termilly_zdotdir=$ZDOTDIR
ZDOTDIR=${TERMILLY_USER_ZDOTDIR:-$HOME}
[[ -f $ZDOTDIR/.zshenv ]] && builtin source "$ZDOTDIR/.zshenv"
TERMILLY_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$__termilly_zdotdir
