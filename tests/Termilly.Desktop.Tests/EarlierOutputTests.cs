using System.IO;
using Termilly.Desktop.Security;

namespace Termilly.Desktop.Tests;

public sealed class EarlierOutputTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "termilly-tests", Guid.NewGuid().ToString("N"));
    private readonly Vault _vault;
    private readonly EarlierOutput _earlier;

    public EarlierOutputTests()
    {
        _vault = Vault.Open(_dir);
        _earlier = new EarlierOutput(_vault);
    }

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private string FileOf(string id) => Path.Combine(_vault.HistoryDirectory, "earlier", id + ".tme");

    [Fact]
    public void Lines_are_kept_encrypted_in_order_and_read_back_after_a_restart()
    {
        _earlier.Append("t1", ["server on http://192.168.0.108:8790/", "first"], redactSecrets: false);
        _earlier.Append("t1", ["second"], redactSecrets: false);

        var again = new EarlierOutput(_vault); // as after a restart
        Assert.Equal(["server on http://192.168.0.108:8790/", "first", "second"], again.Lines("t1"));
        Assert.Equal(["second"], again.Tail("t1", 1));
        Assert.DoesNotContain("8790", File.ReadAllText(FileOf("t1")));
    }

    [Fact]
    public void Secrets_are_taken_out_when_settings_ask()
    {
        _earlier.Append("t1", ["export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789"], redactSecrets: true);
        Assert.DoesNotContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789", _earlier.Lines("t1")[0]);
    }

    [Fact]
    public void Search_gives_the_lines_around_each_match_with_gaps_between_runs_and_the_count()
    {
        var lines = Enumerable.Range(0, 100).Select(i => $"line {i}").ToList();
        lines[10] = "the address is 192.168.0.108:8790";
        lines[60] = "again: 192.168.0.108";
        _earlier.Append("t1", lines, redactSecrets: false);
        _earlier.Append("t2", ["nothing here"], redactSecrets: false);

        var hit = Assert.Single(_earlier.Search("192.168.0.108"));
        Assert.Equal(("t1", 2), (hit.Id, hit.Count));
        Assert.Equal("line 1", hit.Lines[0]); // 9 before the first match
        Assert.Contains(EarlierOutput.Gap, hit.Lines);
        Assert.Equal("line 72", hit.Lines[^1]); // 12 after the last
        Assert.Equal(2 * (EarlierOutput.Before + 1 + EarlierOutput.After) + 1, hit.Lines.Count);
        Assert.Empty(_earlier.Search("  "));
        Assert.Single(_earlier.Search("ADDRESS")); // not case-sensitive
    }

    [Fact]
    public void A_reopened_terminal_takes_the_earlier_output_and_deleting_or_keeping_others_removes_it()
    {
        _earlier.Append("closed", ["kept"], redactSecrets: false);
        _earlier.Append("other", ["gone"], redactSecrets: false);
        _earlier.Append("open", ["stays"], redactSecrets: false);

        _earlier.Move("closed", "reopened");
        Assert.Equal(["kept"], _earlier.Lines("reopened"));
        Assert.Empty(_earlier.Lines("closed"));

        _earlier.KeepOnly(new HashSet<string> { "reopened", "open" });
        Assert.Empty(_earlier.Lines("other"));
        _earlier.Delete("open");
        Assert.Equal(["reopened"], _earlier.Ids());
    }

    [Fact]
    public void Old_chunks_go_by_the_history_setting_and_forever_keeps_them()
    {
        _earlier.Append("t1", ["now"], redactSecrets: false);
        _earlier.Prune(SettingValues.HistoryDays.Forever);
        _earlier.Prune(30);
        Assert.Equal(["now"], _earlier.Lines("t1")); // nothing is old yet
    }

    [Fact]
    public void A_damaged_end_is_ignored_and_the_rest_still_read()
    {
        _earlier.Append("t1", ["whole"], redactSecrets: false);
        File.AppendAllText(FileOf("t1"), "garbage");
        Assert.Equal(["whole"], new EarlierOutput(_vault).Lines("t1"));
        _earlier.Append("../evil", ["x"], redactSecrets: false);
        Assert.Equal(["t1"], _earlier.Ids());
    }
}
