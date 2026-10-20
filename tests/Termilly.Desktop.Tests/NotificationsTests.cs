namespace Termilly.Desktop.Tests;

public sealed class NotificationsTests
{
    [Fact]
    public void Toast_text_is_escaped_and_opens_the_terminal()
    {
        var xml = Notifications.ToastXmlText("t1", "Needs you: <build> & \"deploy\"", "Allow Bash?");

        Assert.Contains("launch=\"terminal=t1\"", xml);
        Assert.Contains("Needs you: &lt;build&gt; &amp; &quot;deploy&quot;", xml);
        Assert.Contains("<text>Allow Bash?</text>", xml);
        // Windows' own parser accepts it.
        Assert.Equal("toast", Notifications.ToastXml("t1", "a", "b").DocumentElement.NodeName);
    }
}
