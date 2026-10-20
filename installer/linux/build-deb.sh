#!/bin/sh
# Builds Termilly's Debian/Ubuntu package: dist/termilly_<version>_amd64.deb.
#
#   installer/linux/build-deb.sh
#
# Termilly goes in /opt/termilly, framework-dependent: .NET 10 comes from the distribution's dotnet-runtime-10.0
# (Ubuntu 24.04 and later have it; elsewhere Microsoft's package repository does). The termilly command is
# /usr/bin/termilly (termilly-launcher.sh); the app's entry and icon go where desktops look for them.
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
here="$repo/installer/linux"
version=$(sed -n 's:.*<Version>\(.*\)</Version>.*:\1:p' "$repo/Directory.Build.props")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
root="$work/termilly_${version}_amd64"

echo "Termilly $version: publishing"
dotnet publish "$repo/src/Termilly.Linux" -c Release -r linux-x64 --self-contained false -o "$root/opt/termilly" -v quiet -nologo
# The build-folder conveniences don't belong in a package (it installs these itself).
rm -f "$root/opt/termilly/install-desktop.sh" "$root/opt/termilly/termilly.desktop" "$root/opt/termilly"/*.pdb
rm -rf "$root/opt/termilly/conpty"

# As a package installs them: directories and programs 755, everything else 644 (whatever the umask was).
find "$root/opt" -type d -exec chmod 755 {} +
find "$root/opt" -type f -exec chmod 644 {} +
chmod 755 "$root/opt/termilly/termilly" "$root/opt/termilly/host/termilly-host" "$root"/opt/termilly/agent/claude \
    "$root"/opt/termilly/agent/termilly "$root"/opt/termilly/agent/termilly-askpass "$root"/opt/termilly/agent/termilly-hook

install -Dm755 "$here/termilly-launcher.sh" "$root/usr/bin/termilly"
install -Dm644 "$here/termilly.desktop" "$root/usr/share/applications/termilly.desktop"
for icon in "$root"/opt/termilly/icons/hicolor/*/apps/termilly.*; do
    size=$(basename "$(dirname "$(dirname "$icon")")")
    install -Dm644 "$icon" "$root/usr/share/icons/hicolor/$size/apps/$(basename "$icon")"
done
install -Dm644 "$here/copyright" "$root/usr/share/doc/termilly/copyright"

mkdir -p "$root/DEBIAN"
size=$(du -sk "$root" --exclude=DEBIAN | cut -f1)
cat > "$root/DEBIAN/control" <<CONTROL
Package: termilly
Version: $version
Architecture: amd64
Maintainer: Termilly <hello@termilly.com>
Installed-Size: $size
Depends: dotnet-runtime-10.0, libwebkit2gtk-4.1-0, libgtk-3-0, libnotify4, libsecret-1-0
Recommends: openssh-client, libnotify-bin, xdg-utils, pciutils, gnome-keyring | kwalletmanager
Section: utils
Priority: optional
Homepage: https://termilly.com
Description: Terminals, workspaces and coding agents in one window
 Termilly keeps your terminals in workspaces with splits, tags and session
 restore, shows which ones are busy or waiting on you, and works with coding
 agents such as Claude Code through hooks, the termilly command and an MCP
 server. SSH hosts, SFTP, port forwards and history search are built in.
CONTROL

mkdir -p "$repo/dist"
out="$repo/dist/termilly_${version}_amd64.deb"
dpkg-deb --root-owner-group --build "$root" "$out" >/dev/null
echo "$out ($(du -h "$out" | cut -f1))"
