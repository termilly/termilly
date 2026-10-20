using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Security.Cryptography.X509Certificates;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;

namespace Termilly.Setup.Engine;

/// <summary>One of the runtimes Termilly needs, and how setup gets it.</summary>
internal sealed class Prerequisite
{
    public static readonly Prerequisite DotNet = new(
        ".NET 10 Desktop Runtime",
        "https://aka.ms/dotnet/10.0/windowsdesktop-runtime-win-x64.exe",
        Payload.DotNetEntry,
        "/install /quiet /norestart",
        needsAdmin: true,
        approxMb: 60);

    public static readonly Prerequisite WebView2 = new(
        "Microsoft Edge WebView2 Runtime",
        // The online installer (2 MB) fetches the rest itself; the included copy is the full standalone one.
        "https://go.microsoft.com/fwlink/p/?LinkId=2124703",
        Payload.WebView2Entry,
        "/silent /install",
        needsAdmin: false,
        approxMb: 2);

    private Prerequisite(string name, string url, string entry, string arguments, bool needsAdmin, int approxMb)
    {
        Name = name;
        Url = url;
        Entry = entry;
        Arguments = arguments;
        NeedsAdmin = needsAdmin;
        ApproxMb = approxMb;
    }

    public string Name { get; }
    public string Url { get; }
    public string Entry { get; }
    public string Arguments { get; }
    /// <summary>The .NET installer only installs for the whole machine, so Windows asks for permission.</summary>
    public bool NeedsAdmin { get; }
    public int ApproxMb { get; }

    /// <summary>The installed version, or null when it isn't installed.</summary>
    public string? Installed() => this == DotNet ? Detect.DotNetDesktop10() : Detect.WebView2();
}

/// <summary>Finds what's installed on this PC.</summary>
internal static class Detect
{
    private const string WebView2Client = @"Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

    /// <summary>The newest Microsoft.WindowsDesktop.App 10.x for x64, from dotnet's own folder.</summary>
    public static string? DotNetDesktop10()
    {
        var root = Environment.GetEnvironmentVariable(WindowsNames.ProgramFiles64) ?? Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        var shared = Path.Combine(root, "dotnet", "shared", "Microsoft.WindowsDesktop.App");
        try
        {
            return Directory.Exists(shared)
                ? Directory.GetDirectories(shared).Select(Path.GetFileName).Where(v => v.StartsWith("10.", StringComparison.Ordinal))
                    .OrderByDescending(v => v, StringComparer.Ordinal).FirstOrDefault()
                : null;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>The Evergreen WebView2 runtime's version (machine-wide or per user), or null.</summary>
    public static string? WebView2()
    {
        foreach (var (hive, path) in new[]
        {
            (RegistryHive.LocalMachine, @"SOFTWARE\WOW6432Node\" + WebView2Client),
            (RegistryHive.LocalMachine, @"SOFTWARE\" + WebView2Client),
            (RegistryHive.CurrentUser, @"Software\" + WebView2Client),
        })
        {
            using var root = RegistryKey.OpenBaseKey(hive, RegistryView.Registry64);
            using var key = root.OpenSubKey(path);
            if (key?.GetValue("pv") is string version && version.Length > 0 && version != "0.0.0.0")
            {
                return version;
            }
        }
        return null;
    }

    /// <summary>"Windows 10 22H2 (build 19045), 64-bit" and the build number.</summary>
    public static (string Text, int Build) Windows()
    {
        using var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
        var build = int.TryParse(key?.GetValue("CurrentBuildNumber") as string, out var b) ? b : 0;
        var display = key?.GetValue(WindowsNames.DisplayVersion) as string ?? key?.GetValue("ReleaseId") as string ?? "";
        // Windows 11 still calls itself "Windows 10" in ProductName; its builds start at 22000.
        var name = build >= FirstWindows11Build ? "Windows 11" : "Windows 10";
        var bits = Environment.Is64BitOperatingSystem ? "64-bit" : "32-bit";
        return ($"{name} {display} (build {build}), {bits}".Replace("  ", " "), build);
    }

    public const int MinimumBuild = 18362; // Windows 10 1903
    private const int FirstWindows11Build = 22000;
}

/// <summary>Gets a prerequisite onto the PC: downloaded from Microsoft, else setup's own copy, then installed.</summary>
internal static class PrerequisiteInstaller
{
    /// <summary>How long to wait for a download to connect, and for more bytes once it's going.</summary>
    public static readonly TimeSpan ConnectTimeout = TimeSpan.FromSeconds(15);
    public static readonly TimeSpan StallTimeout = TimeSpan.FromSeconds(20);
    /// <summary>Under setup's log folder: the installers it downloads or unpacks, and the name an unpacked one gets.</summary>
    private const string PrerequisitesFolder = "prereqs";
    private const string IncludedPrefix = "included-";
    /// <summary>How often a running installer is checked for cancel.</summary>
    private const int PollMs = 250;

    /// <summary>
    /// Installs <paramref name="item"/>. Reports progress as text plus 0..1 (or -1 when unknown), and whether the
    /// included copy was used. Throws <see cref="SetupException"/> when it can't be installed.
    /// </summary>
    public static async Task<bool> InstallAsync(Prerequisite item, Payload? payload, bool preferIncluded,
        Action<string, double> progress, CancellationToken cancel)
    {
        var folder = Path.Combine(Log.Folder, PrerequisitesFolder);
        Directory.CreateDirectory(folder);
        var installer = preferIncluded ? null : await DownloadSignedAsync(item, folder, progress, cancel).ConfigureAwait(false);
        var usedIncluded = false;
        if (installer is null)
        {
            if (payload is null || !payload.Has(item.Entry))
            {
                throw new SetupException($"{item.Name} couldn't be downloaded, and this setup doesn't include it.",
                    "Check the internet connection and try again, or install it from Microsoft's website.");
            }
            installer = IncludedCopy(item, payload, folder, progress)
                ?? throw new SetupException($"Setup's copy of {item.Name} isn't signed by Microsoft.", "Download setup again from termilly.com.");
            usedIncluded = true;
            Log.Write($"{item.Name}: using the included copy");
        }

        progress($"Installing {item.Name}…", -1);
        var exit = await RunAsync(installer, item.Arguments, item.NeedsAdmin, cancel).ConfigureAwait(false);
        Log.Write($"{item.Name}: installer exit code {exit}");
        // The online WebView2 installer fetches the runtime itself, so it can still fail on the network: then the
        // included copy gets its turn (not after a declined permission prompt: that would just ask again).
        if (!Succeeded(exit) && exit != WindowsCodes.Cancelled && !usedIncluded && payload is not null && payload.Has(item.Entry)
            && IncludedCopy(item, payload, folder, progress) is { } included)
        {
            usedIncluded = true;
            progress($"Installing {item.Name}…", -1);
            exit = await RunAsync(included, item.Arguments, item.NeedsAdmin, cancel).ConfigureAwait(false);
            Log.Write($"{item.Name}: included installer exit code {exit}");
        }
        if (!Succeeded(exit) || item.Installed() is null)
        {
            throw new SetupException($"{item.Name} wasn't installed (code {exit}).",
                exit == WindowsCodes.Cancelled ? "Windows asked for permission and it was declined. Retry and choose Yes." : "See the log for details, then retry.");
        }
        return usedIncluded;
    }

    /// <summary>An installer's exit code that means it's installed: done, done but restart later, or a newer one there.</summary>
    private static bool Succeeded(int exit) => exit is 0 or WindowsCodes.RestartRequired or WindowsCodes.NewerInstalled;

    /// <summary>The installer downloaded from Microsoft, when the download works and Microsoft signed it; else null.</summary>
    private static async Task<string?> DownloadSignedAsync(Prerequisite item, string folder, Action<string, double> progress, CancellationToken cancel)
    {
        var target = Path.Combine(folder, Path.GetFileName(item.Entry));
        try
        {
            progress($"Downloading {item.Name} from Microsoft…", 0);
            await DownloadAsync(item.Url, target, (done, total) =>
                progress($"Downloading {item.Name} from Microsoft… {done / Bytes.PerMb:0.0} of {total / Bytes.PerMb:0} MB",
                    total > 0 ? (double)done / total : -1), cancel).ConfigureAwait(false);
            if (Signature.IsMicrosoft(target))
            {
                return target;
            }
            Log.Write($"{item.Name}: the download isn't signed by Microsoft; not using it");
        }
        catch (OperationCanceledException) when (cancel.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception e) when (e is HttpRequestException or IOException or TimeoutException or OperationCanceledException or WebException)
        {
            Log.Write($"{item.Name}: download failed ({e.Message})");
        }
        return null;
    }

    /// <summary>Setup's own copy of the installer, unpacked next to the downloads; null when Microsoft didn't sign it.</summary>
    private static string? IncludedCopy(Prerequisite item, Payload payload, string folder, Action<string, double> progress)
    {
        progress($"Using the copy of {item.Name} included in setup…", -1);
        var installer = Path.Combine(folder, IncludedPrefix + Path.GetFileName(item.Entry));
        payload.Extract(item.Entry, installer);
        return Signature.IsMicrosoft(installer) ? installer : null;
    }

    private static async Task DownloadAsync(string url, string target, Action<long, long> progress, CancellationToken cancel)
    {
        ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
        using var http = new HttpClient { Timeout = System.Threading.Timeout.InfiniteTimeSpan };
        http.DefaultRequestHeaders.UserAgent.ParseAdd("TermillySetup/1.0");
        Log.Write($"GET {url}");
        using var connect = CancellationTokenSource.CreateLinkedTokenSource(cancel);
        connect.CancelAfter(ConnectTimeout);
        using var response = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, connect.Token).ConfigureAwait(false);
        response.EnsureSuccessStatusCode();
        var total = response.Content.Headers.ContentLength ?? -1;
        var size = total > 0 ? $"{total / Bytes.PerMb:0.0} MB" : "size unknown";
        Log.Write($"connected: {response.RequestMessage?.RequestUri}, {size}");

        using var source = await response.Content.ReadAsStreamAsync().ConfigureAwait(false);
        using var file = File.Create(target);
        var buffer = new byte[Bytes.CopyBuffer];
        long done = 0;
        while (true)
        {
            // A read that brings nothing for StallTimeout gives up: a slow network still counts as progress.
            using var stall = CancellationTokenSource.CreateLinkedTokenSource(cancel);
            stall.CancelAfter(StallTimeout);
            var readTask = source.ReadAsync(buffer, 0, buffer.Length, stall.Token);
            var finished = await Task.WhenAny(readTask, Task.Delay(Timeout.Infinite, stall.Token)).ConfigureAwait(false);
            if (finished != readTask)
            {
                cancel.ThrowIfCancellationRequested();
                throw new TimeoutException($"no data for {StallTimeout.TotalSeconds:0} s");
            }
            var read = await readTask.ConfigureAwait(false);
            if (read == 0)
            {
                break;
            }
            await file.WriteAsync(buffer, 0, read, cancel).ConfigureAwait(false);
            done += read;
            progress(done, total);
        }
        if (total > 0 && done != total)
        {
            throw new IOException($"the download ended early ({done} of {total} bytes)");
        }
        Log.Write($"downloaded {done / Bytes.PerMb:0.0} MB");
    }

    /// <summary>Runs an installer and waits; with <paramref name="elevate"/> Windows asks for permission first.</summary>
    public static Task<int> RunAsync(string file, string arguments, bool elevate, CancellationToken cancel) => Task.Run(() =>
    {
        var start = new ProcessStartInfo(file, arguments) { UseShellExecute = elevate, CreateNoWindow = true };
        if (elevate && !Elevation.IsElevated)
        {
            start.Verb = WindowsNames.RunAs;
        }
        try
        {
            using var process = Process.Start(start)!;
            while (!process.WaitForExit(PollMs))
            {
                cancel.ThrowIfCancellationRequested();
            }
            return process.ExitCode;
        }
        catch (Win32Exception e) when (e.NativeErrorCode == WindowsCodes.Cancelled)
        {
            return WindowsCodes.Cancelled; // the permission prompt was declined
        }
    }, cancel);
}

/// <summary>Checks a downloaded or included installer is Authenticode-signed by Microsoft.</summary>
internal static class Signature
{
    public static bool IsMicrosoft(string file)
    {
        if (!Verified(file))
        {
            return false;
        }
        try
        {
            var subject = new X509Certificate2(X509Certificate.CreateFromSignedFile(file)).Subject;
            return subject.IndexOf("O=Microsoft Corporation", StringComparison.OrdinalIgnoreCase) >= 0;
        }
        catch (System.Security.Cryptography.CryptographicException)
        {
            return false;
        }
    }

    /// <summary>WTD_CACHE_ONLY_URL_RETRIEVAL: revocation checked from the cache only, so there's no network wait.</summary>
    private const uint RevocationCheckCacheOnly = 0x00000080;

    private static bool Verified(string file)
    {
        var fileInfo = new WinTrustFileInfo { cbStruct = (uint)Marshal.SizeOf<WinTrustFileInfo>(), pcwszFilePath = file };
        var filePtr = Marshal.AllocHGlobal(Marshal.SizeOf<WinTrustFileInfo>());
        try
        {
            Marshal.StructureToPtr(fileInfo, filePtr, false);
            var data = new WinTrustData
            {
                cbStruct = (uint)Marshal.SizeOf<WinTrustData>(),
                dwUIChoice = 2, // no UI
                fdwRevocationChecks = 0,
                dwUnionChoice = 1, // a file
                pFile = filePtr,
                dwStateAction = 0,
                dwProvFlags = RevocationCheckCacheOnly,
            };
            var action = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE"); // WINTRUST_ACTION_GENERIC_VERIFY_V2
            var result = WinVerifyTrust(IntPtr.Zero, ref action, ref data);
            if (result != 0)
            {
                Log.Write($"{Path.GetFileName(file)}: signature check failed (0x{result:X8})");
            }
            return result == 0;
        }
        finally
        {
            Marshal.FreeHGlobal(filePtr);
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WinTrustFileInfo
    {
        public uint cbStruct;
        public string pcwszFilePath;
        public IntPtr hFile;
        public IntPtr pgKnownSubject;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WinTrustData
    {
        public uint cbStruct;
        public IntPtr pPolicyCallbackData;
        public IntPtr pSIPClientData;
        public uint dwUIChoice;
        public uint fdwRevocationChecks;
        public uint dwUnionChoice;
        public IntPtr pFile;
        public uint dwStateAction;
        public IntPtr hWVTStateData;
        public IntPtr pwszURLReference;
        public uint dwProvFlags;
        public uint dwUIContext;
        public IntPtr pSignatureSettings;
    }

    [DllImport("wintrust.dll", CharSet = CharSet.Unicode)]
    private static extern int WinVerifyTrust(IntPtr hwnd, ref Guid action, ref WinTrustData data);
}
