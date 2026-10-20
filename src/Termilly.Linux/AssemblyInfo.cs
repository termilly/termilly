// This build of Termilly runs on Linux: Linux-only APIs are fine here, and Windows-only calls in the shared code
// are flagged by the platform analyzer unless they're behind an OperatingSystem.IsWindows() check.
[assembly: System.Runtime.Versioning.SupportedOSPlatform("linux")]
