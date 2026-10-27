using System.Runtime.InteropServices;
using Termilly.Desktop.Platform;
using Windows.Devices.Enumeration;
using Windows.Media.Core;
using Windows.Media.Devices;
using Windows.Media.Playback;

namespace Termilly.Desktop;

/// <summary>Windows' audio outputs (the ones its sound settings list), and the notification sounds played on one.</summary>
internal sealed class WindowsAudio : IAudioOutputs
{
    /// <summary>The sounds playing: a player that's collected stops, so each is kept until it ends.</summary>
    private readonly HashSet<MediaPlayer> _playing = [];

    public async Task<IReadOnlyList<AudioOutput>> ListAsync()
    {
        var devices = await DeviceInformation.FindAllAsync(MediaDevice.GetAudioRenderSelector());
        return [.. devices.Where(d => d.IsEnabled).Select(d => new AudioOutput(d.Id, d.Name)).OrderBy(o => o.Name, StringComparer.CurrentCultureIgnoreCase)];
    }

    public void Play(string file, double volume, string device) => _ = PlayAsync(file, volume, device);

    private async Task PlayAsync(string file, double volume, string device)
    {
        // Not a media session: nothing in the system's media controls, and no pausing other audio.
        var player = new MediaPlayer { Volume = volume, AudioCategory = MediaPlayerAudioCategory.SoundEffects };
        player.CommandManager.IsEnabled = false;
        if (await OutputOf(device) is { } output)
        {
            player.AudioDevice = output;
        }
        player.MediaEnded += (_, _) => Done(player);
        player.MediaFailed += (_, _) => Done(player);
        lock (_playing)
        {
            _playing.Add(player);
        }
        player.Source = MediaSource.CreateFromUri(new Uri(file));
        player.Play();
    }

    /// <summary>The output with this id, while it's there; null plays on the default one.</summary>
    private static async Task<DeviceInformation?> OutputOf(string device)
    {
        try
        {
            var output = await DeviceInformation.CreateFromIdAsync(device);
            return output.IsEnabled ? output : null;
        }
        catch (Exception e) when (e is COMException or ArgumentException)
        {
            return null; // unplugged, or gone from the system
        }
    }

    private void Done(MediaPlayer player)
    {
        lock (_playing)
        {
            _playing.Remove(player);
        }
        player.Dispose();
    }
}
