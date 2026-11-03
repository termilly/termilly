using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Termilly.Desktop.Platform;

namespace Termilly.Linux;

/// <summary>
/// The fonts installed on macOS, from CoreText: every face's family, and its symbolic traits for which are
/// monospace and which of those have a real bold face. Families starting with a dot are the system's own hidden ones.
/// </summary>
[SupportedOSPlatform("macos")]
internal sealed class MacFonts : IFontCatalog
{
    private const string CoreText = "/System/Library/Frameworks/CoreText.framework/CoreText";
    private const string CoreFoundation = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
    /// <summary>kCTFontBoldTrait and kCTFontMonoSpaceTrait in a face's symbolic traits.</summary>
    private const int BoldTrait = 1 << 1;
    private const int MonoSpaceTrait = 1 << 10;
    /// <summary>CFNumberGetValue's kCFNumberSInt32Type.</summary>
    private const int SInt32Type = 3;
    private const char HiddenPrefix = '.';

    public InstalledFonts Read()
    {
        var all = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        var mono = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        var bold = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        var library = NativeLibrary.Load(CoreText);
        var familyKey = Constant(library, "kCTFontFamilyNameAttribute");
        var traitsKey = Constant(library, "kCTFontTraitsAttribute");
        var symbolicKey = Constant(library, "kCTFontSymbolicTrait");

        var collection = CTFontCollectionCreateFromAvailableFonts(IntPtr.Zero);
        var faces = collection == IntPtr.Zero ? IntPtr.Zero : CTFontCollectionCreateMatchingFontDescriptors(collection);
        try
        {
            var count = faces == IntPtr.Zero ? 0 : CFArrayGetCount(faces);
            for (nint i = 0; i < count; i++)
            {
                var face = CFArrayGetValueAtIndex(faces, i);
                if (Family(face, familyKey) is not { Length: > 0 } family || family[0] == HiddenPrefix)
                {
                    continue;
                }
                all.Add(family);
                var traits = Traits(face, traitsKey, symbolicKey);
                if ((traits & MonoSpaceTrait) != 0)
                {
                    mono.Add(family);
                    if ((traits & BoldTrait) != 0)
                    {
                        bold.Add(family);
                    }
                }
            }
        }
        finally
        {
            Release(faces);
            Release(collection);
        }
        return new InstalledFonts([.. all], [.. mono], [.. bold]);
    }

    /// <summary>A CFStringRef CoreText exports (a key of a descriptor's attributes).</summary>
    private static IntPtr Constant(IntPtr library, string name) => Marshal.ReadIntPtr(NativeLibrary.GetExport(library, name));

    private static string? Family(IntPtr face, IntPtr familyKey)
    {
        var name = CTFontDescriptorCopyAttribute(face, familyKey);
        try
        {
            return name == IntPtr.Zero ? null : Text(name);
        }
        finally
        {
            Release(name);
        }
    }

    /// <summary>A face's symbolic traits (bold, italic, monospace…), or none when it doesn't say.</summary>
    private static int Traits(IntPtr face, IntPtr traitsKey, IntPtr symbolicKey)
    {
        var traits = CTFontDescriptorCopyAttribute(face, traitsKey);
        try
        {
            var number = traits == IntPtr.Zero ? IntPtr.Zero : CFDictionaryGetValue(traits, symbolicKey);
            return number != IntPtr.Zero && CFNumberGetValue(number, SInt32Type, out var value) ? value : 0;
        }
        finally
        {
            Release(traits);
        }
    }

    private static string Text(IntPtr cfString)
    {
        var length = CFStringGetLength(cfString);
        var chars = new char[length];
        CFStringGetCharacters(cfString, new CFRange(0, length), chars);
        return new string(chars);
    }

    private static void Release(IntPtr value)
    {
        if (value != IntPtr.Zero)
        {
            CFRelease(value);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private readonly record struct CFRange(nint Location, nint Length);

    [DllImport(CoreText)] private static extern IntPtr CTFontCollectionCreateFromAvailableFonts(IntPtr options);
    [DllImport(CoreText)] private static extern IntPtr CTFontCollectionCreateMatchingFontDescriptors(IntPtr collection);
    [DllImport(CoreText)] private static extern IntPtr CTFontDescriptorCopyAttribute(IntPtr descriptor, IntPtr attribute);
    [DllImport(CoreFoundation)] private static extern nint CFArrayGetCount(IntPtr array);
    [DllImport(CoreFoundation)] private static extern IntPtr CFArrayGetValueAtIndex(IntPtr array, nint index);
    [DllImport(CoreFoundation)] private static extern IntPtr CFDictionaryGetValue(IntPtr dictionary, IntPtr key);
    [DllImport(CoreFoundation)] [return: MarshalAs(UnmanagedType.U1)] private static extern bool CFNumberGetValue(IntPtr number, int type, out int value);
    [DllImport(CoreFoundation)] private static extern nint CFStringGetLength(IntPtr text);
    // CFString's characters are UTF-16, as .NET's are: copied straight into the array.
    [DllImport(CoreFoundation, CharSet = CharSet.Unicode)] private static extern void CFStringGetCharacters(IntPtr text, CFRange range, [Out] char[] buffer);
    [DllImport(CoreFoundation)] private static extern void CFRelease(IntPtr value);
}
