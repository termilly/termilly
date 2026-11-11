using System;
using System.IO;
using Termilly.Setup;
using Termilly.Shared;

namespace TermillySetup.Tests;

public class UpdateWindowTests
{
    [Theory]
    [InlineData("--quiet")]
    [InlineData("--quiet --start")]
    [InlineData("--update-window --start")]
    [InlineData("--quiet --update-window")]
    [InlineData("--quiet --start --update-window --uninstall")]
    public void Scripted_installs_and_uninstalls_have_no_update_window(string command)
    {
        Assert.False(UpdateWindow.IsRequested(new Arguments(command.Split(' '))));
    }

    [Fact]
    public void Only_an_explicit_in_app_restart_shows_the_window()
    {
        Assert.True(UpdateWindow.IsRequested(new Arguments("--quiet --start --update-window".Split(' '))));
    }

    [Fact]
    public void Paint_signals_are_shared_only_for_the_same_user_and_install()
    {
        var dir = Path.Combine(Path.GetTempPath(), "termilly-events-" + Guid.NewGuid().ToString("N"));
        var scope = UpdateSignals.ScopeFor(dir, "user-a");
        Assert.Equal(scope, UpdateSignals.ScopeFor(dir.ToUpperInvariant() + "\\", "user-a"));
        Assert.NotEqual(scope, UpdateSignals.ScopeFor(dir, "user-b"));
        Assert.NotEqual(scope, UpdateSignals.ScopeFor(dir + "-other", "user-a"));
        Assert.True(UpdateSignals.IsScope(scope));
        Assert.False(UpdateSignals.IsScope("--all-users"));
        using var first = UpdateSignals.Create(scope, UpdateSignals.Started);
        using var second = UpdateSignals.Create(scope, UpdateSignals.Started);
        using var shown = UpdateSignals.Create(scope, UpdateSignals.Shown);
        Assert.False(first.WaitOne(0));
        second.Set();
        Assert.True(first.WaitOne(0));
        Assert.False(shown.WaitOne(0));
    }
}
