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
    public void A_sound_that_isnt_one_becomes_the_default()
    {
        var sounds = new NotificationSettings { SoundNeedsInput = "ping-9", SoundError = "../../evil" }.Normalize();
        Assert.Equal(SettingValues.Sound.Ping1, sounds.SoundNeedsInput);
        Assert.Equal(SettingValues.Sound.None, sounds.SoundError);
    }

    [Theory]
    [InlineData(250, 100)]
    [InlineData(-5, 0)]
    [InlineData(35, 35)]
    public void The_volume_is_kept_between_silent_and_full(int volume, int kept) =>
        Assert.Equal(kept, new NotificationSettings { SoundVolume = volume }.Normalize().SoundVolume);

    [Fact]
    public void A_blank_output_device_means_the_systems_default() =>
        Assert.Null(new NotificationSettings { SoundDevice = "  " }.Normalize().SoundDevice);
}
