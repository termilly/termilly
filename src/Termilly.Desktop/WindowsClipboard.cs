using System.Collections.Specialized;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
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
    /// <summary>An image as a PNG file (browsers, Snipping Tool) and as a bitmap without its file header (Paint, most apps).</summary>
    private const string PngFormat = "PNG";
    /// <summary>BITMAPFILEHEADER: "BM", the file's size, two reserved words, where the pixels start.</summary>
    private const int FileHeaderSize = 14;
    private const int SizeAt = 2;
    private const int PixelsAt = 10;
    /// <summary>BITMAPINFOHEADER's fields read here: bit count, compression, colours used; BI_BITFIELDS with its three masks after a 40-byte header.</summary>
    private const int InfoHeaderSize = 40;
    private const int BitCountAt = 14;
    private const int CompressionAt = 16;
    private const int ColorsUsedAt = 32;
    private const int BitFields = 3;
    private const int MaskBytes = 12;
    private const int ColorBytes = 4;
    private const int MaxPaletteBits = 8;
    private const int BytesPerPixel = 4;
    private const int AlphaOffset = 3;
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
        return ReadImage() is { } image ? Png(image) : null;
    }

    /// <summary>
    /// The clipboard's image: its PNG when it has one, else its bitmap read here. WPF's own GetImage reads a 32-bit
    /// bitmap (what Paint copies) as fully transparent, so that's the last resort.
    /// </summary>
    private static BitmapSource? ReadImage()
    {
        if (Clipboard.GetData(PngFormat) is MemoryStream png)
        {
            return Decode(new PngBitmapDecoder(png, BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad));
        }
        if (Clipboard.GetData(DataFormats.Dib) is MemoryStream dib && Bitmap(dib.ToArray()) is { } file)
        {
            using var stream = new MemoryStream(file);
            return Decode(new BmpBitmapDecoder(stream, BitmapCreateOptions.None, BitmapCacheOption.OnLoad));
        }
        return Clipboard.ContainsImage() ? Opaque(Clipboard.GetImage()) : null;
    }

    private static BitmapSource? Decode(BitmapDecoder decoder) => decoder.Frames.Count > 0 ? Opaque(decoder.Frames[0]) : null;

    /// <summary>A device-independent bitmap as a .bmp file: the file header in front, saying where its pixels start.</summary>
    private static byte[]? Bitmap(byte[] dib)
    {
        if (dib.Length < InfoHeaderSize)
        {
            return null;
        }
        var header = BitConverter.ToInt32(dib, 0);
        var bits = BitConverter.ToInt16(dib, BitCountAt);
        var colors = BitConverter.ToInt32(dib, ColorsUsedAt);
        var masks = header == InfoHeaderSize && BitConverter.ToInt32(dib, CompressionAt) == BitFields ? MaskBytes : 0;
        var palette = (colors == 0 && bits <= MaxPaletteBits ? 1 << bits : colors) * ColorBytes;
        var file = new byte[FileHeaderSize + dib.Length];
        file[0] = (byte)'B';
        file[1] = (byte)'M';
        BitConverter.GetBytes(file.Length).CopyTo(file, SizeAt);
        BitConverter.GetBytes(FileHeaderSize + header + masks + palette).CopyTo(file, PixelsAt);
        dib.CopyTo(file, FileHeaderSize);
        return file;
    }

    /// <summary>An image whose alpha is 0 everywhere (a bitmap that has none, read as if it had) made opaque.</summary>
    private static BitmapSource? Opaque(BitmapSource? image)
    {
        if (image is null || (image.Format != PixelFormats.Bgra32 && image.Format != PixelFormats.Pbgra32))
        {
            return image;
        }
        var pixels = new byte[image.PixelWidth * image.PixelHeight * BytesPerPixel];
        image.CopyPixels(pixels, image.PixelWidth * BytesPerPixel, 0);
        for (var i = AlphaOffset; i < pixels.Length; i += BytesPerPixel)
        {
            if (pixels[i] != 0)
            {
                return image;
            }
        }
        return new FormatConvertedBitmap(image, PixelFormats.Bgr32, null, 0);
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
