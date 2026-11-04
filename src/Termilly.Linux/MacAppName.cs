using System.Runtime.Versioning;

namespace Termilly.Linux;

/// <summary>
/// macOS: the app's name in the menu bar, with its version ("Termilly 1.7.0"). The menu bar takes it from the running
/// program's bundle, and termilly runs beside Termilly.app rather than in it, so its own bundle is the build folder,
/// with no name of its own. Its information is kept in memory and can be changed, so the name is set there before the
/// window (and so the menu) is made.
/// </summary>
[SupportedOSPlatform("macos")]
internal static class MacAppName
{
    private const string NameKey = "CFBundleName";

    public static void Set(string name)
    {
        MacObjC.Load();
        var bundle = MacObjC.Send(MacObjC.Class("NSBundle"), "mainBundle");
        var info = MacObjC.Send(bundle, "infoDictionary");
        // Read-only on some systems: then the name stays as macOS has it.
        if (!MacObjC.SendBool(info, MacObjC.Cocoa.IsKindOfClass, MacObjC.Class("NSMutableDictionary")))
        {
            return;
        }
        MacObjC.Send(info, "setObject:forKey:", MacObjC.NsString(name), MacObjC.NsString(NameKey));
    }
}
