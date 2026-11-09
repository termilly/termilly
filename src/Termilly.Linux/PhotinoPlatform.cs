using System.Diagnostics;
using Photino.NET;
using Termilly.Desktop;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Platform;

namespace Termilly.Linux;

/// <summary>
/// What a Photino window does for the shared code on Linux and macOS alike: the page's messages, the window's
/// requests (raised as events for <see cref="LinuxWindow"/>), and the system's file dialogs through Photino. What
/// the desktop around it does differently (the file manager, notifications, ports, sign-in) is each system's own.
/// </summary>
/// <param name="send">Sends a message to the page (the window's outbox, so sending never waits on the window's thread).</param>
internal abstract class PhotinoPlatform(Action<string> send, string? startFolder) : IPageSink, IAppWindow, IFileDialogs
{
    /// <summary>How long a query to the system (gsettings, defaults) may take.</summary>
    private static readonly TimeSpan SystemQueryTimeout = TimeSpan.FromSeconds(5);

    private PhotinoWindow? _window;

    /// <summary>The window's title bar asks for a window action (minimize, maximize, close, drag, resize).</summary>
    public event Action<FromPage.Window>? WindowActionRequested;

    /// <summary>Termilly was started again while this one runs: the window should come to the front.</summary>
    public event Action? Activate;

    /// <summary>The window closes now, without asking: the page's last snapshot is in, or an update restarts Termilly.</summary>
    public event Action? CloseRequested;

    /// <summary>The user wants to quit: asks first when something is running (QuitGate).</summary>
    public event Action? QuitRequested;

    /// <summary>The page has started and listens: it can be told the window's state (maximized, as it was left).</summary>
    public event Action? Loaded;

    /// <summary>The window, for its dialogs; set once it exists.</summary>
    public void Attach(PhotinoWindow window) => _window = window;

    public void Send(string json) => send(json);

    // ---- The window ----

    public string? StartFolder => startFolder;

    public void BringToFront() => Activate?.Invoke();

    public void Act(FromPage.Window action) => WindowActionRequested?.Invoke(action);

    /// <summary>Runs an action on the window's thread (dropped before the window exists).</summary>
    public void OnWindowThread(Action action) => _window?.Invoke(action);

    public void CloseNow() => CloseRequested?.Invoke();

    public void Quit() => QuitRequested?.Invoke();

    /// <summary>No dock badge yet (src/Termilly.Linux/README.md, "Not yet").</summary>
    public void ShowBadge(int count)
    {
    }

    /// <summary>
    /// The page shows its own start-up screen (js/loader.js): nothing to take away. It hears the window's state now,
    /// which changed before it listened when the window opened maximized.
    /// </summary>
    public void PageReady() => Loaded?.Invoke();

    /// <summary>No picture following the pointer out of the window yet: a terminal goes out at the window's edge.</summary>
    public void ShowDragPicture(FromPage.DragPicture picture)
    {
    }

    /// <summary>
    /// A picture of the page for a terminal dragged out (WebKitGTK's snapshot, PageSnapshot); none on macOS yet, where
    /// it shows its outline alone.
    /// </summary>
    public Task<string?> CapturePageAsync()
    {
        if (!OperatingSystem.IsLinux() || _window is null)
        {
            return Task.FromResult<string?>(null);
        }
        var done = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
        _window.Invoke(() =>
        {
            if (GtkWindow.Find() is { } main)
            {
                PageSnapshot.Take(main, done);
            }
            else
            {
                done.TrySetResult(null);
            }
        });
        return done.Task;
    }

    // ---- The system's own dialogs, through Photino: they open on the window's thread; the answer comes back here ----

    protected static string Home => Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

    public async Task<string?> PickFolderAsync(string title, string initial, string? over = null) =>
        _window is null ? null : (await _window.ShowOpenFolderAsync(title, initial, false).ConfigureAwait(false))?.FirstOrDefault();

    public async Task<string?> PickLayoutToSaveAsync(string fileName)
    {
        if (_window is null)
        {
            return null;
        }
        var path = await _window.ShowSaveFileAsync("Export workspace layout", Path.Combine(Home, fileName), [("Termilly layout", ["*" + WorkspaceLayout.Extension])]).ConfigureAwait(false);
        return string.IsNullOrEmpty(path) ? null : path;
    }

    public async Task<string?> PickZipToSaveAsync(string fileName)
    {
        if (_window is null)
        {
            return null;
        }
        var path = await _window.ShowSaveFileAsync("Export history", Path.Combine(Home, fileName), [("Zip archive", ["*.zip"])]).ConfigureAwait(false);
        return string.IsNullOrEmpty(path) ? null : path;
    }

    public async Task<string?> PickLayoutToOpenAsync() =>
        _window is null
            ? null
            : (await _window.ShowOpenFileAsync("Import workspace layout", Home, false,
                [("Termilly layout", ["*" + WorkspaceLayout.Extension, "*.yaml"]), ("All files", ["*"])]).ConfigureAwait(false))?.FirstOrDefault();

    public async Task<string?> PickTextToSaveAsync(string fileName, string? folder)
    {
        if (_window is null)
        {
            return null;
        }
        var path = await _window.ShowSaveFileAsync("Save note", Path.Combine(folder ?? Home, fileName), [("Text files", ["*.txt", "*.md"]), ("All files", ["*"])]).ConfigureAwait(false);
        return string.IsNullOrEmpty(path) ? null : path;
    }

    public async Task<string?> PickTextToOpenAsync() =>
        _window is null
            ? null
            : (await _window.ShowOpenFileAsync("Open in the Notepad", Home, false,
                [("All files", ["*"]), ("Text files", ["*.txt", "*.md"])]).ConfigureAwait(false))?.FirstOrDefault(); // any file: the Notepad says when one isn't text

    public async Task<IReadOnlyList<string>> PickFilesAsync(string title) =>
        _window is null ? [] : await _window.ShowOpenFileAsync(title, Home, true).ConfigureAwait(false) ?? [];

    // ---- Programs ----

    /// <summary>What a program printed, or null when it couldn't be started.</summary>
    protected static string? Query(string file, params string[] args)
    {
        try
        {
            var start = new ProcessStartInfo(file) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
            foreach (var arg in args)
            {
                start.ArgumentList.Add(arg);
            }
            using var process = Process.Start(start)!;
            var output = process.StandardOutput.ReadToEnd();
            process.WaitForExit(SystemQueryTimeout);
            return output;
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return null;
        }
    }

    /// <summary>Starts a program without waiting for it; false when it couldn't be started.</summary>
    protected static bool Run(string file, params string[] args)
    {
        try
        {
            var start = new ProcessStartInfo(file) { UseShellExecute = false };
            foreach (var arg in args)
            {
                start.ArgumentList.Add(arg);
            }
            Process.Start(start)?.Dispose();
            return true;
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            Console.Error.WriteLine($"termilly: {file}: {e.Message}");
            return false;
        }
    }

    /// <summary>Runs a program to its end; throws an <see cref="IOException"/> with what it said when it fails.</summary>
    protected static void RunToEnd(string file, string failure, params string[] args)
    {
        var start = new ProcessStartInfo(file) { UseShellExecute = false, RedirectStandardError = true };
        foreach (var arg in args)
        {
            start.ArgumentList.Add(arg);
        }
        using var process = Process.Start(start) ?? throw new IOException($"{file} didn't start.");
        var error = process.StandardError.ReadToEnd();
        process.WaitForExit();
        if (process.ExitCode != 0)
        {
            throw new IOException(error.Trim() is { Length: > 0 } message ? message : failure);
        }
    }
}
