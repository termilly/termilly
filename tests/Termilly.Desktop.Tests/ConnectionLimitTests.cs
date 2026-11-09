using System.IO;
using Termilly.Desktop.Phone;

namespace Termilly.Desktop.Tests;

/// <summary>The phone server's limit on connections served at once (Phone/ConnectionLimit.cs).</summary>
public sealed class ConnectionLimitTests
{
    [Fact]
    public async Task Past_the_limit_a_connection_is_not_served_and_a_slot_frees_when_one_ends()
    {
        var limit = new ConnectionLimit(2);
        var hold = new TaskCompletionSource();
        Assert.True(limit.TryStart(() => hold.Task));
        Assert.True(limit.TryStart(() => hold.Task));
        var served = false;
        Assert.False(limit.TryStart(() => { served = true; return Task.CompletedTask; }));
        Assert.False(served);

        hold.SetResult();
        for (var i = 0; i < 100 && limit.Free < 2; i++)
        {
            await Task.Delay(10);
        }
        Assert.Equal(2, limit.Free);
    }

    [Fact]
    public async Task A_connection_that_fails_still_frees_its_slot()
    {
        var limit = new ConnectionLimit(1);
        Assert.True(limit.TryStart(() => Task.FromException(new IOException("gone"))));
        for (var i = 0; i < 100 && limit.Free < 1; i++)
        {
            await Task.Delay(10);
        }
        Assert.Equal(1, limit.Free);
    }
}
