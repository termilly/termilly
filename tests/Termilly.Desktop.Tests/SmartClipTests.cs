using System.IO;
using Termilly.Desktop.Security;

namespace Termilly.Desktop.Tests;

public sealed class SmartClipTests : IDisposable
{
    private const string Here = "api server · backend";
    private const string Token = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "termilly-tests", Guid.NewGuid().ToString("N"));
    private readonly Vault _vault;
    private readonly long _now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    public SmartClipTests() => _vault = Vault.Open(_dir);

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private ClipStore Store()
    {
        var store = new ClipStore(_vault);
        store.Load();
        return store;
    }

    [Theory]
    [InlineData("https://github.com/example/backend/pull/128", ClipKinds.Url)]
    [InlineData(@"D:\work\backend\src\Api\appsettings.json", ClipKinds.Path)]
    [InlineData("/home/me/project/README.md", ClipKinds.Path)]
    [InlineData("/help", ClipKinds.Text)]
    [InlineData("Please keep the old column.", ClipKinds.Text)]
    [InlineData("export GITHUB_TOKEN=" + Token, ClipKinds.Secret)]
    public void Text_is_recognised(string text, string kind) => Assert.Equal(kind, ClipStore.Classify(text, null));

    [Fact]
    public void A_command_is_what_the_page_says_unless_it_holds_a_secret()
    {
        Assert.Equal(ClipKinds.Command, ClipStore.Classify("git log --oneline", ClipKinds.Command));
        Assert.Equal(ClipKinds.Secret, ClipStore.Classify("curl -H 'Authorization: Bearer " + Token + "'", ClipKinds.Command));
    }

    [Fact]
    public void Copied_again_a_clip_moves_to_the_top_and_keeps_the_better_source()
    {
        var store = Store();
        Assert.True(store.AddText("one", Here, null, _now));
        Assert.True(store.AddText("two", ClipStore.ClipboardSource, null, _now + 1));
        Assert.True(store.AddText("one", ClipStore.ClipboardSource, null, _now + 2));
        var views = store.Views();
        Assert.Equal(["one", "two"], views.Select(v => v.Text));
        Assert.Equal(Here, views[0].Source);
        // The clipboard telling about Termilly's own copy right after it changes nothing.
        Assert.False(store.AddText("one", ClipStore.ClipboardSource, null, _now + 3));
    }

    [Fact]
    public void Past_the_limit_the_oldest_go_but_pinned_clips_stay()
    {
        var store = Store();
        store.Limit = 2;
        store.AddText("pinned", Here, null, _now);
        store.Pin(store.Views()[0].Id, pinned: true);
        for (var i = 0; i < 4; i++)
        {
            store.AddText($"clip {i}", Here, null, _now + i + 1);
        }
        Assert.Equal(["clip 3", "clip 2", "pinned"], store.Views().Select(v => v.Text));
    }

    [Fact]
    public void A_secret_shows_masked_is_never_pinned_or_written_and_goes_after_a_while()
    {
        var store = Store();
        store.AddText("export GITHUB_TOKEN=" + Token, Here, null, _now);
        var secret = store.Views()[0];
        Assert.DoesNotContain(Token, secret.Text, StringComparison.Ordinal);
        Assert.Contains(Token, store.TextOf(secret.Id), StringComparison.Ordinal);
        Assert.False(store.Pin(secret.Id, pinned: true));

        store.AddText("plain", Here, null, _now);
        store.Save();
        Assert.Equal(["plain"], Store().Views().Select(v => v.Text));

        Assert.False(store.Expire(_now + 1));
        Assert.True(store.Expire(_now + (long)ClipStore.SecretLife.TotalMilliseconds + 1));
        Assert.Null(store.TextOf(secret.Id));
    }

    [Fact]
    public void Clips_and_images_are_kept_encrypted_after_a_restart()
    {
        var store = Store();
        byte[] png = [137, 80, 78, 71, 1, 2, 3];
        store.AddText("dotnet ef database update", Here, ClipKinds.Command, _now);
        Assert.True(store.AddImage(png, 1280, 720, ClipStore.ClipboardSource, _now + 1));
        Assert.False(store.AddImage(png, 1280, 720, ClipStore.ClipboardSource, _now + 2));
        store.Save();
        Assert.DoesNotContain("dotnet", File.ReadAllText(_vault.PathOf("clips.tmw")), StringComparison.Ordinal);

        var again = Store();
        var views = again.Views();
        Assert.Equal([ClipKinds.Image, ClipKinds.Command], views.Select(v => v.Kind));
        Assert.Equal(png, again.ImageOf(views[0].Id));
        Assert.Equal((1280, 720), (views[0].Width, views[0].Height));
    }

    [Fact]
    public void Kept_only_for_the_session_nothing_is_written_and_what_was_goes()
    {
        var store = Store();
        store.AddText("kept", Here, null, _now);
        store.Save();
        store.Persist = false;
        store.Save();
        Assert.False(File.Exists(_vault.PathOf("clips.tmw")));
        Assert.Single(store.Views());
    }

    [Fact]
    public void Long_clips_are_kept_whole_for_the_session_shown_cut_short_and_only_the_newest_few()
    {
        var store = Store();
        var big = new string('x', ClipStore.LongChars + 1);
        for (var i = 0; i <= ClipStore.MaxLong; i++)
        {
            Assert.True(store.AddText($"{i}{big}", Here, null, _now + i));
        }
        Assert.False(store.AddText(new string('y', ClipStore.MaxTextChars + 1), Here, null, _now));
        var views = store.Views();
        Assert.Equal(ClipStore.MaxLong, views.Count);
        Assert.Equal(ClipStore.ShownChars, views[0].Text.Length);
        Assert.Equal(big.Length + 1, views[0].Chars);
        Assert.Equal(big.Length + 1, store.TextOf(views[0].Id)!.Length);

        store.AddText("short", Here, null, _now);
        store.Save();
        Assert.Equal(["short"], Store().Views().Select(v => v.Text));
    }

    [Fact]
    public void Clear_forgets_all_but_the_pinned()
    {
        var store = Store();
        store.AddText("a", Here, null, _now);
        store.AddText("b", Here, null, _now + 1);
        store.Pin(store.Views()[1].Id, pinned: true);
        Assert.True(store.Clear());
        Assert.Equal(["a"], store.Views().Select(v => v.Text));
    }
}
