using System.IO;

namespace Termilly.Desktop.Tests;

/// <summary>
/// What a shell command changed (ShellWatch.cs), when a watcher's reports come late: here the watchers are stopped
/// before the command writes, and the test reports for them.
/// </summary>
public sealed class ShellWatchTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("termilly-shellwatch-").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private ShellWatch Begin()
    {
        var budget = new CopyBudget(ShellWatch.MaxCopyBytes, ShellWatch.MaxCopyBytes, TimeSpan.FromSeconds(1), _ => false);
        var watch = ShellWatch.Begin([], _dir, [], copy: false, budget);
        watch.Dispose(); // no reports of its own: the test makes them
        return watch;
    }

    [Fact]
    public void A_file_written_beside_a_reported_one_is_found_though_its_own_report_never_came()
    {
        var deep = Directory.CreateDirectory(Path.Combine(_dir, "src", "api")).FullName;
        var old = Path.Combine(deep, "old.ts");
        File.WriteAllText(old, "1");
        File.SetLastWriteTimeUtc(old, DateTime.UtcNow.AddHours(-1));
        var watch = Begin();

        var handler = Path.Combine(deep, "handler.ts");
        var added = Path.Combine(deep, "added.ts");
        File.WriteAllText(handler, "2");
        File.WriteAllText(added, "3");
        watch.Reported(handler, false);

        var found = watch.Changes();

        Assert.Equal([added, handler], found.Keys.Order(StringComparer.OrdinalIgnoreCase));
        Assert.False(found[added]); // git says whether it's new
    }

    [Fact]
    public void Without_a_report_a_subfolder_is_not_looked_through()
    {
        var deep = Directory.CreateDirectory(Path.Combine(_dir, "src")).FullName;
        var watch = Begin();

        File.WriteAllText(Path.Combine(deep, "quiet.ts"), "1");

        Assert.Empty(watch.Changes());
    }
}
