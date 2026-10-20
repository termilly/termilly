using System.IO;
using System.Security;
using System.Text.Json;
using Microsoft.Win32;
using Termilly.Desktop.Services;
using Windows.Data.Xml.Dom;
using Windows.UI.Notifications;

namespace Termilly.Desktop;

/// <summary>
/// Windows notifications (toasts) for agent events in terminals the user can't see. An unpackaged app needs an
/// AppUserModelID Windows knows: it's registered once under HKCU\Software\Classes\AppUserModelId with Termilly's
/// name and icon, which is enough for toasts on Windows 10 1903 and later without a Start-menu shortcut. Clicking a
/// toast while Termilly runs brings it forward on that terminal (<see cref="ToastNotification.Activated"/>).
/// </summary>
/// <remarks>TERMILLY_TOAST_LOG=&lt;file&gt; writes the toasts there as JSON lines instead, for tests.</remarks>
internal sealed class Notifications
{
    /// <summary>The longest tag Windows takes for a notification.</summary>
    private const int MaxTag = 64;
    /// <summary>The app's name in its notification registration, as Windows shows it.</summary>
    private const string DisplayNameValue = "DisplayName";

    public const string AppId = "Termilly.Termilly";
    private const string Group = "agents";

    private readonly Action<string> _activated;
    private readonly string? _log = Environment.GetEnvironmentVariable("TERMILLY_TOAST_LOG") is { Length: > 0 } log ? log : null;
    /// <summary>Shown toasts by terminal, kept alive so their Activated event still fires when clicked.</summary>
    private readonly Dictionary<string, ToastNotification> _shown = new();
    private ToastNotifier? _notifier;

    /// <param name="activated">Called on a pool thread with the terminal id when its toast is clicked.</param>
    public Notifications(Action<string> activated) => _activated = activated;

    /// <summary>Shows (or replaces) the toast for a terminal.</summary>
    public void Show(string terminal, string title, string body)
    {
        if (_log is not null)
        {
            File.AppendAllText(_log, JsonSerializer.Serialize(new LoggedToast(terminal, title, body), PageChannel.Json) + Environment.NewLine);
            return;
        }
        try
        {
            _notifier ??= CreateNotifier();
            var toast = new ToastNotification(ToastXml(terminal, title, body)) { Tag = Tag(terminal), Group = Group };
            toast.Activated += (_, _) => _activated(terminal);
            _shown[terminal] = toast;
            _notifier.Show(toast);
        }
        catch (Exception e) when (Storage.IsFileError(e) || e is SecurityException or System.Runtime.InteropServices.COMException)
        {
            // Notifications off for the app, Focus Assist, or no notification platform: the in-app inbox still has it.
        }
    }

    /// <summary>The user is looking at the terminal now: its toast is old news, so it leaves the Action Center.</summary>
    public void Withdraw(string terminal)
    {
        if (_log is not null || !_shown.Remove(terminal))
        {
            return;
        }
        try
        {
            ToastNotificationManager.History.Remove(Tag(terminal), Group, AppId);
        }
        catch (Exception e) when (e is System.Runtime.InteropServices.COMException or ArgumentException)
        {
            // Already dismissed.
        }
    }

    /// <summary>Tags are limited to 64 characters; terminal ids are far shorter.</summary>
    private static string Tag(string terminal) => terminal.Length <= MaxTag ? terminal : terminal[..MaxTag];

    private static ToastNotifier CreateNotifier()
    {
        Register(Path.Combine(AppPaths.Assets, "toast.png"));
        return ToastNotificationManager.CreateToastNotifier(AppId);
    }

    /// <summary>Tells Windows the app's name and icon for its notifications (per user, no admin rights).</summary>
    private static void Register(string icon)
    {
        using var key = Registry.CurrentUser.CreateSubKey($@"Software\Classes\AppUserModelId\{AppId}");
        key.SetValue(DisplayNameValue, Product.Name);
        if (File.Exists(icon))
        {
            key.SetValue("IconUri", icon);
        }
    }

    /// <summary>The toast: title and body, opening the terminal on click.</summary>
    public static XmlDocument ToastXml(string terminal, string title, string body)
    {
        var xml = new XmlDocument();
        xml.LoadXml(ToastXmlText(terminal, title, body));
        return xml;
    }

    public static string ToastXmlText(string terminal, string title, string body) =>
        $"""
        <toast launch="{Escape("terminal=" + terminal)}">
          <visual><binding template="ToastGeneric"><text hint-maxLines="1">{Escape(title)}</text><text>{Escape(body)}</text></binding></visual>
        </toast>
        """;

    private static string Escape(string text) => SecurityElement.Escape(text) ?? "";

    /// <summary>A toast as TERMILLY_TOAST_LOG writes it.</summary>
    private sealed record LoggedToast(string Terminal, string Title, string Body);
}
