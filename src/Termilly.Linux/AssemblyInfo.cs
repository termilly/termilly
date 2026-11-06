// This build of Termilly runs on Linux and macOS: their APIs are fine here behind a check for the one they're from,
// and Windows-only calls in the shared code are flagged by the platform analyzer unless they're behind an
// OperatingSystem.IsWindows() check.
[assembly: System.Runtime.Versioning.SupportedOSPlatform("linux")]
[assembly: System.Runtime.Versioning.SupportedOSPlatform("macos")]
