using System.IO;
using Termilly.Setup.Pages;

namespace TermillySetup.Tests;

/// <summary>The license page shows the repository's NOTICE and LICENSE, embedded when setup is built.</summary>
public class LicenseTests
{
    [Theory]
    [InlineData("NOTICE", "Termilly")]
    [InlineData("LICENSE", "Apache License")]
    public void Setup_carries_the_license_files(string name, string expected)
    {
        using var stream = typeof(LicensePage).Assembly.GetManifestResourceStream(name);

        Assert.NotNull(stream);
        Assert.Contains(expected, new StreamReader(stream).ReadToEnd());
    }
}
