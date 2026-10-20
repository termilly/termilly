using System;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace Termilly.Setup.Engine;

/// <summary>What setup adds to Windows besides the files: shortcuts, the Explorer menu and the PATH entry.</summary>
internal static class Shell
{
    private static readonly char[] PathSeparator = [';'];

    // ---- Shortcuts ----

    public static string StartMenuShortcut(bool allUsers) => Path.Combine(
        Environment.GetFolderPath(allUsers ? Environment.SpecialFolder.CommonPrograms : Environment.SpecialFolder.Programs), InstalledFiles.Shortcut);

    public static string DesktopShortcut(bool allUsers) => Path.Combine(
        Environment.GetFolderPath(allUsers ? Environment.SpecialFolder.CommonDesktopDirectory : Environment.SpecialFolder.DesktopDirectory), InstalledFiles.Shortcut);

    /// <summary>A .lnk to <paramref name="target"/>, its icon taken from the exe.</summary>
    public static void CreateShortcut(string path, string target, string description)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var link = (IShellLinkW)new ShellLink();
        link.SetPath(target);
        link.SetWorkingDirectory(Path.GetDirectoryName(target)!);
        link.SetDescription(description);
        link.SetIconLocation(target, 0);
        ((IPersistFile)link).Save(path, true);
        Marshal.ReleaseComObject(link);
    }

    public static void Delete(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
                Log.Write($"removed {path}");
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            Log.Write($"couldn't remove {path}: {e.Message}");
        }
    }

    // ---- "Open in Termilly" on folders, folder backgrounds and drives ----

    private static readonly string[] MenuParents = { @"Directory\shell", @"Directory\Background\shell", @"Drive\shell" };

    public static void AddExplorerMenu(bool allUsers, string exe)
    {
        using var classes = Classes(allUsers, writable: true);
        foreach (var parent in MenuParents)
        {
            using var verb = classes.CreateSubKey($@"{parent}\Termilly");
            verb.SetValue("", "Open in Termilly");
            verb.SetValue("Icon", $"\"{exe}\",0");
            using var command = verb.CreateSubKey("command");
            command.SetValue("", $"\"{exe}\" --open \"%V\"");
        }
        Log.Write("added \"Open in Termilly\" to Explorer");
    }

    public static void RemoveExplorerMenu(bool allUsers)
    {
        using var classes = Classes(allUsers, writable: true);
        foreach (var parent in MenuParents)
        {
            classes.DeleteSubKeyTree($@"{parent}\Termilly", throwOnMissingSubKey: false);
        }
    }

    private static RegistryKey Classes(bool allUsers, bool writable) =>
        RegistryKey.OpenBaseKey(allUsers ? RegistryHive.LocalMachine : RegistryHive.CurrentUser, RegistryView.Registry64)
            .OpenSubKey(@"Software\Classes", writable)!;

    // ---- PATH ----

    private const string UserEnvironment = WindowsNames.Environment;
    /// <summary>HWND_BROADCAST and WM_SETTINGCHANGE: tell every window the environment changed, so new programs see PATH;
    /// SMTO_ABORTIFHUNG and the wait, so a window that doesn't answer doesn't hold setup up.</summary>
    private static readonly IntPtr BroadcastToAll = (IntPtr)0xffff;
    private const uint SettingChange = 0x001A;
    private const uint AbortIfHung = 0x0002;
    private const uint BroadcastTimeoutMs = 3000;
    private const string MachineEnvironment = @"SYSTEM\CurrentControlSet\Control\Session Manager\Environment";

    public static void AddToPath(bool allUsers, string folder) => EditPath(allUsers, entries => entries.Any(e => SamePath(e, folder)) ? entries : entries.Concat(new[] { folder }).ToArray());

    public static void RemoveFromPath(bool allUsers, string folder) => EditPath(allUsers, entries => entries.Where(e => !SamePath(e, folder)).ToArray());

    private static void EditPath(bool allUsers, Func<string[], string[]> edit)
    {
        using var root = RegistryKey.OpenBaseKey(allUsers ? RegistryHive.LocalMachine : RegistryHive.CurrentUser, RegistryView.Registry64);
        using var key = root.OpenSubKey(allUsers ? MachineEnvironment : UserEnvironment, writable: true) ?? root.CreateSubKey(UserEnvironment);
        // Read unexpanded, so %USERPROFILE%-style entries stay as the user wrote them.
        var current = key.GetValue(WindowsNames.Path, "", RegistryValueOptions.DoNotExpandEnvironmentNames) as string ?? "";
        var entries = current.Split(PathSeparator, StringSplitOptions.RemoveEmptyEntries);
        var edited = edit(entries);
        if (edited.SequenceEqual(entries))
        {
            return;
        }
        key.SetValue(WindowsNames.Path, string.Join(";", edited), RegistryValueKind.ExpandString);
        Log.Write($"PATH updated ({(allUsers ? "all users" : "this user")})");
        // Tell Explorer, so terminals opened from now on see it.
        SendMessageTimeout(BroadcastToAll, SettingChange, IntPtr.Zero, WindowsNames.Environment, AbortIfHung, BroadcastTimeoutMs, out _);
    }

    private static bool SamePath(string a, string b) =>
        string.Equals(Environment.ExpandEnvironmentVariables(a).TrimEnd('\\'), b.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);

    // ---- COM and Win32 ----

    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    private class ShellLink
    {
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
    private interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszFile, int cch, IntPtr pfd, int fFlags);
        void GetIDList(out IntPtr ppidl);
        void SetIDList(IntPtr pidl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszName, int cch);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszDir, int cch);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszArgs, int cch);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
        void GetHotkey(out short pwHotkey);
        void SetHotkey(short wHotkey);
        void GetShowCmd(out int piShowCmd);
        void SetShowCmd(int iShowCmd);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszIconPath, int cch, out int piIcon);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, int dwReserved);
        void Resolve(IntPtr hwnd, int fFlags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("0000010b-0000-0000-C000-000000000046")]
    private interface IPersistFile
    {
        void GetClassID(out Guid pClassID);
        [PreserveSig] int IsDirty();
        void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, uint dwMode);
        void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, [MarshalAs(UnmanagedType.Bool)] bool fRemember);
        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
        void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, string lParam, uint flags, uint timeout, out IntPtr result);
}
