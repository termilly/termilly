using Termilly.Desktop;
using Xunit.Abstractions;

namespace Termilly.Core.Tests;

/// <summary>
/// Saved passwords in the macOS login keychain (MacKeychain): the app saves one, reads it back, replaces it and
/// forgets it, with a throwaway item removed at the end. CI gives the test a keychain of its own and requires it to
/// run; elsewhere it's skipped only where the keychain is locked and can't ask (an SSH session), and says so.
/// </summary>
public sealed class KeychainTests(ITestOutputHelper output)
{
    /// <summary>Set by CI (.github/workflows/ci.yml): the keychain must be usable, a locked one fails the test.</summary>
    private const string RequireVariable = "TERMILLY_REQUIRE_KEYCHAIN";

    [Fact]
    public void A_saved_password_is_read_back_replaced_and_gone_once_forgotten()
    {
        if (!OperatingSystem.IsMacOS())
        {
            return;
        }
        var store = new MacKeychainStore();
        var target = $"Termilly/test/{Guid.NewGuid():N}";
        var saved = false;
        try
        {
            try
            {
                store.Save(target, "tester", "first", "Termilly test item");
                saved = true;
            }
            catch (InvalidOperationException e) when (e.HResult == MacKeychain.InteractionNotAllowed && Environment.GetEnvironmentVariable(RequireVariable) != "1")
            {
                output.WriteLine("Skipped: the keychain is locked here and can't ask to be unlocked (an SSH session).");
                return;
            }
            Assert.True(store.Exists(target));
            Assert.Equal("first", store.Read(target));

            store.Save(target, "tester", "s3cret with spaces ünïcode", "Termilly test item");
            Assert.Equal("s3cret with spaces ünïcode", store.Read(target));
        }
        finally
        {
            if (saved)
            {
                store.Delete(target);
            }
        }
        Assert.False(store.Exists(target));
        Assert.Null(store.Read(target));
    }
}
