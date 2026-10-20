using System.Reflection;

namespace Termilly.Shared;

internal static class AppVersion
{
    /// <summary>A version shows major.minor.patch; the assembly's fourth part is always 0.</summary>
    private const int Parts = 3;

    /// <summary>What a build without a version counts as: the oldest, so any release is newer.</summary>
    private const string Unknown = "0.0.0";

    /// <summary>This build's version, as About shows it ("0.1.0").</summary>
    public static string Current { get; } = Assembly.GetExecutingAssembly().GetName().Version?.ToString(Parts) ?? Unknown;
}
