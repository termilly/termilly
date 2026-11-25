using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Termilly.Desktop.Platform;
using static Termilly.Linux.MacObjC;

namespace Termilly.Linux;

/// <summary>
/// The clipboard's changes on macOS, for Clipboard: the text copied anywhere, as WindowsClipboard gives on Windows (no
/// images yet). macOS tells no app about a change, so its pasteboard's change count is looked at every so often. A copy
/// marked concealed (org.nspasteboard.ConcealedType, as password managers mark theirs) is left alone. Changes are told
/// on the window's thread.
/// </summary>
/// <param name="onWindow">Runs an action on the window's thread.</param>
[SupportedOSPlatform("macos")]
internal sealed class MacClipboard(Action<Action> onWindow) : IClipboardWatch, IClipboardReader, IDisposable
{
    private const string AppKit = "/System/Library/Frameworks/AppKit.framework/AppKit";
    private const string TextType = "public.utf8-plain-text";
    private const string ConcealedType = "org.nspasteboard.ConcealedType";
    /// <summary>How often the pasteboard is looked at.</summary>
    private static readonly TimeSpan Every = TimeSpan.FromMilliseconds(750);

    /// <summary>AppKit, loaded once: NSPasteboard's class is found only then.</summary>
    private static readonly Lazy<bool> AppKitLoaded = new(() => NativeLibrary.TryLoad(AppKit, out _));

    private Timer? _timer;
    private long _seen = -1;

    public event Action<ClipboardContent>? Changed;

    public void Start()
    {
        _timer = new Timer(_ => Look(), null, Every, Every);
    }

    private void Look()
    {
        var board = Board();
        if (board == IntPtr.Zero)
        {
            return;
        }
        var count = (long)Send(board, "changeCount");
        if (count == _seen)
        {
            return;
        }
        var first = _seen < 0;
        _seen = count;
        if (first || Concealed(board))
        {
            return; // what was there before Termilly started, or a secret
        }
        var text = TextOn(board);
        if (text is { Length: > 0 })
        {
            onWindow(() => Changed?.Invoke(new ClipboardContent(text)));
        }
    }

    /// <summary>The clipboard's text for a paste the user asked for (a concealed one too: pasting a password is the point).</summary>
    public string? ReadText() => Board() is var board && board != IntPtr.Zero ? TextOn(board) : null;

    /// <summary>The system's clipboard (AppKit loaded first).</summary>
    private static IntPtr Board() => AppKitLoaded.Value ? Send(Class("NSPasteboard"), "generalPasteboard") : IntPtr.Zero;

    /// <summary>The clipboard's plain text, or null.</summary>
    private static string? TextOn(IntPtr board) => Text(Send(board, "stringForType:", NsString(TextType)));

    /// <summary>Whether the copy is marked concealed.</summary>
    private static bool Concealed(IntPtr board)
    {
        var types = Send(board, "types");
        var count = types == IntPtr.Zero ? 0 : (long)Send(types, Cocoa.Count);
        for (long i = 0; i < count; i++)
        {
            if (Text(Send(types, Cocoa.ObjectAtIndex, (nint)i)) == ConcealedType)
            {
                return true;
            }
        }
        return false;
    }

    public void Dispose() => _timer?.Dispose();

}
