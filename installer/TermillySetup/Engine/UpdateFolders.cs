using System;
using System.IO;
using System.Threading;

namespace Termilly.Setup.Engine;

/// <summary>
/// The folders of an update at start (SupervisedUpdate) and every move between them. The old version stays as
/// <c>&lt;dir&gt;.old</c> until the new one reports healthy, so whatever is on disk says what to do next: a
/// <c>.old</c> with no confirmed marker means the update wasn't kept and the old version goes back. Each step is a
/// folder rename, safe to run again if it's cut off, and none of them ever leaves no Termilly at all.
/// </summary>
internal sealed class UpdateFolders
{
    private const string BackupSuffix = ".old";
    private const string StagingSuffix = ".new";
    /// <summary>The new version moved out of the way while the old one goes back.</summary>
    private const string AsideSuffix = ".cand";
    /// <summary>A kept old version on its way out; unique names, so a stuck one never blocks the next.</summary>
    private const string DiscardSuffix = ".old.delete-";
    private const string MarkerFile = "confirmed";
    private const int MoveTries = 10;
    private const int MoveRetryMs = 500;

    private readonly Func<string, string?> _versionOf;

    /// <param name="dir">The program folder.</param>
    /// <param name="versionOf">The version of the Termilly.exe in a folder, or null when there's none.</param>
    public UpdateFolders(string dir, Func<string, string?> versionOf)
    {
        Dir = Path.GetFullPath(dir).TrimEnd('\\');
        _versionOf = versionOf;
    }

    public string Dir { get; }
    public string Backup => Dir + BackupSuffix;
    public string Staging => Dir + StagingSuffix;
    private string Aside => Dir + AsideSuffix;
    /// <summary>Written once the new version is healthy, before the old one goes: it holds the version that was kept.</summary>
    private string Marker => Path.Combine(Dir + ".update", MarkerFile);

    /// <summary>
    /// Settles whatever an earlier update left: kept if it was confirmed, the old version back otherwise. True when
    /// the old version was put back.
    /// </summary>
    public bool Recover()
    {
        var rolledBack = false;
        if (Directory.Exists(Backup))
        {
            if (IsConfirmed())
            {
                Discard();
            }
            else
            {
                RollBack();
                rolledBack = true;
            }
        }
        else if (!HasApp(Dir))
        {
            // Cut off between renames with no old version left: whichever copy is there is better than none.
            if ((HasApp(Aside) || HasApp(Staging)) && Directory.Exists(Dir))
            {
                Move(Dir, Dir + DiscardSuffix + Guid.NewGuid().ToString("N"));
            }
            if (HasApp(Aside))
            {
                Move(Aside, Dir);
            }
            else if (HasApp(Staging))
            {
                Move(Staging, Dir);
            }
        }
        Tidy();
        return rolledBack;
    }

    /// <summary>The old version back in the program folder; the new one moved aside and removed.</summary>
    public void RollBack()
    {
        if (!Directory.Exists(Backup))
        {
            return;
        }
        if (Directory.Exists(Dir))
        {
            DeleteOrThrow(Aside);
            Move(Dir, Aside);
        }
        Move(Backup, Dir);
        TryDelete(Aside);
    }

    /// <summary>The new version is healthy: write that down first, then let the old one go.</summary>
    public void Confirm(string version)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Marker)!);
        var temp = Marker + ".tmp";
        File.WriteAllText(temp, version);
        if (File.Exists(Marker))
        {
            File.Delete(Marker);
        }
        File.Move(temp, Marker);
        Discard();
        Tidy();
    }

    /// <summary>Before a new update: no marker from an earlier one may vouch for it.</summary>
    public void ForgetConfirmed()
    {
        if (File.Exists(Marker))
        {
            File.Delete(Marker);
        }
    }

    /// <summary>Removes what's left over: the staging and aside folders and any old version on its way out.</summary>
    public void Tidy()
    {
        TryDelete(Staging);
        TryDelete(Aside);
        var parent = Path.GetDirectoryName(Dir)!;
        if (!Directory.Exists(parent))
        {
            return;
        }
        foreach (var discarded in Directory.GetDirectories(parent, Path.GetFileName(Dir) + DiscardSuffix + "*"))
        {
            TryDelete(discarded);
        }
    }

    private bool IsConfirmed() =>
        File.Exists(Marker) && _versionOf(Dir) is { } running && string.Equals(File.ReadAllText(Marker).Trim(), running, StringComparison.Ordinal);

    private bool HasApp(string dir) => Directory.Exists(dir) && _versionOf(dir) is not null;

    /// <summary>The old version renamed out of the way in one step, then removed as far as it can be.</summary>
    private void Discard()
    {
        var discarded = Dir + DiscardSuffix + Guid.NewGuid().ToString("N");
        Move(Backup, discarded);
        TryDelete(discarded);
    }

    /// <summary>A rename, tried again for a while when something (an antivirus scan) briefly holds the folder.</summary>
    private static void Move(string from, string to)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                Directory.Move(from, to);
                Log.Write($"moved {from} to {to}");
                return;
            }
            catch (Exception e) when ((e is IOException or UnauthorizedAccessException) && attempt < MoveTries)
            {
                Log.Write($"couldn't move {from} yet (try {attempt}): {e.Message}");
                Thread.Sleep(MoveRetryMs);
            }
        }
    }

    private static void DeleteOrThrow(string dir)
    {
        TryDelete(dir);
        if (Directory.Exists(dir))
        {
            throw new IOException($"{dir} is in use and can't be removed.");
        }
    }

    private static void TryDelete(string dir) => Folders.Delete(dir);
}
