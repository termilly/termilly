#!/bin/sh
# Puts Termilly in the desktop's app list with its icon, for the build this script sits next to: the icons go
# in ~/.local/share/icons/hicolor and termilly.desktop in ~/.local/share/applications. Run it again after
# moving the build. ./install-desktop.sh --remove takes both out again.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
data=${XDG_DATA_HOME:-$HOME/.local/share}

if [ "${1:-}" = "--remove" ]; then
    rm -f "$data/applications/termilly.desktop"
    gio set -t unset "$here/termilly" metadata::custom-icon 2>/dev/null || true
    find "$data/icons/hicolor" -path '*/apps/termilly.*' -delete 2>/dev/null || true
else
    for icon in "$here"/icons/hicolor/*/apps/termilly.*; do
        size=$(basename "$(dirname "$(dirname "$icon")")")
        mkdir -p "$data/icons/hicolor/$size/apps"
        cp "$icon" "$data/icons/hicolor/$size/apps/"
    done
    # The termilly file itself, in the file manager (an executable can't carry its own icon on Linux).
    gio set "$here/termilly" metadata::custom-icon "file://$here/icons/hicolor/256x256/apps/termilly.png" 2>/dev/null || true
    mkdir -p "$data/applications"
    # Exec is quoted for the desktop file format: a path with spaces still works.
    sed "s|@EXEC@|\"$here/termilly\"|" "$here/termilly.desktop" > "$data/applications/termilly.desktop"
fi

gtk-update-icon-cache -q -t "$data/icons/hicolor" 2>/dev/null || true
update-desktop-database -q "$data/applications" 2>/dev/null || true
