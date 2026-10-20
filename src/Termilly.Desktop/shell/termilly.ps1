# Termilly shell integration for PowerShell: marks where each prompt and command starts and ends (OSC 133, the
# FinalTerm marks Windows Terminal and VS Code use), so Termilly knows when a command is running even when it starts
# no process (Start-Sleep, a long foreach). Termilly loads it after your profile; it keeps your prompt as it is.
# Settings > Terminal > Shell integration turns it off.

if ($env:TERMILLY_SHELL_INTEGRATION -ne '1' -or $Host.Name -ne 'ConsoleHost' -or $global:__termilly) { return }
$global:__termilly = @{ Prompt = $function:prompt; Running = $false }
# Windows PowerShell 5.1 writes in the console's code page, so emoji and other non-ANSI characters arrive as ??.
# pwsh 7 already writes UTF-8.
if ($PSVersionTable.PSEdition -eq 'Desktop') {
    try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
}

function global:prompt {
    $ok = $?
    $code = $global:LASTEXITCODE
    $esc = [char]27; $bel = [char]7
    $marks = ''
    if ($global:__termilly.Running) {
        $global:__termilly.Running = $false
        # A failed native program sets LASTEXITCODE; a failed cmdlet doesn't, and then an old code would mislead.
        $status = if ($ok) { 0 } elseif ($code -ne $global:__termilly.CodeBefore -and $code) { $code } else { 1 }
        $marks += "$esc]133;D;$status$bel"
    }
    # Termilly's agent folder first on PATH, so `claude` is its shim: a login pwsh reads ~/.profile, which may put
    # ~/.local/bin first. TERMILLY_AGENT_DIR is only set off Windows.
    $agent = $env:TERMILLY_AGENT_DIR
    if ($agent -and -not $env:PATH.StartsWith("$agent$([IO.Path]::PathSeparator)")) {
        $env:PATH = "$agent$([IO.Path]::PathSeparator)$env:PATH"
    }
    # The working folder (OSC 7), for Termilly's recent folders: /C:/dir on Windows, /home/dir elsewhere.
    $location = $executionContext.SessionState.Path.CurrentLocation
    if ($location.Provider.Name -eq 'FileSystem') {
        if ($IsLinux -or $IsMacOS) {
            $marks += "$esc]7;file://$([Environment]::MachineName)$($location.ProviderPath)$bel"
        } else {
            $marks += "$esc]7;file://$env:COMPUTERNAME/$($location.ProviderPath -replace '\\', '/')$bel"
        }
    }
    $marks += "$esc]133;A$bel"
    $text = & $global:__termilly.Prompt
    $global:LASTEXITCODE = $code
    "$marks$text$esc]133;B$bel"
}

# PowerShell has no hook before a command runs, so Enter marks it: once the line is complete (an unfinished
# block gets a new line instead) and not blank.
if (Get-Module PSReadLine) {
    Set-PSReadLineKeyHandler -Key Enter -BriefDescription 'AcceptLine (Termilly marks the command start)' -ScriptBlock {
        $line = $null; $cursor = $null
        [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
        $errors = $null
        [void][System.Management.Automation.Language.Parser]::ParseInput($line, [ref]$null, [ref]$errors)
        $complete = -not ($errors | Where-Object { $_.IncompleteInput })
        [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
        if ($complete -and $line.Trim()) {
            $global:__termilly.Running = $true
            $global:__termilly.CodeBefore = $global:LASTEXITCODE
            [Console]::Write("$([char]27)]133;C$([char]7)")
        }
    }
}
