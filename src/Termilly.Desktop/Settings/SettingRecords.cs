namespace Termilly.Desktop;

/// <summary>A theme's colours for the window and start-up loader (#RRGGBB), and whether it's a light theme.</summary>
internal sealed record ThemeWindowColors(string Background, string Frame, string Text, string Accent, bool Light);

/// <summary>One day in the agent cost ledger (js/cost.js): the total, and per workspace name.</summary>
internal sealed record CostDay(double Total, IReadOnlyDictionary<string, double>? Ws = null);

/// <summary>A saved command with {{placeholders}} (js/snippets.js); Enter pressed after it unless told not to.</summary>
internal sealed record SnippetSetting(
    string Id,
    string Name,
    string Command,
    string? Description = null,
    bool Enter = true);

/// <summary>
/// An environment terminals can be on (js/environments.js): production, staging. A terminal is on it when tagged
/// with its id, or its SSH host matches one of the glob patterns (*-prod*, 10.20.*).
/// </summary>
internal sealed record EnvironmentSetting(
    string Id,
    string Label,
    string Color,
    IReadOnlyList<string>? Patterns = null);

/// <summary>
/// A regular expression run over each new output line (js/triggers.js). Action: highlight, capture (highlight and
/// keep in the captured-lines panel), notify or attention. Scope: all, tag:&lt;name&gt; or profile:&lt;id&gt;.
/// </summary>
internal sealed record TriggerSetting(
    string Id,
    string Pattern,
    string Action = SettingValues.TriggerAction.Default,
    string Scope = SettingValues.TriggerScope.Default,
    bool Enabled = true,
    string? Name = null,
    string? Color = null,
    bool CaseSensitive = false);

/// <summary>A shell the user defined in Settings: any command line, with its own folder, variables and tags.</summary>
/// <param name="Icon">Badge to show: one of SettingValues.ProfileIcon.</param>
internal sealed record CustomProfile(
    string Id,
    string Name,
    string CommandLine,
    string? WorkingDirectory = null,
    IReadOnlyDictionary<string, string>? Environment = null,
    IReadOnlyList<string>? Tags = null,
    string Icon = SettingValues.ProfileIcon.Default);

/// <summary>
/// A web page or program started from Termilly (Actions.cs, js/actions.js): from the palette, a shortcut, or the
/// terminal's right-click menu. Target and Arguments may hold {placeholders} (ActionPlaceholders).
/// </summary>
/// <param name="Target">A web address (http://, https://, {repo}) or a program: a name on the PATH or a full path.</param>
/// <param name="Arguments">A program's arguments, split as a shell would.</param>
/// <param name="Shortcut">Keys that run it while Termilly has focus, as "Ctrl+Alt+B".</param>
/// <param name="Menu">On the terminal's right-click menu, when what it needs is there.</param>
internal sealed record ActionSetting(
    string Id,
    string Name,
    string Target,
    string? Arguments = null,
    string? Shortcut = null,
    bool Menu = false,
    bool Enabled = true);
