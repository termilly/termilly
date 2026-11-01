using System.Text.Json.Nodes;
using Termilly.Desktop.Phone;

namespace Termilly.Desktop.Tests;

public sealed class PhoneAwayAlertsTests
{
    private static readonly TimeSpan AwayAfter = TimeSpan.FromMinutes(1);

    [Fact]
    public void A_held_alert_goes_once_the_PC_is_left_alone_and_only_once()
    {
        var sent = new List<string>();
        var idle = TimeSpan.Zero;
        using var away = new PhoneAwayAlerts(a => { sent.Add(a["title"]!.GetValue<string>()); return Task.CompletedTask; }, () => idle, AwayAfter);
        away.Hold("t1", new JsonObject { ["title"] = "Needs you: api" });
        away.Check();
        Assert.Empty(sent);
        idle = AwayAfter;
        away.Check();
        away.Check();
        Assert.Equal(["Needs you: api"], sent);
    }

    [Fact]
    public void An_answered_terminal_or_a_newer_alert_drops_the_held_one()
    {
        var sent = new List<string>();
        using var away = new PhoneAwayAlerts(a => { sent.Add(a["title"]!.GetValue<string>()); return Task.CompletedTask; }, () => AwayAfter, AwayAfter);
        away.Hold("t1", new JsonObject { ["title"] = "old" });
        away.Drop("t1");
        away.Hold("t2", new JsonObject { ["title"] = "first" });
        away.Hold("t2", new JsonObject { ["title"] = "newer" });
        away.Check();
        Assert.Equal(["newer"], sent);
    }

    [Fact]
    public void Always_alerts_whether_or_not_the_user_is_at_the_PC_and_is_the_default()
    {
        Assert.True(Features.PhoneHandler.ShouldAlert(SettingValues.PhoneAlerts.Always, inFront: true, idle: TimeSpan.Zero));
        Assert.False(Features.PhoneHandler.ShouldAlert(SettingValues.PhoneAlerts.Away, inFront: true, idle: TimeSpan.Zero));
        Assert.Equal(SettingValues.PhoneAlerts.Always, new PhoneSettings().Normalize().Alerts);
    }
}
