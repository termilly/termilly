# Termilly's shell integration for nushell: marks where each prompt and command starts and ends (OSC 133), the
# command line (OSC 633;E) and the folder (OSC 7), as bash's marks do (SessionLaunch.cs). Termilly starts nu with
# XDG_DATA_DIRS at shell/xdg first, so nu reads this after your config.nu. Settings > Terminal > Shell integration
# turns it off.

# Your XDG_DATA_DIRS is yours again, for this shell and what it starts.
if ($env.TERMILLY_USER_XDG_DATA_DIRS? | is-not-empty) {
    $env.XDG_DATA_DIRS = $env.TERMILLY_USER_XDG_DATA_DIRS
    hide-env TERMILLY_USER_XDG_DATA_DIRS
} else {
    hide-env -i XDG_DATA_DIRS
}

# Termilly's marks instead of nu's own, so the command's line surely comes before its start mark. nu's folder report
# (OSC 7) stays.
$env.config.shell_integration.osc133 = false
$env.config.shell_integration.osc633 = false
$env.config.shell_integration.osc7 = true

# Before each prompt: Termilly's agent folder first on PATH (your env.nu, macOS's path_helper too, put their own
# first), how the last command ended, and a prompt starts.
$env.config.hooks.pre_prompt = ($env.config.hooks.pre_prompt? | default [] | append {||
    let st = $env.LAST_EXIT_CODE
    let dir = ($env.TERMILLY_AGENT_DIR? | default "")
    let path = if ($env.PATH | describe) == "string" { $env.PATH | split row (char esep) } else { $env.PATH }
    $env.PATH = if $dir == "" or ($path | first) == $dir { $path } else { $path | where $it != $dir | prepend $dir }
    print -n $"\e]133;D;($st)\a\e]133;A\a"
})

# Before each command: its line (on one line: the mark ends at a newline), then the command starts. Not for an empty
# Enter.
$env.config.hooks.pre_execution = ($env.config.hooks.pre_execution? | default [] | append {||
    let line = (commandline)
    if ($line | str trim | is-not-empty) {
        print -n $"\e]633;E;($line | str replace -a "\n" ' ')\a\e]133;C\a"
    }
})
