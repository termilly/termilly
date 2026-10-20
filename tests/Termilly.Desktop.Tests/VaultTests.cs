using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Termilly.Desktop.Security;

namespace Termilly.Desktop.Tests;

public sealed class VaultTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "termilly-tests", Guid.NewGuid().ToString("N"));

    public VaultTests() => Directory.CreateDirectory(_dir);

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    [Fact]
    public void Sealed_round_trips_and_hides_the_plaintext()
    {
        var key = RandomNumberGenerator.GetBytes(32);
        var blob = Sealed.Seal(key, "ghp_secret-output");
        Assert.DoesNotContain("ghp_secret", Encoding.UTF8.GetString(blob));
        Assert.Equal("ghp_secret-output", Sealed.OpenText(key, blob));
    }

    [Fact]
    public void Sealed_rejects_a_changed_byte_and_the_wrong_key()
    {
        var key = RandomNumberGenerator.GetBytes(32);
        var blob = Sealed.Seal(key, "hello");
        blob[^1] ^= 1;
        Assert.ThrowsAny<CryptographicException>(() => Sealed.Open(key, blob));
        Assert.ThrowsAny<CryptographicException>(() => Sealed.Open(RandomNumberGenerator.GetBytes(32), Sealed.Seal(key, "hello")));
    }

    [Fact]
    public void A_new_vault_unlocks_silently_next_time()
    {
        var first = Vault.Open(_dir);
        Assert.True(first.IsNew);
        var second = Vault.Open(_dir);
        Assert.False(second.IsLocked);
        Assert.False(second.IsNew);
        Assert.Equal(first.Key, second.Key);
        Assert.Matches("^([A-Z2-9]{4}-){5}[A-Z2-9]{4}$", second.RecoveryCode()!);
    }

    [Fact]
    public void Plain_files_from_older_versions_are_encrypted_and_removed()
    {
        File.WriteAllText(Path.Combine(_dir, "workspaces.json"), """{"marker":"plain-workspaces"}""");
        Directory.CreateDirectory(Path.Combine(_dir, "history"));
        File.WriteAllText(Path.Combine(_dir, "history", "h1.json"), """{"id":"h1","lines":["plain-history"]}""");

        var vault = Vault.Open(_dir);

        Assert.False(File.Exists(Path.Combine(_dir, "workspaces.json")));
        Assert.False(File.Exists(Path.Combine(_dir, "history", "h1.json")));
        var workspaces = File.ReadAllBytes(vault.WorkspacesPath);
        var history = File.ReadAllBytes(Path.Combine(_dir, "history", "h1.tmh"));
        Assert.DoesNotContain("plain-", Encoding.UTF8.GetString(workspaces) + Encoding.UTF8.GetString(history));
        Assert.Contains("plain-workspaces", Sealed.OpenText(vault.Key!, workspaces));
        Assert.Contains("plain-history", Sealed.OpenText(vault.Key!, history));
    }

    [Fact]
    public void After_the_account_key_is_lost_the_recovery_code_unlocks_and_relocks()
    {
        var original = Vault.Open(_dir);
        var code = original.RecoveryCode()!;
        AppPaths.WriteAtomically(original.WorkspacesPath, Sealed.Seal(original.Key!, "kept"));
        LoseAccountKey();

        var locked = Vault.Open(_dir);
        Assert.True(locked.IsLocked);
        Assert.False(locked.TryRecover("AAAA-BBBB-CCCC-DDDD-EEEE-FFFF"));
        Assert.True(locked.TryRecover(code.ToLowerInvariant().Replace("-", " ")));
        Assert.Equal("kept", Sealed.OpenText(locked.Key!, File.ReadAllBytes(locked.WorkspacesPath)));

        var reopened = Vault.Open(_dir); // re-locked to the account: silent again
        Assert.False(reopened.IsLocked);
        Assert.Equal(code, reopened.RecoveryCode());
    }

    [Fact]
    public void Start_fresh_sets_old_data_aside_and_the_code_brings_its_history_back()
    {
        var original = Vault.Open(_dir);
        var code = original.RecoveryCode()!;
        AppPaths.WriteAtomically(Path.Combine(original.HistoryDirectory, "h1.tmh"), Sealed.Seal(original.Key!, "old-entry"));
        LoseAccountKey();

        var locked = Vault.Open(_dir);
        locked.StartFresh();
        Assert.False(locked.IsLocked);
        Assert.True(locked.IsNew);
        Assert.Single(locked.Archives);
        Assert.False(File.Exists(Path.Combine(locked.HistoryDirectory, "h1.tmh")));

        Assert.Equal(-1, locked.RestoreArchives("AAAA-BBBB-CCCC-DDDD-EEEE-FFFF"));
        Assert.Equal(1, locked.RestoreArchives(code));
        Assert.Empty(locked.Archives);
        Assert.Equal("old-entry", Sealed.OpenText(locked.Key!, File.ReadAllBytes(Path.Combine(locked.HistoryDirectory, "h1.tmh"))));
    }

    [Fact]
    public void A_regenerated_code_replaces_the_old_one()
    {
        var vault = Vault.Open(_dir);
        var old = vault.RecoveryCode()!;
        var fresh = vault.RegenerateRecoveryCode();
        Assert.NotEqual(old, fresh);
        LoseAccountKey();

        var locked = Vault.Open(_dir);
        Assert.False(locked.TryRecover(old));
        Assert.True(locked.TryRecover(fresh));
    }

    /// <summary>What an admin password reset does: the account can no longer decrypt its DPAPI blobs.</summary>
    private void LoseAccountKey()
    {
        var path = Path.Combine(_dir, "keys.json");
        var keys = JsonNode.Parse(File.ReadAllText(path))!;
        keys["dpapiKey"] = Convert.ToBase64String(RandomNumberGenerator.GetBytes(200));
        keys["dpapiCode"] = Convert.ToBase64String(RandomNumberGenerator.GetBytes(200));
        File.WriteAllText(path, keys.ToJsonString());
    }
}
