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
}
