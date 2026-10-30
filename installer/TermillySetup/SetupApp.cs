using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;

namespace Termilly.Setup;

/// <summary>A command line's flags (Engine/SetupNames.cs Flags), matched without regard to case.</summary>
internal sealed class Arguments(IReadOnlyList<string> args)
{
    public bool Has(string flag) => args.Any(a => string.Equals(a, flag, StringComparison.OrdinalIgnoreCase));

    /// <summary>The value after <paramref name="flag"/>, or null.</summary>
    public string? Value(string flag)
    {
        var i = args.ToList().FindIndex(a => string.Equals(a, flag, StringComparison.OrdinalIgnoreCase));
        return i >= 0 && i + 1 < args.Count ? args[i + 1] : null;
    }
}

/// <summary>Facts about this run of setup.</summary>
internal static class SetupApp
{
    /// <summary>Setup's own exe (in a temp copy when uninstalling from the install folder).</summary>
    public static string ExePath { get; } = Process.GetCurrentProcess().MainModule!.FileName;

    public static Arguments Args { get; } = new(Environment.GetCommandLineArgs());

    public static bool Has(string flag) => Args.Has(flag);

    /// <summary>The value after <paramref name="flag"/>, or null.</summary>
    public static string? Value(string flag) => Args.Value(flag);

    /// <summary>The working folder setup was started in, for paths given relative to it (--dir .\Termilly).</summary>
    public static string StartFolder { get; private set; } = Environment.CurrentDirectory;

    /// <summary>
    /// Moves setup's working folder to the temp folder. Termilly's shortcut starts it in its install folder and an
    /// update inherits that: while a process sits in the install folder, Windows won't let setup swap it.
    /// </summary>
    public static void LeaveStartFolder()
    {
        StartFolder = Environment.CurrentDirectory;
        Environment.CurrentDirectory = System.IO.Path.GetTempPath();
    }
}
