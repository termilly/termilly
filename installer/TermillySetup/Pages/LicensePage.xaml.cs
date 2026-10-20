using System;
using System.IO;
using System.Windows.Controls;

namespace Termilly.Setup.Pages;

public partial class LicensePage : UserControl
{
    /// <summary>The embedded files the page shows, in order (see TermillySetup.csproj).</summary>
    private static readonly string[] Shown = ["NOTICE", "LICENSE"];

    public LicensePage()
    {
        InitializeComponent();
        Text.Text = string.Join(Environment.NewLine + Environment.NewLine, Array.ConvertAll(Shown, Read));
        Accept.Checked += (_, _) => AcceptedChanged?.Invoke();
        Accept.Unchecked += (_, _) => AcceptedChanged?.Invoke();
    }

    public bool Accepted => Accept.IsChecked == true;

    public event Action? AcceptedChanged;

    private static string Read(string name)
    {
        using var stream = typeof(LicensePage).Assembly.GetManifestResourceStream(name)
            ?? throw new InvalidOperationException($"{name} isn't embedded in setup");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd().Trim();
    }
}
