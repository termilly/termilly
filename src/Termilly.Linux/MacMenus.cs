using System.Runtime.Versioning;
using static Termilly.Linux.MacObjC;

namespace Termilly.Linux;

/// <summary>
/// macOS: the menu bar every Mac app has, an app menu that ends in Quit and an Edit menu. Photino makes one menu with
/// Cut, Copy and Paste beside Quit, so macOS takes it for the Edit menu and adds AutoFill, Dictation and Emoji below
/// Quit. With an Edit menu of its own they go there.
/// </summary>
[SupportedOSPlatform("macos")]
internal static class MacMenus
{
    /// <summary>The Edit menu's title: macOS finds the Edit menu by it.</summary>
    private const string EditTitle = "Edit";
    private const string MenuClass = "NSMenu";
    private const string ItemClass = "NSMenuItem";

    /// <summary>NSEventModifierFlags.</summary>
    [Flags]
    private enum Modifiers : ulong
    {
        Shift = 1 << 17,
        Option = 1 << 19,
        Command = 1 << 20,
    }

    /// <summary>A menu item: no key is an item without a shortcut, no modifiers is Command alone.</summary>
    private sealed record Item(string Title, string Action, string Key = "", Modifiers Modifiers = Modifiers.Command);

    /// <summary>Replaces Photino's menu bar; the same actions, so Copy, Paste and Quit (MacQuit) work as before.</summary>
    public static void Set(string appName)
    {
        var bar = Send(Send(Class(MenuClass), Cocoa.Alloc), "init");
        Add(bar, appName,
        [
            new($"About {appName}", "orderFrontStandardAboutPanel:"),
            null,
            new($"Hide {appName}", "hide:", "h"),
            new("Hide Others", "hideOtherApplications:", "h", Modifiers.Command | Modifiers.Option),
            new("Show All", "unhideAllApplications:"),
            null,
            new($"Quit {appName}", "terminate:", "q"),
        ]);
        Add(bar, EditTitle,
        [
            new("Undo", "undo:", "z"),
            new("Redo", "redo:", "z", Modifiers.Command | Modifiers.Shift),
            null,
            new("Cut", "cut:", "x"),
            new("Copy", "copy:", "c"),
            new("Paste", "paste:", "v"),
            new("Select All", "selectAll:", "a"),
        ]);
        Send(Send(Class(Cocoa.Application), Cocoa.SharedApplication), "setMainMenu:", bar);
        Send(bar, Cocoa.Release);
    }

    /// <summary>Adds a menu titled <paramref name="title"/> to the bar; a null item is a separator line.</summary>
    private static void Add(IntPtr bar, string title, Item?[] items)
    {
        var menu = Send(Send(Class(MenuClass), Cocoa.Alloc), "initWithTitle:", NsString(title));
        foreach (var item in items)
        {
            AddOwned(menu, item is null ? Send(Send(Class(ItemClass), "separatorItem"), "retain") : NewItem(item));
        }
        var holder = NewItem(new Item(title, ""));
        Send(holder, "setSubmenu:", menu);
        Send(menu, Cocoa.Release);
        AddOwned(bar, holder);
    }

    private static IntPtr NewItem(Item item)
    {
        var action = item.Action.Length == 0 ? IntPtr.Zero : Sel(item.Action);
        var menuItem = Send(Send(Class(ItemClass), Cocoa.Alloc), "initWithTitle:action:keyEquivalent:",
            NsString(item.Title), action, NsString(item.Key));
        if (item.Modifiers != Modifiers.Command)
        {
            Send(menuItem, "setKeyEquivalentModifierMask:", new IntPtr((long)item.Modifiers));
        }
        return menuItem;
    }

    /// <summary>The menu keeps the item, so this code lets go of it.</summary>
    private static void AddOwned(IntPtr menu, IntPtr item)
    {
        Send(menu, "addItem:", item);
        Send(item, Cocoa.Release);
    }
}
