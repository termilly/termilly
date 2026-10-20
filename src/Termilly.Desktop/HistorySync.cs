using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Termilly.Desktop.Security;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>Another device's synced history: its name, when it last wrote, and its commands.</summary>
internal sealed record DeviceHistory(string Name, long Updated, List<JsonObject> Entries);

/// <summary>A PC whose history is in the sync folder.</summary>
internal sealed record SyncDevice(string Id, string Name, long Updated, int Commands, bool Self);

/// <summary>What Settings shows about sync.</summary>
internal sealed record SyncStatus(bool Enabled, string? Folder, string? Error, long LastSync, IReadOnlyList<SyncDevice> Devices);

/// <summary>
/// Command history shared between PCs through a folder the user already syncs (OneDrive, Dropbox, a share):
/// each PC writes its own commands, sealed with a sync key, to its own file there and merges the other PCs'
/// files into its history. The key travels only as the sync code the user types on the other PC; here it's
/// kept sealed with the vault key. docs/history-sync.md has the design.
/// </summary>
internal sealed class HistorySync(Vault vault, CommandHistory history)
{
    private const string CheckText = "termilly-sync-1";
    private const string Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // base32 (RFC 4648)
    public const string FolderName = "Termilly sync";
    /// <summary>Each PC's file in the sync folder: its commands, sealed with the sync key.</summary>
    private const string DeviceExtension = ".tsh";
    /// <summary>The file in the sync folder that only the current sync key opens.</summary>
    private const string CheckFile = "key.check";
    /// <summary>The sync key: AES-256's.</summary>
    private const int KeyBytes = 32;
    private const int BitsPerByte = 8;
    /// <summary>A base32 letter carries five bits.</summary>
    private const int BitsPerLetter = 5;
    private const int LetterMask = (1 << BitsPerLetter) - 1;
    /// <summary>A sync code's letters (the key in base32), shown in groups of four.</summary>
    private const int CodeLength = (KeyBytes * BitsPerByte + BitsPerLetter - 1) / BitsPerLetter;
    private const int CodeGroup = 4;

    /// <summary>A PC's file's fields.</summary>
    private static class Fields
    {
        public const string Device = "device";
        public const string Name = "name";
        public const string Updated = "updated";
        public const string Entries = "entries";
    }

    private readonly Lock _gate = new();
    private readonly Dictionary<string, DateTime> _read = [];
    private int _writtenVersion = -1;
    private string? _error;
    private long _lastSync;

    private sealed record Config(string Folder, string DeviceId, string SealedKey);

    // Next to keys.json, not in history\: the vault takes any .json there for plain history from old versions.
    private string ConfigPath => vault.PathOf("sync.json");
    private static string DeviceName => Environment.GetEnvironmentVariable("TERMILLY_DEVICE_NAME") is { Length: > 0 } name ? name : Environment.MachineName;

    // ---- The sync code ----

    /// <summary>A key as a sync code: base32 in groups of four ("ABCD-EFGH-…").</summary>
    public static string ToCode(byte[] key)
    {
        var text = new StringBuilder();
        int buffer = 0, bits = 0;
        foreach (var b in key)
        {
            buffer = (buffer << BitsPerByte) | b;
            bits += BitsPerByte;
            while (bits >= BitsPerLetter)
            {
                text.Append(Alphabet[(buffer >> (bits - BitsPerLetter)) & LetterMask]);
                bits -= BitsPerLetter;
            }
        }
        if (bits > 0)
        {
            text.Append(Alphabet[(buffer << (BitsPerLetter - bits)) & LetterMask]);
        }
        return string.Join('-', text.ToString().Chunk(CodeGroup).Select(c => new string(c)));
    }

    /// <summary>The key a typed or pasted code stands for (case, spaces and dashes don't matter); null if it isn't one.</summary>
    public static byte[]? FromCode(string code)
    {
        var clean = new string(code.ToUpperInvariant().Where(c => !char.IsWhiteSpace(c) && c != '-').ToArray());
        if (clean.Length != CodeLength)
        {
            return null;
        }
        var key = new List<byte>();
        int buffer = 0, bits = 0;
        foreach (var c in clean)
        {
            var value = Alphabet.IndexOf(c);
            if (value < 0)
            {
                return null;
            }
            buffer = (buffer << BitsPerLetter) | value;
            bits += BitsPerLetter;
            if (bits >= BitsPerByte)
            {
                key.Add((byte)(buffer >> (bits - BitsPerByte)));
                bits -= BitsPerByte;
            }
        }
        return key.Count == KeyBytes ? [.. key] : null;
    }

    // ---- The folder ----

    /// <summary>Writes this PC's commands to its file in the sync folder.</summary>
    public static void WriteOwn(string syncDir, byte[] key, string deviceId, string name, IEnumerable<JsonObject> entries)
    {
        var data = new JsonObject
        {
            [Fields.Device] = deviceId,
            [Fields.Name] = name,
            [Fields.Updated] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            [Fields.Entries] = new JsonArray(entries.TakeLast(CommandHistory.MaxEntries).Select(e => (JsonNode)e.DeepClone()).ToArray()),
        };
        Directory.CreateDirectory(syncDir);
        AppPaths.WriteAtomically(Path.Combine(syncDir, deviceId + DeviceExtension), Sealed.Seal(key, data.ToJsonString()));
    }

    /// <summary>A PC's file: its name, when it was written, and its commands. Null when the key can't open it.</summary>
    public static DeviceHistory? ReadDevice(string file, byte[] key)
    {
        try
        {
            if (JsonNode.Parse(Sealed.OpenText(key, File.ReadAllBytes(file))) is not JsonObject data)
            {
                return null;
            }
            return new(data[Fields.Name]?.GetValue<string>() ?? "Another PC", data[Fields.Updated]?.GetValue<long>() ?? 0,
                (data[Fields.Entries] as JsonArray)?.OfType<JsonObject>().ToList() ?? []);
        }
        catch (Exception e) when (e is CryptographicException or JsonException or InvalidOperationException or FormatException)
        {
            return null;
        }
    }

    /// <summary>Whether the key opens the folder's key.check (so it's the folder's current sync code).</summary>
    public static bool KeyFits(string syncDir, byte[] key)
    {
        var check = Path.Combine(syncDir, CheckFile);
        try
        {
            return File.Exists(check) && Sealed.OpenText(key, File.ReadAllBytes(check)) == CheckText;
        }
        catch (CryptographicException)
        {
            return false;
        }
    }

    private static void WriteCheck(string syncDir, byte[] key)
    {
        Directory.CreateDirectory(syncDir);
        AppPaths.WriteAtomically(Path.Combine(syncDir, CheckFile), Sealed.Seal(key, CheckText));
    }

    private static string SyncDir(string folder) => Path.Combine(folder, FolderName);

    // ---- This PC's settings ----

    private Config? LoadConfig()
    {
        try
        {
            return File.Exists(ConfigPath) ? JsonSerializer.Deserialize<Config>(File.ReadAllText(ConfigPath)) : null;
        }
        catch (Exception e) when (e is IOException or JsonException)
        {
            return null;
        }
    }

    private byte[] VaultKey => vault.Key ?? throw new IOException("History is locked.");

    private byte[] KeyOf(Config config) => Sealed.Open(VaultKey, Convert.FromBase64String(config.SealedKey));

    private void SaveConfig(string folder, string deviceId, byte[] key)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(ConfigPath)!);
        File.WriteAllText(ConfigPath, JsonSerializer.Serialize(new Config(folder, deviceId, Convert.ToBase64String(Sealed.Seal(VaultKey, key)))));
        _read.Clear();
        _writtenVersion = -1;
        _error = null;
    }

    /// <summary>Forgets what was read and written (after the vault changed), so the next sync starts over.</summary>
    public void Reset()
    {
        lock (_gate)
        {
            _read.Clear();
            _writtenVersion = -1;
            _error = null;
            _lastSync = 0;
        }
    }

    // ---- What Settings does ----

    /// <summary>Starts syncing into a folder that has no synced history yet; returns the sync code for the other PCs.</summary>
    public string TurnOn(string folder)
    {
        lock (_gate)
        {
            if (!Directory.Exists(folder))
            {
                throw new IOException("That folder doesn't exist.");
            }
            if (File.Exists(Path.Combine(SyncDir(folder), CheckFile)))
            {
                throw new IOException("This folder already has synced history. Join it with its sync code instead.");
            }
            var key = RandomNumberGenerator.GetBytes(KeyBytes);
            WriteCheck(SyncDir(folder), key);
            SaveConfig(folder, LoadConfig()?.DeviceId ?? Guid.NewGuid().ToString("N"), key);
            return ToCode(key);
        }
    }

    /// <summary>Joins the synced history in a folder with the code another PC showed.</summary>
    public void Join(string folder, string code)
    {
        lock (_gate)
        {
            var key = FromCode(code) ?? throw new IOException("That isn't a sync code (52 letters and digits).");
            if (!File.Exists(Path.Combine(SyncDir(folder), CheckFile)))
            {
                throw new IOException($"There's no synced history in that folder (no \"{FolderName}\" in it yet).");
            }
            if (!KeyFits(SyncDir(folder), key))
            {
                throw new IOException("That code doesn't fit this folder. It may have been replaced by a new one.");
            }
            SaveConfig(folder, LoadConfig()?.DeviceId ?? Guid.NewGuid().ToString("N"), key);
        }
    }

    /// <summary>The current sync code, to type on another PC.</summary>
    public string? Code()
    {
        lock (_gate)
        {
            return LoadConfig() is { } config ? ToCode(KeyOf(config)) : null;
        }
    }

    /// <summary>
    /// A new sync code: this PC's file and key.check are rewritten with it, and files the new key can't open (other
    /// PCs, until they enter the new code) are deleted, so a removed PC can't read anything written afterwards.
    /// </summary>
    public string Rotate()
    {
        lock (_gate)
        {
            var config = LoadConfig() ?? throw new IOException("Sync isn't on.");
            var dir = SyncDir(config.Folder);
            SyncNow(); // take in what the others wrote last, before their files go
            var key = RandomNumberGenerator.GetBytes(KeyBytes);
            WriteCheck(dir, key);
            WriteOwn(dir, key, config.DeviceId, DeviceName, history.OwnEntries());
            // The other PCs' files are sealed with the old key; each PC writes its own again once it has the new code.
            foreach (var file in Directory.EnumerateFiles(dir, "*" + DeviceExtension))
            {
                if (Path.GetFileNameWithoutExtension(file) != config.DeviceId)
                {
                    File.Delete(file);
                }
            }
            SaveConfig(config.Folder, config.DeviceId, key);
            return ToCode(key);
        }
    }

    /// <summary>Stops syncing on this PC; what was imported stays in its history.</summary>
    public void TurnOff()
    {
        lock (_gate)
        {
            File.Delete(ConfigPath);
            _read.Clear();
            _error = null;
        }
    }

    /// <summary>
    /// Writes this PC's file when it ran new commands, and merges the other PCs' files that changed since the last
    /// read. Returns how many commands came in.
    /// </summary>
    public int SyncNow()
    {
        lock (_gate)
        {
            var config = LoadConfig();
            if (config is null || vault.IsLocked)
            {
                return 0;
            }
            try
            {
                var dir = SyncDir(config.Folder);
                var key = KeyOf(config);
                if (!KeyFits(dir, key))
                {
                    _error = Directory.Exists(config.Folder)
                        ? "The sync code was replaced on another PC. Enter the new code to keep syncing."
                        : "The sync folder isn't there (is the drive connected?).";
                    return 0;
                }
                WriteOwnIfNew(dir, key, config.DeviceId);
                var imported = ImportOthers(dir, key, config.DeviceId);
                _error = null;
                _lastSync = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                return imported;
            }
            catch (Exception e) when (Storage.IsFileError(e) || e is CryptographicException)
            {
                _error = e.Message;
                return 0;
            }
        }
    }

    /// <summary>Writes this PC's own commands (under the lock), when there are new ones or its file is gone.</summary>
    private void WriteOwnIfNew(string dir, byte[] key, string deviceId)
    {
        if (_writtenVersion != history.OwnVersion || !File.Exists(Path.Combine(dir, deviceId + DeviceExtension)))
        {
            var version = history.OwnVersion;
            WriteOwn(dir, key, deviceId, DeviceName, history.OwnEntries());
            _writtenVersion = version;
        }
    }

    /// <summary>Reads the other PCs' files that changed since last time (under the lock); how many commands were new.</summary>
    private int ImportOthers(string dir, byte[] key, string deviceId)
    {
        var imported = 0;
        foreach (var file in Directory.EnumerateFiles(dir, "*" + DeviceExtension))
        {
            var id = Path.GetFileNameWithoutExtension(file);
            var modified = File.GetLastWriteTimeUtc(file);
            if (id == deviceId || (_read.TryGetValue(id, out var seen) && seen == modified))
            {
                continue;
            }
            if (ReadDevice(file, key) is { } device)
            {
                imported += history.Import(device.Entries, device.Name);
            }
            _read[id] = modified;
        }
        return imported;
    }

    public SyncStatus Status()
    {
        lock (_gate)
        {
            var config = LoadConfig();
            if (config is null)
            {
                return new SyncStatus(false, null, null, 0, []);
            }
            var devices = new List<SyncDevice>();
            try
            {
                var key = KeyOf(config);
                var dir = SyncDir(config.Folder);
                if (Directory.Exists(dir))
                {
                    foreach (var file in Directory.EnumerateFiles(dir, "*" + DeviceExtension))
                    {
                        var id = Path.GetFileNameWithoutExtension(file);
                        if (ReadDevice(file, key) is { } device)
                        {
                            devices.Add(new SyncDevice(id, device.Name, device.Updated, device.Entries.Count, id == config.DeviceId));
                        }
                    }
                }
            }
            catch (Exception e) when (Storage.IsFileError(e) || e is CryptographicException)
            {
                _error ??= e.Message;
            }
            return new SyncStatus(true, config.Folder, _error, _lastSync, devices.OrderByDescending(d => d.Self).ThenBy(d => d.Name).ToList());
        }
    }
}
