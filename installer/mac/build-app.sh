#!/bin/sh
# Builds Termilly for macOS: dist/Termilly-<version>-<arch>.dmg (to install) and .zip (what updates download).
#
#   installer/mac/build-app.sh [arm64|x64 ...]     default: both
#
# Runs on a Mac (iconutil, hdiutil, codesign). Macs don't have .NET, so the app carries one copy of the .NET runtime in
# Contents/MacOS/dotnet, and every program in it (termilly, host/termilly-host, the agent helpers) is published to look
# for .NET there (AppHostRelativeDotNet), not in a system install.
#
# Signing: with MAC_SIGN_IDENTITY set (a "Developer ID Application: ..." identity in the keychain) it signs for
# release; without it, ad hoc ("-"), which macOS warns about when the app is opened but is enough to test the layout.
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd -P)  # -P: the real path, or the compiler and .editorconfig see two different ones
here="$repo/installer/mac"
cache="$repo/installer/.cache/mac"
version=$(sed -n 's:.*<Version>\(.*\)</Version>.*:\1:p' "$repo/Directory.Build.props")
identity=${MAC_SIGN_IDENTITY:--}
archs=${*:-arm64 x64}
mkdir -p "$cache" "$repo/dist"

# The newest .NET 10 runtime for macOS, from Microsoft's release list; its SHA-512 is checked after downloading.
releases="$cache/releases.json"
curl -fsSL --retry 3 -o "$releases" https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json
runtime=$(plutil -extract latest-runtime raw -o - "$releases")

# The download URL and hash of one runtime file (e.g. dotnet-runtime-osx-arm64.tar.gz) in the newest release.
runtime_file() {
    i=0
    while name=$(plutil -extract "releases.0.runtime.files.$i.name" raw -o - "$releases" 2>/dev/null); do
        if [ "$name" = "$1" ]; then
            plutil -extract "releases.0.runtime.files.$i.url" raw -o - "$releases"
            plutil -extract "releases.0.runtime.files.$i.hash" raw -o - "$releases"
            return 0
        fi
        i=$((i + 1))
    done
    echo "$1 isn't in .NET's newest release" >&2
    return 1
}
[ "$(plutil -extract releases.0.runtime.version raw -o - "$releases")" = "$runtime" ] || {
    echo "The newest .NET release isn't runtime $runtime" >&2
    exit 1
}

# Signs one file or the app: hardened runtime, Termilly's entitlements, and a secure timestamp when it's for release.
sign() {
    if [ "$identity" = "-" ]; then
        codesign --force --sign - --options runtime --entitlements "$here/entitlements.plist" "$1"
    else
        codesign --force --sign "$identity" --options runtime --timestamp --entitlements "$here/entitlements.plist" "$1"
    fi
}

for arch in $archs; do
    case $arch in arm64 | x64) ;; *) echo "Unknown processor: $arch (arm64 or x64)" >&2; exit 1 ;; esac
    rid="osx-$arch"
    work=$(mktemp -d)
    app="$work/Termilly.app"
    macos="$app/Contents/MacOS"
    mkdir -p "$macos" "$app/Contents/Resources"

    echo "Termilly $version ($arch): .NET runtime $runtime"
    tarball="$cache/dotnet-runtime-$runtime-$rid.tar.gz"
    set -- $(runtime_file "dotnet-runtime-$rid.tar.gz")
    if [ ! -f "$tarball" ] || [ "$(shasum -a 512 "$tarball" | cut -d' ' -f1)" != "$2" ]; then
        curl -fsSL --retry 3 -o "$tarball.part" "$1"
        [ "$(shasum -a 512 "$tarball.part" | cut -d' ' -f1)" = "$2" ] || { echo "$1: wrong SHA-512" >&2; exit 1; }
        mv "$tarball.part" "$tarball"
    fi
    mkdir "$macos/dotnet"
    tar -xzf "$tarball" -C "$macos/dotnet"
    # Only the runtime is used, through each program's own launcher: not the dotnet command.
    rm -f "$macos/dotnet/dotnet"

    echo "Termilly $version ($arch): publishing"
    dotnet publish "$repo/src/Termilly.Linux" -c Release -r "$rid" --self-contained false \
        -p:AppHostRelativeDotNet=dotnet -o "$macos" -v quiet -nologo
    # The build's host and agent helper came along, looking for a system .NET: published again, looking for the app's.
    rm -rf "$macos/host" "$macos/agent"
    dotnet publish "$repo/src/Termilly.Host" -c Release -r "$rid" --self-contained false \
        -p:AppHostRelativeDotNet=../dotnet -o "$macos/host" -v quiet -nologo
    dotnet publish "$repo/src/Termilly.Agent" -c Release -r "$rid" --self-contained false \
        -p:AppHostRelativeDotNet=../dotnet -o "$macos/agent" -v quiet -nologo
    # The agent helper runs under four names (see Termilly.Linux.csproj, CopyAgentHelper).
    for name in claude termilly termilly-askpass; do cp "$macos/agent/termilly-hook" "$macos/agent/$name"; done
    # What a build folder has but an app doesn't need.
    rm -rf "$macos/conpty" "$macos/install-desktop.sh" "$macos/termilly.desktop"
    find "$macos" -name '*.pdb' -delete

    # The icon: the Linux sizes up to 256, and 512 and 1024 rendered for the Mac (branding/make-icon.ps1).
    iconset="$work/termilly.iconset"
    mkdir "$iconset"
    icons="$macos/icons/hicolor"
    cp "$icons/16x16/apps/termilly.png" "$iconset/icon_16x16.png"
    cp "$icons/32x32/apps/termilly.png" "$iconset/icon_16x16@2x.png"
    cp "$icons/32x32/apps/termilly.png" "$iconset/icon_32x32.png"
    cp "$icons/64x64/apps/termilly.png" "$iconset/icon_32x32@2x.png"
    cp "$icons/128x128/apps/termilly.png" "$iconset/icon_128x128.png"
    cp "$icons/256x256/apps/termilly.png" "$iconset/icon_128x128@2x.png"
    cp "$icons/256x256/apps/termilly.png" "$iconset/icon_256x256.png"
    cp "$here/icons/termilly-512.png" "$iconset/icon_256x256@2x.png"
    cp "$here/icons/termilly-512.png" "$iconset/icon_512x512.png"
    cp "$here/icons/termilly-1024.png" "$iconset/icon_512x512@2x.png"
    iconutil -c icns "$iconset" -o "$app/Contents/Resources/termilly.icns"

    sed -e "s/@VERSION@/$version/g" "$here/Info.plist" > "$app/Contents/Info.plist"
    plutil -lint -s "$app/Contents/Info.plist"

    echo "Termilly $version ($arch): signing ($([ "$identity" = "-" ] && echo "ad hoc" || echo "$identity"))"
    # Inside out: every program and library first, the app last (it seals the rest).
    find "$macos" -type f | while read -r file; do
        case $(file -b "$file") in *Mach-O*) sign "$file" ;; esac
    done
    sign "$app"
    codesign --verify --deep --strict "$app"

    echo "Termilly $version ($arch): packing"
    base="$repo/dist/Termilly-$version-$arch"
    rm -f "$base.zip" "$base.dmg"
    ditto -c -k --keepParent "$app" "$base.zip"
    staging="$work/dmg"
    mkdir "$staging"
    ditto "$app" "$staging/Termilly.app"
    ln -s /Applications "$staging/Applications"
    hdiutil create -quiet -volname "Termilly" -srcfolder "$staging" -fs HFS+ -format UDZO -ov "$base.dmg"
    [ "$identity" = "-" ] || codesign --force --sign "$identity" --timestamp "$base.dmg"
    rm -rf "$work"
    echo "$base.dmg ($(du -h "$base.dmg" | cut -f1)), $base.zip ($(du -h "$base.zip" | cut -f1))"
done
