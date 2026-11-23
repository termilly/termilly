namespace Termilly.Desktop;

/// <summary>
/// The command line WebView2's browser starts with. Low memory (Settings › Appearance) keeps the graphics card out of it
/// altogether: measured with 9 full terminals, no VRAM at all and about 160 MB less RAM, as the GPU process stays small.
/// The page then draws terminals on the CPU too (js/gpu.js), since WebGL without a GPU is emulated on the CPU and costs
/// more memory than the plain renderer.
/// </summary>
internal static class BrowserArguments
{
    private const string NoGpu = "--disable-gpu";
    private const string DevToolsPort = "--remote-debugging-port=";

    /// <summary>The arguments, or null for none; <paramref name="devToolsPort"/> only in Debug builds' live tests.</summary>
    public static string? For(bool lowMemory, int? devToolsPort)
    {
        var args = new List<string>();
        if (devToolsPort is { } port)
        {
            args.Add($"{DevToolsPort}{port}");
        }
        if (lowMemory)
        {
            args.Add(NoGpu);
        }
        return args.Count > 0 ? string.Join(' ', args) : null;
    }
}
