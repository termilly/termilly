using System.Runtime.InteropServices;

namespace Termilly.Linux;

/// <summary>
/// A rectangle as Cocoa gives and takes it (CGRect / NSRect): from the bottom left of the main screen, in points. Plain
/// data, so the arithmetic on it (WindowFit) runs and is tested anywhere.
/// </summary>
[StructLayout(LayoutKind.Sequential)]
internal readonly record struct Rect(double X, double Y, double Width, double Height);
