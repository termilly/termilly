using System.IO;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Platform;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>
/// The notification sounds on an output other than the default (Settings › Notifications): lists the outputs, and
/// plays one of Termilly's own sounds (wwwroot/sounds) when the page asks; the page plays them on the default itself.
/// </summary>
internal sealed class SoundHandler(PageChannel page, IAudioOutputs outputs) : IMessageHandler
{
    private const string Folder = "sounds";
    private const string Extension = ".mp3";
    private const double Percent = 100;

    public void Register(MessageRouter router)
    {
        router.On<FromPage.SoundOutputs>(async _ => page.Post(new ToPage.SoundOutputs(await outputs.ListAsync().ConfigureAwait(false))));
        router.On<FromPage.SoundPlay>(Play);
    }

    private void Play(FromPage.SoundPlay message)
    {
        // Only Termilly's own sounds, by name: the page never sends a path.
        if (message.Name == SettingValues.Sound.None || !SettingValues.Sound.All.Contains(message.Name) || message.Device.Length == 0)
        {
            return;
        }
        var volume = Math.Clamp(message.Volume, SettingValues.SoundVolume.Min, SettingValues.SoundVolume.Max) / Percent;
        outputs.Play(Path.Combine(AppPaths.WebRoot, Folder, message.Name + Extension), volume, message.Device);
    }
}
