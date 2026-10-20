using System.Linq;
using System.Windows.Controls;

namespace Termilly.Setup.Pages;

public partial class WelcomePage : UserControl
{
    /// <summary>A version's parts: major.minor.patch.</summary>
    private const int ReleaseParts = 3;

    public WelcomePage(string version)
    {
        InitializeComponent();
        // "1.0.0" reads as "Termilly 1.0"; a patch release shows in full.
        var parts = version.Split('.');
        Heading.Text = "Termilly " + (parts.Length == ReleaseParts && parts[ReleaseParts - 1] == "0" ? string.Join(".", parts.Take(2)) : version);
    }
}
