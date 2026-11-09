using Termilly.Desktop;

namespace Termilly.Core.Tests;

/// <summary>
/// Saved passwords in the macOS login keychain (MacKeychain): the app saves one, reads it back, replaces it and
/// forgets it. Uses a throwaway item, removed at the end; skipped where the keychain is locked (an SSH session).
/// </summary>
public sealed class KeychainTests
{
    [Fact]
    public void A_saved_password_is_read_back_replaced_and_gone_once_forgotten()
    {
        if (!OperatingSystem.IsMacOS())
        {
            return;
        }
        var store = new MacKeychainStore();
        var target = $"Termilly/test/{Guid.NewGuid():N}";
        try
        {
            try
            {
                store.Save(target, "tester", "first", "Termilly test item");
            }
            catch (InvalidOperationException)
            {
                return; // the keychain is locked here: nothing to test with
            }
            Assert.True(store.Exists(target));
            Assert.Equal("first", store.Read(target));

            store.Save(target, "tester", "s3cret with spaces ünïcode", "Termilly test item");
            Assert.Equal("s3cret with spaces ünïcode", store.Read(target));
        }
        finally
        {
            store.Delete(target);
        }
        Assert.False(store.Exists(target));
        Assert.Null(store.Read(target));
    }
}
