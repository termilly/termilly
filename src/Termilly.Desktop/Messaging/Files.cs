namespace Termilly.Desktop.Messaging;

// The Files side panel (Features/Files.cs, js/filepanel.js): the folders of the terminal in focus, on its server
// over SFTP for an SSH terminal, else on this machine.

/// <summary>The Files panel's operations (the files:op message's op).</summary>
internal static class FileOperations
{
    /// <summary>A server's file downloaded: to Downloads, or to <c>To</c> (a folder here).</summary>
    public const string Get = "get";
    public const string Remove = "rm";
    public const string RemoveDirectory = "rmdir";
    public const string MakeDirectory = "mkdir";
    public const string Rename = "rename";
    /// <summary>A file here opened with the app the system chose for it.</summary>
    public const string Open = "open";
    /// <summary>A file here shown in the file manager; a folder opened there.</summary>
    public const string Reveal = "reveal";
}

/// <summary>Folders the Files panel lists that aren't paths.</summary>
internal static class FolderPaths
{
    /// <summary>This computer's drives, network drives too: above a drive's root on Windows.</summary>
    public const string Drives = "drives:";
}

/// <summary>One item of a copy: its path where it is, and its name where it goes ("name (1)" to keep both).</summary>
internal sealed record FileCopy(string Path = "", string Name = "");

internal static partial class FromPage
{
    /// <param name="Id">The terminal whose folders it lists.</param>
    internal sealed record FilesList(string Id = "", string? RequestId = null, string? Path = null) : IPageMessage
    {
        public static string Type => "files:list";
    }

    /// <summary>A tree's folders in each of <see cref="Paths"/>, of the terminal's files; <see cref="Files"/>: their files too (the Files panel).</summary>
    internal sealed record FilesTree(string Id = "", string? RequestId = null, IReadOnlyList<string>? Paths = null, bool Files = false) : IPageMessage
    {
        public static string Type => "files:tree";
    }

    /// <param name="Op">One of <see cref="FileOperations"/>.</param>
    /// <param name="To">A rename's new path; a download's folder (none: Downloads).</param>
    internal sealed record FilesOp(string Id = "", string? RequestId = null, string? Op = null, string? Path = null, string? To = null) : IPageMessage
    {
        public static string Type => "files:op";
    }

    /// <summary>Copies files into <see cref="Dir"/> (uploads them, on a server): the ones the browser handed over, or <see cref="Paths"/>.</summary>
    internal sealed record FilesPut(string Id = "", string? RequestId = null, string? Dir = null, IReadOnlyList<string>? Paths = null) : IPageMessage
    {
        public static string Type => "files:put";
    }

    /// <summary>The Upload button where the host's own dialog picks the files.</summary>
    internal sealed record FilesPick(string Id = "", string? RequestId = null, string? Dir = null) : IPageMessage
    {
        public static string Type => "files:pick";
    }

    /// <summary>Downloads a server's files and folders into a folder the user picks.</summary>
    internal sealed record FilesGetTo(string Id = "", string? RequestId = null, IReadOnlyList<string>? Paths = null) : IPageMessage
    {
        public static string Type => "files:getTo";
    }

    /// <summary>
    /// "Copy to": files and folders of terminal <see cref="Id"/> copied into <see cref="Dir"/>, a folder of terminal
    /// <see cref="To"/> (here or on its server, the same one or another), each under its <see cref="FileCopy.Name"/>
    /// there, replacing a file of that name and merging into a folder of that name. Each is reported as it's done.
    /// </summary>
    internal sealed record FilesCopyTo(string Id = "", string? RequestId = null, string To = "", string? Dir = null, IReadOnlyList<FileCopy>? Items = null) : IPageMessage
    {
        public static string Type => "files:copyTo";
    }

    /// <summary>
    /// Searches <see cref="Dir"/> and every folder in it for names with <see cref="Text"/> (FileSearch.cs), stopping
    /// the search before; no text only stops it. What's found comes as files:found with its <see cref="SearchId"/>.
    /// </summary>
    internal sealed record FilesSearch(string Id = "", string? SearchId = null, string? Dir = null, string? Text = null) : IPageMessage
    {
        public static string Type => "files:search";
    }
}

internal static partial class ToPage
{
    internal sealed record FilesListing(string? RequestId, string Path, object Entries) : IHostMessage
    {
        public static string Type => "files:listing";
    }

    /// <summary>The folders asked for, in their order; <see cref="Error"/> when none could be read (no connection).</summary>
    internal sealed record FilesTree(string? RequestId, IReadOnlyList<TreeBranch> Branches, string? Error = null) : IHostMessage
    {
        public static string Type => "files:tree";
    }

    internal sealed record FilesListingFailed(string? RequestId, string Message) : IHostMessage
    {
        public static string Type => "files:listing";

        public bool Ok { get; }
    }

    /// <param name="Local">Where a download was saved.</param>
    internal sealed record FilesDone(string? RequestId, string? Local) : IHostMessage
    {
        public static string Type => "files:done";

        public bool Ok { get; } = true;
    }

    internal sealed record FilesFailed(string? RequestId, string Message) : IHostMessage
    {
        public static string Type => "files:done";

        public bool Ok { get; }
    }

    internal sealed record FilesCopied(string? RequestId, string File) : IHostMessage
    {
        public static string Type => "files:done";

        public bool Ok { get; } = true;
    }

    internal sealed record FilesCopyFailed(string? RequestId, string File, string Message) : IHostMessage
    {
        public static string Type => "files:done";

        public bool Ok { get; }
    }

    /// <summary>A file or folder downloaded into a folder picked, and where it went.</summary>
    internal sealed record FilesSaved(string? RequestId, string File, string Local) : IHostMessage
    {
        public static string Type => "files:done";

        public bool Ok { get; } = true;
    }

    /// <summary>
    /// A search's finds so far (a batch at a time), then, <see cref="Done"/>, its end: whether it <see cref="Stopped"/>
    /// at FileSearch.Most, or why it failed.
    /// </summary>
    internal sealed record FilesFound(string? SearchId, IReadOnlyList<FoundEntry> Found, bool Done = false, bool Stopped = false, string? Error = null) : IHostMessage
    {
        public static string Type => "files:found";
    }

    /// <summary>The files picked for an upload (or the download whose folder was picked), each reported as it's done.</summary>
    internal sealed record FilesQueued(string? RequestId, IEnumerable<string?> Files) : IHostMessage
    {
        public static string Type => "files:queued";
    }
}
