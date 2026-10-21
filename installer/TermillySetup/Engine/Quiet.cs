using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using Termilly.Setup;

namespace Termilly.Setup.Engine;

/// <summary>
/// Install or uninstall without the wizard, for scripts and IT tools:
/// <code>
/// TermillySetup.exe --quiet [--all-users] [--dir PATH] [--desktop] [--no-path] [--sign-in] [--offline]
///                   [--no-start-menu] [--no-explorer] [--no-agent] [--start]
/// TermillySetup.exe --uninstall --quiet [--remove-data]
/// </code>
/// <c>--start</c> starts Termilly once it's installed (an update from inside Termilly uses it).
/// Exit codes: 0 done, 1 failed (see the log in %TEMP%\TermillySetup-*), 740 needs to run as administrator.
/// </summary>
internal static class Quiet
{
    public static int Run()
    {
        try
        {
            return SetupApp.Has(Flags.Uninstall) ? Uninstall(SetupApp.Args) : Install(SetupApp.Args);
        }
        catch (Exception e)
        {
            Log.Write($"quiet {(SetupApp.Has(Flags.Uninstall) ? "uninstall" : "install")} failed: {e}");
            return ExitCodes.Failed;
        }
    }

    private static int Uninstall(Arguments args)
    {
        var installed = InstalledTermilly.Find();
        if (installed is null)
        {
            Log.Write("quiet uninstall: Termilly isn't installed");
            return ExitCodes.Done;
        }
        if (installed.AllUsers && !Elevation.IsElevated)
        {
            return WindowsCodes.ElevationRequired;
        }
        // Apps & features runs the copy in the install folder, which can't delete itself: a temp copy does it.
        var root = Path.GetFullPath(installed.Dir).TrimEnd('\\') + "\\";
        if (Path.GetFullPath(SetupApp.ExePath).StartsWith(root, StringComparison.OrdinalIgnoreCase))
        {
            var copy = Path.Combine(Log.Folder, InstalledFiles.Setup);
            Directory.CreateDirectory(Log.Folder);
            Payload.WriteProgramOf(SetupApp.ExePath, copy);
            var childArgs = $"{Flags.Uninstall} {Flags.Quiet}" + (args.Has(Flags.RemoveData) ? $" {Flags.RemoveData}" : "");
            using var child = Process.Start(new ProcessStartInfo(copy, childArgs) { UseShellExecute = false })!;
            child.WaitForExit();
            return child.ExitCode;
        }
        Uninstallation.UninstallAsync(installed, keepData: !args.Has(Flags.RemoveData), (text, _) => Log.Write(text), CancellationToken.None)
            .GetAwaiter().GetResult();
        return ExitCodes.Done;
    }

    private static int Install(Arguments args)
    {
        var payload = Payload.Open(SetupApp.ExePath);
        if (payload is null)
        {
            Log.Write("quiet install: this setup has nothing to install");
            return ExitCodes.Failed;
        }
        var options = Apply(InstalledTermilly.Find()?.Options ?? new SetupOptions(), args);
        if (options.AllUsers && !Elevation.IsElevated)
        {
            return WindowsCodes.ElevationRequired;
        }
        try
        {
            new Installation(payload, options).InstallAsync(p => Log.Write($"{p.Step}: {p.Text}"), CancellationToken.None).GetAwaiter().GetResult();
        }
        finally
        {
            // An update from inside Termilly closed it to run this: it opens again either way, the new version or,
            // if installing failed, whatever is there, rather than leaving the user without it.
            if (args.Has(Flags.Start))
            {
                Processes.StartTermilly(options.InstallDir);
            }
        }
        return ExitCodes.Done;
    }

    /// <summary>
    /// The options a quiet install uses: what was installed before (or the defaults), changed by the flags. A flag
    /// only turns its option on or off; leaving it out keeps the option as it was.
    /// </summary>
    public static SetupOptions Apply(SetupOptions options, Arguments args)
    {
        if (args.Has(Flags.AllUsers))
        {
            options.AllUsers = true;
            options.InstallDir = SetupOptions.DefaultDir(true);
        }
        if (args.Value(Flags.Dir) is { } dir)
        {
            options.InstallDir = Environment.ExpandEnvironmentVariables(dir);
        }
        options.StartMenu &= !args.Has(Flags.NoStartMenu);
        options.Desktop |= args.Has(Flags.Desktop);
        options.ExplorerMenu &= !args.Has(Flags.NoExplorer);
        options.PathCommand = (options.PathCommand || args.Has(Flags.Path)) && !args.Has(Flags.NoPath);
        options.AgentIntegration &= !args.Has(Flags.NoAgent);
        options.BackgroundAtSignIn |= args.Has(Flags.SignIn);
        options.PreferIncluded |= args.Has(Flags.Offline);
        return options;
    }
}
