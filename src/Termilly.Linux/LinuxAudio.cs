using System.Globalization;
using System.IO;
using Termilly.Desktop.Platform;
using Termilly.Desktop.Services;

namespace Termilly.Linux;

/// <summary>
/// The sound server's outputs (sinks, from pactl: PulseAudio, or PipeWire's stand-in for it), and the notification
/// sounds played on one with paplay.
/// </summary>
internal sealed class LinuxAudio(IProcessRunner runner) : IAudioOutputs
{
    private const string Pactl = "pactl";
    private const string Paplay = "paplay";
    /// <summary>paplay's full volume: 65536 is 100%.</summary>
    private const double FullVolume = 65536;
    private const string NameField = "Name:";
    private const string DescriptionField = "Description:";
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);
    /// <summary>pactl's field names in English, whatever the desktop's language.</summary>
    private static readonly Dictionary<string, string> English = new() { ["LC_ALL"] = "C" };

    public async Task<IReadOnlyList<AudioOutput>> ListAsync()
    {
        try
        {
            var result = await runner.RunAsync(new ProcessRequest(Pactl, ["list", "sinks"]) { Environment = English, Timeout = Timeout }).ConfigureAwait(false);
            return Sinks(result.Text);
        }
        catch (IOException)
        {
            return []; // no pactl: only the default output
        }
    }

    public void Play(string file, double volume, string device) => _ = Task.Run(async () =>
    {
        var level = ((int)Math.Round(volume * FullVolume)).ToString(CultureInfo.InvariantCulture);
        try
        {
            // An output that's gone fails on PulseAudio (PipeWire plays on the default itself): play it there then.
            var played = await runner.RunAsync(new ProcessRequest(Paplay, [$"--device={device}", $"--volume={level}", file]) { Timeout = Timeout }).ConfigureAwait(false);
            if (played.ExitCode != 0)
            {
                await runner.RunAsync(new ProcessRequest(Paplay, [$"--volume={level}", file]) { Timeout = Timeout }).ConfigureAwait(false);
            }
        }
        catch (IOException)
        {
            // no paplay, or it hung: no sound
        }
    });

    /// <summary>The outputs in <c>pactl list sinks</c>' output: each one's Name, and its Description to show.</summary>
    internal static IReadOnlyList<AudioOutput> Sinks(string text)
    {
        var outputs = new List<AudioOutput>();
        string? name = null;
        foreach (var line in text.Split('\n').Select(l => l.Trim()))
        {
            if (line.StartsWith(NameField, StringComparison.Ordinal))
            {
                name = line[NameField.Length..].Trim();
            }
            else if (line.StartsWith(DescriptionField, StringComparison.Ordinal) && name is { Length: > 0 })
            {
                outputs.Add(new AudioOutput(name, line[DescriptionField.Length..].Trim() is { Length: > 0 } shown ? shown : name));
                name = null;
            }
        }
        return outputs;
    }
}
