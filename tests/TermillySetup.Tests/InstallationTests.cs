using System;
using System.IO;
using Termilly.Setup.Engine;

namespace TermillySetup.Tests;

/// <summary>Putting the new files in place of the old ones while something may still have the old folder open.</summary>
public class InstallationTests
{
    [Fact]
    public void A_folder_in_use_is_left_as_it_was_and_swapped_once_it_is_free()
    {
        var root = Path.Combine(Path.GetTempPath(), "termilly-swap-" + Guid.NewGuid().ToString("N"));
        var dir = Path.Combine(root, "Termilly");
        var staging = dir + ".new";
        var backup = dir + ".old";
        try
        {
            Directory.CreateDirectory(dir);
            Directory.CreateDirectory(staging);
            File.WriteAllText(Path.Combine(dir, "version.txt"), "old");
            File.WriteAllText(Path.Combine(staging, "version.txt"), "new");

            // Termilly still closing: one of its files is open.
            using (new FileStream(Path.Combine(dir, "version.txt"), FileMode.Open, FileAccess.Read, FileShare.None))
            {
                Assert.False(Installation.TrySwap(dir, staging, backup, 1));
                Assert.True(Directory.Exists(staging));
            }
            Assert.Equal("old", File.ReadAllText(Path.Combine(dir, "version.txt")));

            Assert.True(Installation.TrySwap(dir, staging, backup, 2));
            Assert.Equal("new", File.ReadAllText(Path.Combine(dir, "version.txt")));
            Assert.Equal("old", File.ReadAllText(Path.Combine(backup, "version.txt")));
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }
}
