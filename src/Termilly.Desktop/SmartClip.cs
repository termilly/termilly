using System.IO;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Security;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>What a clip is: each has its icon on the page.</summary>
internal static class ClipKinds
{
    public const string Text = "text";
    /// <summary>A command line: only the page says so (a command copied from history), as text can't tell.</summary>
    public const string Command = "command";
    public const string Path = "path";
    public const string Url = "url";
    public const string Image = "image";
    /// <summary>Text the redaction rules mask: shown masked, never written to disk, forgotten after a while.</summary>
    public const string Secret = "secret";
    public static readonly IReadOnlyList<string> All = [Text, Command, Path, Url, Image, Secret];
}

/// <summary>
/// A clip: its text (none for an image), where it was copied, when (Unix ms), an image's size and hash, and whether a
/// path is a folder (true), a file (false) or wasn't found (null), as it was when copied.
/// </summary>
internal sealed record Clip(string Id, string Kind, string Text, string Source, long At, bool Pinned = false, int Width = 0, int Height = 0, long Bytes = 0, string? Hash = null, bool? Folder = null);

/// <summary>
/// Smart Clip's clips, newest first: text and images copied in Termilly or (on Windows) anywhere, with the same copy
/// made again moved to the top instead of kept twice. Pinned clips are never dropped; the oldest of the others go past
/// <see cref="Limit"/> (and past <see cref="MaxImages"/> images). Kept after a restart encrypted with the vault, images
/// each in a file of their own read when first asked for; secrets and long clips stay in memory only.
/// </summary>
internal sealed partial class ClipStore(Vault vault)
{
    /// <summary>Copies bigger than this aren't kept: a clip is for pasting, not a log.</summary>
    public const int MaxTextChars = 1_000_000;
    /// <summary>
    /// Text longer than this is a long clip: only the newest few are kept, and only until Termilly closes, so the
    /// clips written to disk stay small.
    /// </summary>
    public const int LongChars = 100_000;
    public const int MaxLong = 5;
    public const int MaxImageBytes = 16 * 1024 * 1024;
    public const int MaxImages = 20;
    /// <summary>The most of a clip's text the page gets to show.</summary>
    public const int ShownChars = 2_000;
    /// <summary>Where a clip comes from when the system clipboard told: copied in another app, or in Termilly's own text boxes.</summary>
    public const string ClipboardSource = "Clipboard";
    /// <summary>How long a secret is kept.</summary>
    public static readonly TimeSpan SecretLife = TimeSpan.FromMinutes(10);
    private const string ListFile = "clips.tmw";
    private const string ImageFolder = "clips";
    private const string ImageExtension = ".tmw";
    private const int IdLength = 12;
    /// <summary>The longest text taken as a path or a link (one line).</summary>
    private const int MaxLinkChars = 1_000;
    /// <summary>The longest line looked at for a secret.</summary>
    private const int MaxSecretLine = 2_000;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly Lock _lock = new();
    private readonly Dictionary<string, byte[]> _images = [];
    private List<Clip> _clips = [];
    private bool _loaded;

    /// <summary>The most clips kept that aren't pinned (Settings › Terminal › Smart Clip).</summary>
    public int Limit { get; set; } = SettingValues.ClipLimit.Default;

    /// <summary>Whether clips are kept after a restart; off, nothing is written and what was is deleted.</summary>
    public bool Persist { get; set; } = true;

    private string ListPath => vault.PathOf(ListFile);
    private string ImageDir => vault.PathOf(ImageFolder);
    private string ImagePath(string id) => Path.Combine(ImageDir, id + ImageExtension);

    /// <summary>
    /// Keeps a copy of text; false when nothing changed (empty, too big, or already the newest with nothing new). Copied
    /// again, a clip moves to the top and keeps where it came from unless the new copy says better than "Clipboard".
    /// </summary>
    public bool AddText(string text, string source, string? kind, long now)
    {
        if (string.IsNullOrWhiteSpace(text) || text.Length > MaxTextChars)
        {
            return false;
        }
        var classified = Classify(text, kind);
        lock (_lock)
        {
            var same = _clips.FindIndex(c => c.Kind != ClipKinds.Image && c.Text == text);
            if (same >= 0)
            {
                return MoveToTop(same, source, classified, now);
            }
            _clips.Insert(0, new Clip(NewId(), classified, text, source, now, Folder: classified == ClipKinds.Path ? IsFolder(text) : null));
            Trim();
            return true;
        }
    }

    /// <summary>Keeps a copy of an image (PNG); the same picture copied again moves to the top.</summary>
    public bool AddImage(byte[] png, int width, int height, string source, long now)
    {
        if (png.Length == 0 || png.Length > MaxImageBytes)
        {
            return false;
        }
        var hash = Convert.ToHexString(SHA256.HashData(png));
        lock (_lock)
        {
            var same = _clips.FindIndex(c => c.Hash == hash);
            if (same >= 0)
            {
                return MoveToTop(same, source, ClipKinds.Image, now);
            }
            var clip = new Clip(NewId(), ClipKinds.Image, string.Empty, source, now, Width: width, Height: height, Bytes: png.Length, Hash: hash);
            _clips.Insert(0, clip);
            _images[clip.Id] = png;
            WriteImage(clip.Id, png);
            Trim();
            return true;
        }
    }

    private bool MoveToTop(int index, string source, string kind, long now)
    {
        var old = _clips[index];
        var better = source != ClipboardSource && source.Length > 0 && source != old.Source;
        if (index == 0 && !better)
        {
            return false;
        }
        _clips.RemoveAt(index);
        _clips.Insert(0, old with { At = now, Source = better ? source : old.Source, Kind = old.Kind == ClipKinds.Text ? kind : old.Kind });
        return true;
    }

    /// <summary>Pins or unpins a clip; a secret is never pinned, so it still goes.</summary>
    public bool Pin(string id, bool pinned)
    {
        lock (_lock)
        {
            var i = _clips.FindIndex(c => c.Id == id);
            if (i < 0 || _clips[i].Pinned == pinned || (pinned && _clips[i].Kind == ClipKinds.Secret))
            {
                return false;
            }
            _clips[i] = _clips[i] with { Pinned = pinned };
            Trim();
            return true;
        }
    }

    public bool Forget(string id)
    {
        lock (_lock)
        {
            return Remove(c => c.Id == id) > 0;
        }
    }

    /// <summary>Forgets every clip that isn't pinned.</summary>
    public bool Clear()
    {
        lock (_lock)
        {
            return Remove(c => !c.Pinned) > 0;
        }
    }

    /// <summary>Forgets secrets kept longer than <see cref="SecretLife"/>; true when one went.</summary>
    public bool Expire(long now)
    {
        var oldest = now - (long)SecretLife.TotalMilliseconds;
        lock (_lock)
        {
            return Remove(c => c.Kind == ClipKinds.Secret && c.At < oldest) > 0;
        }
    }

    /// <summary>The clips as the page shows them, newest first.</summary>
    public IReadOnlyList<ClipView> Views()
    {
        lock (_lock)
        {
            return _clips.Select(View).ToList();
        }
    }

    private static ClipView View(Clip c)
    {
        // Only what's shown is masked: the rules are slow on a long text.
        var shown = c.Text.Length > ShownChars ? c.Text[..ShownChars] : c.Text;
        var text = c.Kind == ClipKinds.Secret ? SecretRedactor.Redact(shown) : shown;
        var lines = c.Text.Length == 0 ? 0 : c.Text.Count(ch => ch == '\n') + 1;
        return new ClipView(c.Id, c.Kind, text, lines, c.Text.Length, c.Source, c.At, c.Pinned, c.Width, c.Height, c.Bytes, c.Folder);
    }

    /// <summary>A clip's whole text, a secret's too; null for an image or a clip that's gone.</summary>
    public string? TextOf(string id)
    {
        lock (_lock)
        {
            return _clips.Find(c => c.Id == id) is { Kind: not ClipKinds.Image } clip ? clip.Text : null;
        }
    }

    /// <summary>An image clip's PNG, read from disk the first time; null when it's gone or can't be read.</summary>
    public byte[]? ImageOf(string id)
    {
        lock (_lock)
        {
            if (_clips.Find(c => c.Id == id) is not { Kind: ClipKinds.Image })
            {
                return null;
            }
            if (_images.TryGetValue(id, out var png))
            {
                return png;
            }
            png = ReadImage(id);
            if (png is not null)
            {
                _images[id] = png;
            }
            return png;
        }
    }

    /// <summary>What a text says it is: a secret first (whatever the page said), then a link or a path; else what the page said, or text.</summary>
    public static string Classify(string text, string? kind)
    {
        if (HasSecret(text))
        {
            return ClipKinds.Secret;
        }
        var line = text.Trim();
        if (line.Length <= MaxLinkChars && !line.Contains('\n'))
        {
            if (Link().IsMatch(line))
            {
                return ClipKinds.Url;
            }
            if (FilePath().IsMatch(line))
            {
                return ClipKinds.Path;
            }
        }
        return kind == ClipKinds.Command ? ClipKinds.Command : ClipKinds.Text;
    }

    /// <summary>
    /// Whether a line of the text holds a secret. Line by line, leaving out lines longer than <see cref="MaxSecretLine"/>:
    /// the redaction rules take minutes on a long run of text without spaces, and a token or a password line is short.
    /// </summary>
    private static bool HasSecret(string text) =>
        text.Split('\n').Any(line => line.Length <= MaxSecretLine && SecretRedactor.Redact(line) != line);

    [GeneratedRegex(@"^(?:https?|ftp)://\S+$", RegexOptions.IgnoreCase)]
    private static partial Regex Link();

    // C:\ or C:/, \\server\share, or a Unix path of two parts or more (so "/help" stays text).
    [GeneratedRegex(@"^(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|(?:~|\.{1,2})?/[^\s/]+/)")]
    private static partial Regex FilePath();

    /// <summary>
    /// A path on this PC: a folder, a file, or null when it isn't there. A network path (\\server) isn't looked at: a
    /// server that's away would hold the copy up.
    /// </summary>
    public static bool? IsFolder(string text)
    {
        var path = Environment.ExpandEnvironmentVariables(text.Trim().Trim('"', '\''));
        if (path.StartsWith(@"\\", StringComparison.Ordinal))
        {
            return null;
        }
        return Directory.Exists(path) ? true : File.Exists(path) ? false : null;
    }

    private static string NewId() => Guid.NewGuid().ToString("N")[..IdLength];

    /// <summary>Drops the oldest clips that aren't pinned past the limits.</summary>
    private void Trim()
    {
        var texts = 0;
        var images = 0;
        var longs = 0;
        var dropped = new HashSet<string>();
        foreach (var c in _clips.Where(c => !c.Pinned))
        {
            var over = c.Kind == ClipKinds.Image ? ++images > MaxImages : ++texts > Limit || (c.Text.Length > LongChars && ++longs > MaxLong);
            if (over)
            {
                dropped.Add(c.Id);
            }
        }
        Remove(c => dropped.Contains(c.Id));
    }

    private int Remove(Predicate<Clip> which)
    {
        foreach (var c in _clips.Where(c => which(c) && c.Kind == ClipKinds.Image))
        {
            _images.Remove(c.Id);
            Storage.Try(() => File.Delete(ImagePath(c.Id)));
        }
        return _clips.RemoveAll(which);
    }

    // ---- On disk ----

    /// <summary>Reads the clips kept from the last run, once, when the vault is open; true when it read them.</summary>
    public bool Load()
    {
        lock (_lock)
        {
            if (_loaded || vault.IsLocked)
            {
                return false;
            }
            _loaded = true;
            if (!Persist)
            {
                return false;
            }
            using var doc = vault.ReadJson(ListPath);
            var kept = doc?.RootElement.Deserialize<List<Clip>>(Json) ?? [];
            // Copies made before the vault opened stay on top.
            _clips = [.. _clips, .. kept.Where(k => ClipKinds.All.Contains(k.Kind) && !_clips.Any(c => c.Id == k.Id))];
            Trim();
            return kept.Count > 0;
        }
    }

    /// <summary>Writes the clips (secrets and long clips left out); with keeping after a restart off, deletes what was written.</summary>
    public void Save()
    {
        lock (_lock)
        {
            if (!Persist)
            {
                Storage.Try(() => File.Delete(ListPath));
                Storage.Try(() => Directory.Delete(ImageDir, recursive: true));
                return;
            }
            if (_loaded)
            {
                vault.WriteSealed(ListPath, JsonSerializer.Serialize(_clips.Where(c => c.Kind != ClipKinds.Secret && c.Text.Length <= LongChars), Json));
            }
        }
    }

    private void WriteImage(string id, byte[] png)
    {
        if (Persist && vault.Key is { } key)
        {
            Storage.Try(() =>
            {
                Directory.CreateDirectory(ImageDir);
                AppPaths.WriteAtomically(ImagePath(id), Sealed.Seal(key, png));
            });
        }
    }

    private byte[]? ReadImage(string id)
    {
        byte[]? png = null;
        if (vault.Key is { } key && File.Exists(ImagePath(id)))
        {
            try
            {
                png = Sealed.Open(key, File.ReadAllBytes(ImagePath(id)));
            }
            catch (Exception e) when (Storage.IsFileError(e) || e is CryptographicException)
            {
                png = null;
            }
        }
        return png;
    }
}
