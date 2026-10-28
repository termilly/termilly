using System.IO;
using System.Runtime.InteropServices;

namespace Termilly.Desktop;

/// <summary>
/// What Explorer does with files, for the Files panel: moving one to the Recycle Bin, and where the user's Downloads
/// folder is (they can move it, to another drive even, so it isn't always %USERPROFILE%\Downloads).
/// </summary>
internal static class ShellFiles
{
    private const string DownloadsName = "Downloads";
    private static readonly Guid DownloadsId = new("374DE290-123F-4565-9164-39C4925E467B");

    private const uint Delete = 3;
    private const ushort Silent = 0x4;
    private const ushort NoConfirmation = 0x10;
    private const ushort AllowUndo = 0x40;
    private const ushort NoErrorUi = 0x400;

    /// <summary>The Downloads folder Windows knows, else the usual one in the user's folder.</summary>
    public static string Downloads =>
        SHGetKnownFolderPath(DownloadsId, 0, 0, out var path) == 0 && !string.IsNullOrEmpty(path)
            ? path
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), DownloadsName);

    /// <summary>Moves a file or folder to the Recycle Bin, without Explorer's own dialogs; throws when it can't.</summary>
    public static void Recycle(string path)
    {
        var operation = new FileOperation
        {
            Function = Delete,
            From = Path.GetFullPath(path) + "\0\0",
            Flags = (ushort)(AllowUndo | NoConfirmation | NoErrorUi | Silent),
        };
        var result = SHFileOperation(ref operation);
        if (result != 0 || operation.AnyAborted)
        {
            throw new IOException($"Couldn't move {Path.GetFileName(path)} to the Recycle Bin (error {result}).");
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct FileOperation
    {
        public nint Window;
        public uint Function;
        public string From;
        public string? To;
        public ushort Flags;
        [MarshalAs(UnmanagedType.Bool)]
        public bool AnyAborted;
        public nint NameMappings;
        public string? ProgressTitle;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHFileOperation(ref FileOperation operation);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHGetKnownFolderPath([MarshalAs(UnmanagedType.LPStruct)] Guid id, uint flags, nint token, [MarshalAs(UnmanagedType.LPWStr)] out string path);
}
