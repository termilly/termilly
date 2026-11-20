using System;
using System.IO;
using Termilly.Setup.Engine;

namespace TermillySetup.Tests;

/// <summary>
/// The folder moves of an update at start (UpdateFolders): each state an update can be cut off in settles to one
/// working Termilly, the new one only once it was confirmed healthy.
/// </summary>
public sealed class UpdateFoldersTests : IDisposable
{
    private const string Old = "1.9.1";
    private const string New = "1.9.2";
    private const string VersionFile = "version.txt";
    private readonly string _root = Path.Combine(Path.GetTempPath(), "termilly-update-folders-" + Guid.NewGuid().ToString("N"));
    private readonly string _dir;
    private readonly UpdateFolders _folders;

    public UpdateFoldersTests()
    {
        _dir = Path.Combine(_root, "Termilly");
        Directory.CreateDirectory(_root);
        _folders = new UpdateFolders(_dir, VersionIn);
    }

    public void Dispose() => Directory.Delete(_root, recursive: true);

    [Fact]
    public void An_unconfirmed_update_is_rolled_back()
    {
        Make(_dir, New);
        Make(_dir + ".old", Old);

        Assert.True(_folders.Recover());

        Assert.Equal(Old, VersionIn(_dir));
        Assert.Single(Directory.GetDirectories(_root));
    }

    [Fact]
    public void A_confirmed_update_is_kept()
    {
        Make(_dir, New);
        Make(_dir + ".old", Old);
        _folders.Confirm(New);
        Make(_dir + ".old", Old); // as if the old folder came back: the marker still vouches for the new version

        Assert.False(_folders.Recover());

        Assert.Equal(New, VersionIn(_dir));
        Assert.False(Directory.Exists(_dir + ".old"));
    }

    [Fact]
    public void A_marker_for_another_version_does_not_count()
    {
        Make(_dir, New);
        Make(_dir + ".old", Old);
        _folders.Confirm("1.9.0");
        Make(_dir + ".old", Old);

        Assert.True(_folders.Recover());

        Assert.Equal(Old, VersionIn(_dir));
    }

    [Fact]
    public void Cut_off_between_the_renames_the_old_version_comes_back()
    {
        Make(_dir + ".old", Old);
        Make(_dir + ".new", New);

        Assert.True(_folders.Recover());

        Assert.Equal(Old, VersionIn(_dir));
        Assert.False(Directory.Exists(_dir + ".new"));
    }

    [Fact]
    public void Cut_off_in_a_rollback_it_finishes_the_rollback()
    {
        Make(_dir + ".cand", New);
        Make(_dir + ".old", Old);

        Assert.True(_folders.Recover());

        Assert.Equal(Old, VersionIn(_dir));
        Assert.False(Directory.Exists(_dir + ".cand"));
    }

    [Theory]
    [InlineData(".cand")]
    [InlineData(".new")]
    public void With_no_old_version_left_any_copy_beats_none(string suffix)
    {
        Make(_dir + suffix, New);

        _folders.Recover();

        Assert.Equal(New, VersionIn(_dir));
    }

    [Fact]
    public void A_folder_without_its_exe_is_replaced_by_a_working_copy()
    {
        Directory.CreateDirectory(_dir);
        Make(_dir + ".new", New);

        _folders.Recover();

        Assert.Equal(New, VersionIn(_dir));
    }

    [Fact]
    public void Confirming_removes_the_old_version_and_leftovers()
    {
        Make(_dir, New);
        Make(_dir + ".old", Old);
        Make(_dir + ".new", New);

        _folders.Confirm(New);

        Assert.Equal(New, VersionIn(_dir));
        Assert.Equal([_dir, _dir + ".update"], Array.ConvertAll(Directory.GetDirectories(_root), d => d));
    }

    [Fact]
    public void A_settled_install_is_left_alone()
    {
        Make(_dir, Old);

        Assert.False(_folders.Recover());

        Assert.Equal(Old, VersionIn(_dir));
    }

    [Fact]
    public void Rolling_back_with_nothing_kept_changes_nothing()
    {
        Make(_dir, New);

        _folders.RollBack();

        Assert.Equal(New, VersionIn(_dir));
    }

    [Fact]
    public void A_forgotten_marker_no_longer_vouches()
    {
        Make(_dir, New);
        Make(_dir + ".old", Old);
        _folders.Confirm(New);
        _folders.ForgetConfirmed();
        Make(_dir + ".old", Old);

        Assert.True(_folders.Recover());

        Assert.Equal(Old, VersionIn(_dir));
    }

    private static void Make(string dir, string version)
    {
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, VersionFile), version);
    }

    private static string? VersionIn(string dir)
    {
        var file = Path.Combine(dir, VersionFile);
        return File.Exists(file) ? File.ReadAllText(file) : null;
    }
}
