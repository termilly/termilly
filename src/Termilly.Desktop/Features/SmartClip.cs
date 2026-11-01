using System.IO;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Platform;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>
/// Smart Clip (js/smartclip.js): keeps every copy in <see cref="ClipStore"/>, from the page (Termilly's own copies, with
/// where they came from) and from the system clipboard where it tells (copies in other apps), and hands a clip back to
/// paste: its text, or an image as a file or a picture. Secrets go after a while; the clips are written a moment after
/// they change.
/// </summary>
internal sealed class SmartClipHandler(ClipStore store, PageChannel page, ISettingsStore settings, IEnumerable<IClipboardWatch> watches)
    : IMessageHandler, IStartable, IDisposable
{
    private static readonly TimeSpan ExpireEvery = TimeSpan.FromMinutes(1);
    /// <summary>Changes made close together are written once.</summary>
    private static readonly TimeSpan SaveAfter = TimeSpan.FromSeconds(1);
    /// <summary>Where images pasted as a path are saved, and how long they're kept there.</summary>
    private const string PictureFolder = "Termilly clips";
    private static readonly TimeSpan PictureLife = TimeSpan.FromDays(7);
    private const string PngExtension = ".png";
    private const string PngDataUrl = "data:image/png;base64,";
    private Timer? _expire;
    private Timer? _save;

    private ClipSettings Clips => settings.Current.Clips;

    public void Register(MessageRouter router)
    {
        router.On<FromPage.ClipCopied>(m =>
        {
            if (Clips.Enabled && store.AddText(m.Text, m.Source, m.Kind, Now))
            {
                Changed();
            }
        });
        router.On<FromPage.ClipList>(_ =>
        {
            store.Load();
            Post();
        });
        router.On<FromPage.ClipPin>(m => Changed(store.Pin(m.Id, m.Pinned)));
        router.On<FromPage.ClipForget>(m => Changed(store.Forget(m.Id)));
        router.On<FromPage.ClipClear>(_ => Changed(store.Clear()));
        router.On<FromPage.ClipTake>(m => page.Post(Take(m)));
    }

    public void Start()
    {
        Apply(Clips);
        settings.Saved += s =>
        {
            if (s.Current.Clips != s.Previous.Clips)
            {
                Apply(s.Current.Clips);
                Changed();
            }
        };
        _expire = new Timer(_ => Changed(store.Expire(Now)), null, ExpireEvery, ExpireEvery);
        foreach (var watch in watches)
        {
            watch.Changed += OnClipboard;
            watch.Start();
        }
        Storage.Try(SweepPictures);
    }

    private void Apply(ClipSettings clips)
    {
        store.Limit = clips.Limit;
        store.Persist = clips.Keep;
    }

    /// <summary>A copy anywhere: kept while Smart Clip keeps copies from other apps (Termilly's own come from the page too).</summary>
    private void OnClipboard(ClipboardContent content)
    {
        if (!Clips.Enabled || !Clips.OtherApps)
        {
            return;
        }
        var added = content.Png is { } png
            ? store.AddImage(png, content.Width, content.Height, ClipStore.ClipboardSource, Now)
            : content.Text is { } text && store.AddText(text, ClipStore.ClipboardSource, null, Now);
        Changed(added);
    }

    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private void Changed(bool changed = true)
    {
        if (!changed)
        {
            return;
        }
        Post();
        _save?.Dispose();
        _save = new Timer(_ => store.Save(), null, SaveAfter, Timeout.InfiniteTimeSpan);
    }

    private void Post() => page.Post(new ToPage.Clips(store.Views(), Clips.Enabled));

    private ToPage.ClipTaken Take(FromPage.ClipTake m)
    {
        if (m.As == ClipForms.Text)
        {
            return new ToPage.ClipTaken(m.RequestId, store.TextOf(m.Id), store.TextOf(m.Id) is null ? "That clip is gone." : null);
        }
        if (store.ImageOf(m.Id) is not { } png)
        {
            return new ToPage.ClipTaken(m.RequestId, null, "That image is gone, or couldn’t be read.");
        }
        if (m.As == ClipForms.Picture)
        {
            return new ToPage.ClipTaken(m.RequestId, PngDataUrl + Convert.ToBase64String(png));
        }
        var file = Path.Combine(Path.GetTempPath(), PictureFolder, m.Id + PngExtension);
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            AppPaths.WriteAtomically(file, png);
            return new ToPage.ClipTaken(m.RequestId, file);
        }
        catch (Exception e) when (Storage.IsFileError(e))
        {
            return new ToPage.ClipTaken(m.RequestId, null, e.Message);
        }
    }

    /// <summary>Deletes images saved for pasting as a path a week ago or more: an agent has read them by then.</summary>
    private static void SweepPictures()
    {
        var folder = new DirectoryInfo(Path.Combine(Path.GetTempPath(), PictureFolder));
        if (!folder.Exists)
        {
            return;
        }
        foreach (var old in folder.GetFiles("*" + PngExtension).Where(f => f.LastWriteTimeUtc < DateTime.UtcNow - PictureLife))
        {
            old.Delete();
        }
    }

    public void Dispose()
    {
        _expire?.Dispose();
        _save?.Dispose();
        store.Save();
    }
}
