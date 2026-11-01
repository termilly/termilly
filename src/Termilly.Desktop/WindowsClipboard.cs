using System.Collections.Specialized;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media.Imaging;
using Termilly.Desktop.Platform;

namespace Termilly.Desktop;

/// <summary>
/// The Windows clipboard's changes (AddClipboardFormatListener), for Smart Clip: text, files copied in Explorer (as
/// their paths) or an image (as a PNG). Copies an app marks as private (password managers) are left alone, as Windows'
/// own clipboard history does.
/// </summary>
internal sealed class WindowsClipboard(Window window) : IClipboardWatch, IDisposable
{
    private const int WM_CLIPBOARDUPDATE = 0x031D;
    /// <summary>The formats an app sets to keep a copy out of clipboard history and monitors.</summary>
    private const string ExcludeFormat = "ExcludeClipboardContentFromMonitorProcessing";
    private const string HistoryFormat = "CanIncludeInClipboardHistory";
    /// <summary>Another app may still hold the clipboard just after it changes: tries this many times, this far apart.</summary>
    private const int Tries = 3;
    private static readonly TimeSpan Retry = TimeSpan.FromMilliseconds(50);
    private IntPtr _hwnd;
    private HwndSource? _source;

    public event Action<ClipboardContent>? Changed;

    public void Start()
    {
        _hwnd = new WindowInteropHelper(window).EnsureHandle();
        _source = HwndSource.FromHwnd(_hwnd);
        _source.AddHook(Hook);
        AddClipboardFormatListener(_hwnd);
    }

    private IntPtr Hook(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg == WM_CLIPBOARDUPDATE)
        {
            // Read once the message is done: the app that copied may still be closing the clipboard.
            window.Dispatcher.BeginInvoke(ReadAsync);
        }
        return IntPtr.Zero;
    }

    private async Task ReadAsync()
    {
        for (var i = 0; i < Tries; i++)
        {
            try
            {
                if (Read() is { } content)
                {
                    Changed?.Invoke(content);
                }
                return;
            }
            catch (COMException)
            {
                await Task.Delay(Retry).ConfigureAwait(true); // another app has it open
            }
        }
    }

    private static ClipboardContent? Read()
    {
        if (Clipboard.ContainsData(ExcludeFormat) || Clipboard.ContainsData(HistoryFormat) && IsNo(Clipboard.GetData(HistoryFormat)))
        {
            return null;
        }
        if (Clipboard.ContainsText())
        {
            return new ClipboardContent(Clipboard.GetText());
        }
        if (Clipboard.ContainsFileDropList() && Clipboard.GetFileDropList() is { Count: > 0 } files)
        {
            return new ClipboardContent(string.Join(Environment.NewLine, Paths(files)));
        }
        return Clipboard.ContainsImage() && Clipboard.GetImage() is { } image ? Png(image) : null;
    }

    private static IEnumerable<string> Paths(StringCollection files)
    {
        foreach (var file in files)
        {
            if (file is not null)
            {
                yield return file;
            }
        }
    }

    /// <summary>"CanIncludeInClipboardHistory" set to 0: a DWORD as a stream.</summary>
    private static bool IsNo(object? value) =>
        value is MemoryStream stream && stream.Length >= sizeof(int) && BitConverter.ToInt32(stream.ToArray(), 0) == 0;

    private static ClipboardContent Png(BitmapSource image)
    {
        var encoder = new PngBitmapEncoder();
        encoder.Frames.Add(BitmapFrame.Create(image));
        using var png = new MemoryStream();
        encoder.Save(png);
        return new ClipboardContent(null, png.ToArray(), image.PixelWidth, image.PixelHeight);
    }

    public void Dispose()
    {
        if (_source is not null)
        {
            RemoveClipboardFormatListener(_hwnd);
            _source.RemoveHook(Hook);
        }
    }

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AddClipboardFormatListener(IntPtr hwnd);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool RemoveClipboardFormatListener(IntPtr hwnd);
}
