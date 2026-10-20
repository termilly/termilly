using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Termilly.Setup.Engine;

namespace TermillySetup.Tests;

/// <summary>
/// Setup's payload, built as installer/build.ps1 builds it: the program, a zip, and a footer with the zip's offset, its
/// SHA-256 and the magic.
/// </summary>
public sealed class PayloadTests : IDisposable
{
    private static readonly byte[] Program = Encoding.ASCII.GetBytes(new string('p', 1000));
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "termilly-setup-tests-" + Guid.NewGuid().ToString("N"));

    public PayloadTests() => Directory.CreateDirectory(_dir);

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    [Fact]
    public void A_payload_reads_back_with_its_version_and_entries()
    {
        var file = Setup(Zip(("version.txt", "1.2.3"), ("app/Termilly.exe", "app")));

        var payload = Payload.Open(file);

        Assert.NotNull(payload);
        Assert.Equal("1.2.3", payload!.Version);
        Assert.Equal(Program.Length, payload.ProgramLength);
        Assert.True(payload.Verify());
        Assert.True(payload.Has("app/Termilly.exe"));
        Assert.False(payload.Has("app/missing.exe"));
    }

    [Fact]
    public void The_program_alone_is_what_comes_before_the_payload()
    {
        var file = Setup(Zip(("version.txt", "1.0.0")));
        var program = Path.Combine(_dir, "program.exe");

        Payload.Open(file)!.WriteProgram(program);

        Assert.Equal(Program, File.ReadAllBytes(program));
    }

    [Fact]
    public void A_damaged_payload_fails_its_check()
    {
        var file = Setup(Zip(("version.txt", "1.0.0"), ("app/a.txt", new string('a', 500))));
        var bytes = File.ReadAllBytes(file);
        bytes[Program.Length + 100] ^= 0xff;
        File.WriteAllBytes(file, bytes);

        Assert.False(Payload.Open(file)?.Verify() ?? false);
    }

    [Fact]
    public void A_program_without_a_payload_has_none()
    {
        var file = Path.Combine(_dir, "bare.exe");
        File.WriteAllBytes(file, Program);

        Assert.Null(Payload.Open(file));

        var copy = Path.Combine(_dir, "copy.exe");
        Payload.WriteProgramOf(file, copy);
        Assert.Equal(Program, File.ReadAllBytes(copy));
    }

    [Fact]
    public void A_payload_without_a_version_says_0_0_0()
    {
        Assert.Equal("0.0.0", Payload.Open(Setup(Zip(("app/a.txt", "a"))))!.Version);
    }

    /// <summary>The program, the zip, then the footer: the zip's offset (Int64), its SHA-256, the magic.</summary>
    private string Setup(byte[] zip)
    {
        var file = Path.Combine(_dir, $"setup-{Guid.NewGuid():N}.exe");
        using var sha = SHA256.Create();
        var footer = BitConverter.GetBytes((long)Program.Length).Concat(sha.ComputeHash(zip)).Concat(Encoding.ASCII.GetBytes(Payload.Magic));
        File.WriteAllBytes(file, Program.Concat(zip).Concat(footer).ToArray());
        return file;
    }

    private static byte[] Zip(params (string Name, string Text)[] entries)
    {
        using var memory = new MemoryStream();
        using (var zip = new ZipArchive(memory, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (name, text) in entries)
            {
                using var writer = new StreamWriter(zip.CreateEntry(name).Open());
                writer.Write(text);
            }
        }
        return memory.ToArray();
    }
}
