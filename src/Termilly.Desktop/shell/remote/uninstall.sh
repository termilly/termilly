#!/bin/sh
# Takes Termilly's shell integration off this host again ("Remove Termilly from this host"): the line in
# ~/.bashrc and ~/.zshrc that sources it, and ~/.termilly. Shells already open keep it until they exit.

for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
  [ -f "$rc" ] && grep -q '\.termilly/termilly\.sh' "$rc" || continue
  # Written back with cat, so the file keeps its permissions (and stays a symlink's target).
  grep -v '\.termilly/termilly\.sh' "$rc" > "$rc.termilly-tmp" && cat "$rc.termilly-tmp" > "$rc"
  rm -f "$rc.termilly-tmp"
done
rm -rf "$HOME/.termilly"
printf 'Termilly is no longer set up on this host. Open a new shell to finish.\n'
