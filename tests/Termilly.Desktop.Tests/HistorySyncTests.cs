using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Termilly.Desktop.Security;

namespace Termilly.Desktop.Tests;

// Two "PCs" are two data folders, each with its own history and sync; they share one sync folder. The device name
// is process-wide (TERMILLY_DEVICE_NAME), so these run one at a time with the others that set variables.
[Collection("Environment")]
public sealed class HistorySyncTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "termilly-tests", Guid.NewGuid().ToString("N"));
    private readonly Vault _office;
    private readonly Vault _laptop;
    private string Shared => Path.Combine(_root, "OneDrive");
    private CommandHistory _history = null!;
    private HistorySync _sync = null!;

    public HistorySyncTests()
    {
        Directory.CreateDirectory(Shared);
        _office = Vault.Open(Path.Combine(_root, "office"));
        _laptop = Vault.Open(Path.Combine(_root, "laptop"));
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable("TERMILLY_DEVICE_NAME", null);
        Directory.Delete(_root, recursive: true);
    }

    /// <summary>Works on one PC from here on: its own history and sync, as after a restart there.</summary>
    private void On(Vault pc, string name)
    {
        Environment.SetEnvironmentVariable("TERMILLY_DEVICE_NAME", name);
        _history = new CommandHistory(pc);
        _sync = new HistorySync(pc, _history);
    }

    private void Run(string command) =>
        _history.Add(JsonDocument.Parse(new JsonObject { ["command"] = command, ["exitCode"] = 0, ["cwd"] = @"C:\work" }.ToJsonString()).RootElement, redactSecrets: false);

    private List<(string Command, string? Host)> History() =>
        JsonNode.Parse(_history.List(30))!.AsArray().Select(e => (e!["command"]!.GetValue<string>(), e["host"]?.GetValue<string>())).ToList();

    [Fact]
    public void A_sync_code_stands_for_its_key()
    {
        var key = Enumerable.Range(0, 32).Select(i => (byte)(i * 7)).ToArray();
        var code = HistorySync.ToCode(key);

        Assert.Equal(52 + 12, code.Length); // 13 groups of four
        Assert.Equal(key, HistorySync.FromCode(code.ToLowerInvariant().Replace("-", " ")));
        Assert.Null(HistorySync.FromCode("ABCD-1234"));
        Assert.Null(HistorySync.FromCode(code.Replace(code[0], '1'))); // 1 isn't in base32
    }

    [Fact]
    public void Two_PCs_see_each_others_commands_and_the_folder_has_no_readable_text()
    {
        On(_office, "OFFICE-PC");
        Run("npm run build");
        var code = _sync.TurnOn(Shared);
        _sync.SyncNow();

        On(_laptop, "LAPTOP");
        Run("git pull --rebase");
        Assert.Throws<IOException>(() => _sync.Join(Shared, HistorySync.ToCode(new byte[32])));
        _sync.Join(Shared, code);
        Assert.Equal(1, _sync.SyncNow());
        Assert.Contains(("npm run build", "OFFICE-PC"), History());
        Assert.Contains(("git pull --rebase", null), History());

        On(_office, "OFFICE-PC");
        Assert.Equal(1, _sync.SyncNow());
        Assert.Contains(("git pull --rebase", "LAPTOP"), History());
        Assert.Equal(0, _sync.SyncNow()); // nothing new: nothing imported twice

        var status = _sync.Status();
        Assert.Equal(["OFFICE-PC", "LAPTOP"], status.Devices.Select(d => d.Name));
        Assert.True(status.Devices[0].Self);

        foreach (var file in Directory.EnumerateFiles(Shared, "*", SearchOption.AllDirectories))
        {
            var text = Encoding.Latin1.GetString(File.ReadAllBytes(file));
            Assert.DoesNotContain("npm", text);
            Assert.DoesNotContain("git", text);
            Assert.DoesNotContain("LAPTOP", Path.GetFileName(file) + text);
            Assert.DoesNotContain("work", text);
        }
    }

    [Fact]
    public void A_new_code_shuts_out_the_other_PCs_until_they_enter_it()
    {
        On(_office, "OFFICE-PC");
        var code = _sync.TurnOn(Shared);
        On(_laptop, "LAPTOP");
        _sync.Join(Shared, code);
        Run("ls");
        _sync.SyncNow();

        On(_office, "OFFICE-PC");
        var newCode = _sync.Rotate();
        Assert.Contains(("ls", "LAPTOP"), History()); // merged before the laptop's file went
        Assert.Single(Directory.EnumerateFiles(Path.Combine(Shared, HistorySync.FolderName), "*.tsh"));

        On(_laptop, "LAPTOP");
        _sync.SyncNow();
        Assert.Contains("replaced", _sync.Status().Error);
        Assert.Throws<IOException>(() => _sync.Join(Shared, code));
        _sync.Join(Shared, newCode);
        _sync.SyncNow();
        Assert.Null(_sync.Status().Error);
        Assert.Equal(2, _sync.Status().Devices.Count);
    }

    [Fact]
    public void Sync_stays_on_after_a_restart()
    {
        On(_office, "OFFICE-PC");
        _sync.TurnOn(Shared);

        On(Vault.Open(Path.Combine(_root, "office")), "OFFICE-PC"); // the next start opens the vault again

        Assert.True(_sync.Status().Enabled);
    }

    [Fact]
    public void A_folder_that_already_syncs_must_be_joined_not_turned_on()
    {
        On(_office, "OFFICE-PC");
        _sync.TurnOn(Shared);
        On(_laptop, "LAPTOP");
        Assert.Throws<IOException>(() => _sync.TurnOn(Shared));
    }
}
