using System.IO;
using Termilly.Desktop.Phone;

namespace Termilly.Desktop.Tests;

/// <summary>Room on the disks for copies running at once (Phone/DiskBudget.cs), on made-up disks.</summary>
public sealed class DiskBudgetTests
{
    private const long GiB = 1L << 30;
    private static readonly char Sep = Path.DirectorySeparatorChar;
    private static string P(params string[] parts) => Sep + string.Join(Sep, parts);

    /// <summary>Made-up disks: a path under "b" is on disk b, everything else on disk a; free space set by the test.</summary>
    private sealed class Disks
    {
        public readonly Dictionary<string, long> Free = new() { ["a"] = 10 * GiB, ["b"] = 10 * GiB };
        public (string Root, long? Free) Of(string path) => path.StartsWith('b') ? ("b", Free["b"]) : ("a", Free["a"]);
    }

    [Fact]
    public void A_path_is_on_the_longest_mount_that_holds_it_as_whole_folders()
    {
        string[] roots = [Sep.ToString(), P("mnt", "data"), P("mnt", "database")];
        Assert.Equal(P("mnt", "database"), DiskBudget.MountOf(P("mnt", "database", "x"), roots));
        Assert.Equal(P("mnt", "data"), DiskBudget.MountOf(P("mnt", "data", "x"), roots));
        Assert.Equal(P("mnt", "data"), DiskBudget.MountOf(P("mnt", "data"), roots));
        Assert.Equal(Sep.ToString(), DiskBudget.MountOf(P("mnt", "datax", "y"), roots));
        Assert.Null(DiskBudget.MountOf(P("x"), [P("mnt", "data")]));
    }

    [Fact]
    public void Copies_at_once_share_the_room_and_give_it_back_when_they_end()
    {
        var disks = new Disks();
        var budget = new DiskBudget(disks.Of);
        using var first = budget.TryReserve("a1", 6 * GiB);
        Assert.NotNull(first);
        Assert.Null(budget.TryReserve("a2", 6 * GiB)); // fits alone (9 GiB of room), not beside the first
        first!.Dispose();
        using var again = budget.TryReserve("a2", 6 * GiB);
        Assert.NotNull(again);
    }

    [Fact]
    public void Written_bytes_count_once_as_the_disks_free_space_not_again_as_a_reservation()
    {
        // 10 GiB free, 1 GiB kept: a 3 GiB zip, then 2 GiB unpacked and a 2 GiB copy on the same disk fit (7 GiB).
        var disks = new Disks();
        var budget = new DiskBudget(disks.Of);
        var zip = budget.TryReserve("a/zip", 3 * GiB);
        Assert.NotNull(zip);
        disks.Free["a"] -= 3 * GiB; // written
        zip!.Dispose();
        var unpacked = budget.TryReserve("a/item", 2 * GiB);
        var copy = budget.TryReserve("a/dest", 2 * GiB);
        Assert.NotNull(unpacked);
        Assert.NotNull(copy);
        Assert.Equal(4 * GiB, budget.UnwrittenOn("a"));
    }

    [Fact]
    public void A_copy_to_another_disk_takes_room_there_not_here()
    {
        var disks = new Disks { Free = { ["b"] = 2 * GiB } };
        var budget = new DiskBudget(disks.Of);
        using var here = budget.TryReserve("a/item", 5 * GiB);
        Assert.NotNull(here);
        Assert.Null(budget.TryReserve("b/dest", 5 * GiB)); // b has 1 GiB of room
        Assert.Equal(0, budget.UnwrittenOn("b"));
    }

    [Fact]
    public void Giving_a_reservation_back_twice_gives_it_back_once()
    {
        var budget = new DiskBudget(new Disks().Of);
        using var other = budget.TryReserve("a/x", 2 * GiB);
        var mine = budget.TryReserve("a/y", 3 * GiB);
        mine!.Dispose();
        mine.Dispose();
        Assert.Equal(2 * GiB, budget.UnwrittenOn("a"));
    }

    [Fact]
    public void A_disk_whose_free_space_cant_be_told_takes_the_copy()
    {
        var budget = new DiskBudget(_ => ("", null));
        using var reservation = budget.TryReserve("anywhere", 100 * GiB);
        Assert.NotNull(reservation);
    }
}
