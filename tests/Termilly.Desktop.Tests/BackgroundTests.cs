using System.IO;
using System.Text.Json;
using Termilly.Desktop.Features;

namespace Termilly.Desktop.Tests;

/// <summary>The window's background settings and the pictures kept for it (Settings/BackgroundSettings.cs, Features/BackgroundPictures.cs).</summary>
public sealed class BackgroundTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "termilly-tests", Guid.NewGuid().ToString("N"));

    public BackgroundTests() => Directory.CreateDirectory(_dir);

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private string Write(string name, byte[] bytes)
    {
        var path = Path.Combine(_dir, name);
        File.WriteAllBytes(path, bytes);
        return path;
    }

    [Fact]
    public void The_defaults_are_a_solid_window_with_no_picture_as_before()
    {
        var settings = new AppSettings().Normalize().Background;
        Assert.False(settings.SeeThrough);
        Assert.Equal(BackgroundValues.Opacity.Max, settings.Opacity);
        Assert.Equal(BackgroundValues.Effect.None, settings.Effect);
        Assert.Null(settings.Picture);
    }

    [Fact]
    public void Values_out_of_range_or_unknown_become_the_nearest_or_the_default()
    {
        var settings = new BackgroundSettings { Opacity = 5, Effect = "glass", Fit = "zoom", Dim = 500, Blur = -3, Behind = "desk" }.Normalize();
        Assert.Equal(BackgroundValues.Opacity.Min, settings.Opacity);
        Assert.True(settings.SeeThrough);
        Assert.Equal(BackgroundValues.Effect.Default, settings.Effect);
        Assert.Equal(BackgroundValues.Fit.Default, settings.Fit);
        Assert.Equal(BackgroundValues.Dim.Max, settings.Dim);
        Assert.Equal(BackgroundValues.Blur.Min, settings.Blur);
        Assert.Equal(BackgroundValues.Behind.Default, settings.Behind);
    }

    [Theory]
    [InlineData("../settings.json")]
    [InlineData("0123456789abcdef.exe")]
    [InlineData("0123456789ABCDEF.png")]
    [InlineData("C:\\Users\\me\\photo.png")]
    [InlineData("")]
    public void A_picture_name_that_could_reach_outside_the_folder_or_isnt_a_picture_is_dropped(string name)
    {
        Assert.Null(new BackgroundSettings { Picture = name }.Normalize().Picture);
        Assert.Null(BackgroundPictures.FileFor(_dir, name));
    }

    [Fact]
    public void The_group_saves_and_reads_back_as_the_page_sends_it()
    {
        var values = JsonSerializer.SerializeToElement(new { opacity = 70, effect = "blur", picture = "0123456789abcdef.jpg", behind = "window" });
        var saved = new AppSettings().WithGroup("background", values).Background;
        Assert.Equal(70, saved.Opacity);
        Assert.Equal(BackgroundValues.Effect.Blur, saved.Effect);
        Assert.Equal("0123456789abcdef.jpg", saved.Picture);
        Assert.Equal(BackgroundValues.Behind.Window, saved.Behind);
        Assert.DoesNotContain("seeThrough", JsonSerializer.Serialize(saved, AppSettings.Json), StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_picture_is_kept_under_a_name_from_its_content_once_however_often_it_is_picked()
    {
        var first = Write("Sunset.PNG", [1, 2, 3, 4]);
        var again = Write("copy.png", [1, 2, 3, 4]);
        var folder = Path.Combine(_dir, "backgrounds");
        var name = await BackgroundPictures.KeepAsync(first, folder);
        Assert.Equal(name, await BackgroundPictures.KeepAsync(again, folder));
        Assert.True(BackgroundPictures.IsName(name));
        Assert.EndsWith(".png", name, StringComparison.Ordinal);
        Assert.Single(Directory.GetFiles(folder));
        Assert.Equal(Path.Combine(folder, name), BackgroundPictures.FileFor(folder, name));
    }

    [Fact]
    public async Task A_file_that_isnt_a_picture_is_refused_with_a_reason()
    {
        var text = Write("notes.txt", [65]);
        var error = await Assert.ThrowsAsync<InvalidDataException>(() => BackgroundPictures.KeepAsync(text, Path.Combine(_dir, "backgrounds")));
        Assert.Contains("PNG", error.Message, StringComparison.Ordinal);
    }
}
