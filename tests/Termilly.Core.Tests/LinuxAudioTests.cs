using System.Runtime.Versioning;
using Termilly.Linux;

namespace Termilly.Core.Tests;

/// <summary>The sound server's outputs, read from what <c>pactl list sinks</c> prints.</summary>
[SupportedOSPlatform("linux")] // only parsing text: runs anywhere
public sealed class LinuxAudioTests
{
    [Fact]
    public void Each_sink_is_an_output_named_by_its_description()
    {
        const string text = "Sink #47\n\tState: SUSPENDED\n\tName: alsa_output.pci-0000_00_1f.3.analog-stereo\n\tDescription: Built-in Audio Analog Stereo\n"
            + "\tDriver: PipeWire\n\tProperties:\n\t\tdevice.description = \"Built-in Audio\"\n\nSink #52\n\tName: bluez_output.headset\n\tDescription: \n";
        Assert.Equal(
            [new("alsa_output.pci-0000_00_1f.3.analog-stereo", "Built-in Audio Analog Stereo"), new("bluez_output.headset", "bluez_output.headset")],
            LinuxAudio.Sinks(text));
    }

    [Fact]
    public void No_sound_server_lists_no_outputs() => Assert.Empty(LinuxAudio.Sinks(""));
}
