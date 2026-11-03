using System.Globalization;
using Termilly.Desktop.Platform;
using Termilly.Desktop.Services;

namespace Termilly.Linux;

/// <summary>
/// Notification sounds on macOS, played with afplay. afplay plays only on the default output, so no others are
/// listed: Settings then offers the default alone, as on a Linux without pactl.
/// </summary>
internal sealed class MacAudio(IProcessRunner runner) : IAudioOutputs
{
    private const string Afplay = "afplay";
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    public Task<IReadOnlyList<AudioOutput>> ListAsync() => Task.FromResult<IReadOnlyList<AudioOutput>>([]);

    /// <summary>afplay's volume runs from 0 to 1, as Termilly's does; the device is the default whatever was chosen.</summary>
    public void Play(string file, double volume, string device) => _ = Task.Run(async () =>
    {
        try
        {
            await runner.RunAsync(new ProcessRequest(Afplay, ["-v", volume.ToString(CultureInfo.InvariantCulture), file]) { Timeout = Timeout }).ConfigureAwait(false);
        }
        catch (IOException)
        {
            // it hung: no sound
        }
    });
}
