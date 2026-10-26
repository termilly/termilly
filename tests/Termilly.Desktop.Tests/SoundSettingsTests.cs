namespace Termilly.Desktop.Tests;

public sealed class SoundSettingsTests
{
    [Fact]
    public void Sounds_start_with_a_ping_when_an_agent_needs_you_and_silence_elsewhere()
    {
        var sounds = new NotificationSettings().Normalize();
        Assert.Equal(SettingValues.Sound.Ping1, sounds.SoundNeedsInput);
        Assert.Equal(SettingValues.Sound.None, sounds.SoundError);
        Assert.Equal(SettingValues.Sound.None, sounds.SoundDone);
        Assert.Equal(SettingValues.Sound.None, sounds.SoundQuit);
        Assert.Equal(SettingValues.SoundVolume.Default, sounds.SoundVolume);
    }

    [Fact]
    public void A_sound_or_volume_that_isnt_one_becomes_the_default()
    {
        var sounds = new NotificationSettings { SoundNeedsInput = "ping-9", SoundError = "../../evil", SoundVolume = 250 }.Normalize();
        Assert.Equal(SettingValues.Sound.Ping1, sounds.SoundNeedsInput);
        Assert.Equal(SettingValues.Sound.None, sounds.SoundError);
        Assert.Equal(SettingValues.SoundVolume.Default, sounds.SoundVolume);
    }
}
