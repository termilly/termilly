# Termilly's shell integration for fish: marks where each prompt and command starts and ends (OSC 133), the command
# line (OSC 633;E) and the folder (OSC 7), as bash's marks do (SessionLaunch.cs). Termilly starts fish with
# XDG_DATA_DIRS at shell/xdg first, so fish reads this before your config.fish. Settings > Terminal > Shell
# integration turns it off.

# Your XDG_DATA_DIRS is yours again, for this shell and what it starts.
if set -q TERMILLY_USER_XDG_DATA_DIRS
    set -gx XDG_DATA_DIRS $TERMILLY_USER_XDG_DATA_DIRS
    set -e TERMILLY_USER_XDG_DATA_DIRS
else
    set -e XDG_DATA_DIRS
end

status is-interactive; or exit 0
set -q __termilly_fish; and exit 0
set -g __termilly_fish 1

# Each time the prompt shows: Termilly's agent folder first on PATH (your config.fish, macOS's path_helper too, put
# their own first) and the folder.
function __termilly_prompt --on-event fish_prompt
    if set -q TERMILLY_AGENT_DIR; and test "$PATH[1]" != "$TERMILLY_AGENT_DIR"
        set -gx PATH $TERMILLY_AGENT_DIR (string match -v -- $TERMILLY_AGENT_DIR $PATH)
    end
    printf '\e]7;file://%s%s\a' $hostname $PWD
end

# fish 4 marks prompts and commands itself (its command mark carries the line). Older fish: Termilly's marks, a
# prompt starts, then before each command its line (on one line: the mark ends at a newline) and the command starts,
# and after it how it ended. fish runs neither for an empty Enter.
if not status test-feature mark-prompt 2>/dev/null
    function __termilly_prompt_mark --on-event fish_prompt
        printf '\e]133;A\a'
    end
    function __termilly_preexec --on-event fish_preexec
        printf '\e]633;E;%s\a\e]133;C\a' (string join ' ' -- (string split \n -- $argv[1]))
    end
    function __termilly_postexec --on-event fish_postexec
        printf '\e]133;D;%s\a' $status
    end
end
