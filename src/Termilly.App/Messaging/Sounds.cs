using Termilly.Desktop.Platform;

namespace Termilly.Desktop.Messaging;

// Settings › Notifications › Sounds: the audio outputs to pick from, and a sound played on the one picked
// (Features/Sounds.cs, js/sounds.js).

internal static partial class FromPage
{
    /// <summary>The audio outputs, for the Output list.</summary>
    internal sealed record SoundOutputs : IPageMessage
    {
        public static string Type => "sound:outputs";
    }

    /// <summary>Plays a notification sound (a name from SettingValues.Sound) on an output other than the default.</summary>
    internal sealed record SoundPlay(string Name = "", int Volume = SettingValues.SoundVolume.Default, string Device = "") : IPageMessage
    {
        public static string Type => "sound:play";
    }
}

internal static partial class ToPage
{
    internal sealed record SoundOutputs(IReadOnlyList<AudioOutput> Outputs) : IHostMessage
    {
        public static string Type => "sound:outputs";
    }
}
