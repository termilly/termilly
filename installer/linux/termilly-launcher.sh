#!/bin/sh
# /usr/bin/termilly, as Windows' bin\termilly.cmd: `termilly` starts Termilly, `termilly <folder>` (or `termilly .`)
# opens it there, and anything else is the termilly command (list, state, open, send…) for scripts and agents.
# Termilly's own terminals have its agent folder first on PATH, so there `termilly` is that command directly.
app=/opt/termilly

start() {
    # Its own session, with no terminal: closing the one this was typed in doesn't close Termilly.
    setsid -f "$app/termilly" "$@" </dev/null >/dev/null 2>&1
}

case "$1" in
    "")
        start
        ;;
    --open)
        [ -d "$2" ] && start "$(realpath "$2")" || start
        ;;
    *)
        if [ $# -eq 1 ] && [ -d "$1" ]; then
            start "$(realpath "$1")"
        else
            exec "$app/agent/termilly" "$@"
        fi
        ;;
esac
