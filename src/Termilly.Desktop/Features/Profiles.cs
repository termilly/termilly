using System.Text.Json;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>
/// The profiles terminals open with: the shells, WSL distributions, custom profiles, SSH connections and
/// ~/.ssh/config hosts, serial ports, and the running containers and pods (DynamicSources, read at start and on
/// "Refresh", as they can be slow). Detected again when Settings change what makes them.
/// </summary>
internal sealed class ProfileCatalog : IStartable
{
    private readonly PageChannel _page;
    private readonly ISettingsStore _settings;
    private readonly DynamicSources _dynamicSources;
    private IReadOnlyList<SessionProfile> _profiles = [];
    private IReadOnlyList<SessionProfile> _dynamic = [];

    public ProfileCatalog(PageChannel page, ISettingsStore settings, DynamicSources dynamicSources)
    {
        (_page, _settings, _dynamicSources) = (page, settings, dynamicSources);
        Detect();
        settings.Saved += change =>
        {
            if (MakesProfiles(change.Previous) != MakesProfiles(change.Current))
            {
                Detect();
                Post();
            }
        };
    }

    public IReadOnlyList<SessionProfile> All => _profiles;

    /// <summary>The profile with this id, or the first (the default shell).</summary>
    public SessionProfile Find(string? id) => _profiles.FirstOrDefault(p => p.Id == id) ?? _profiles[0];

    public void Start() => RefreshContainers();

    /// <summary>Re-reads the shells, WSL distributions, custom profiles and ~/.ssh/config.</summary>
    public void Detect() =>
        _profiles = [.. SessionProfiles.Detect(_settings.Current), .. _settings.Current.Shells.DynamicSources ? _dynamic : []];

    /// <summary>"Refresh": everything again, the running containers and pods too when Settings list them.</summary>
    public void Refresh()
    {
        if (_settings.Current.Shells.DynamicSources)
        {
            RefreshContainers();
            return;
        }
        Detect();
        Post();
    }

    /// <summary>Reads the running containers and pods in the background, then sends the page the new profiles.</summary>
    private void RefreshContainers()
    {
        if (!_settings.Current.Shells.DynamicSources)
        {
            return;
        }
        _ = Task.Run(() =>
        {
            _dynamic = _dynamicSources.Detect();
            Detect();
            Post();
        });
    }

    /// <summary>What the page needs to list and badge profiles (not their command lines or variables).</summary>
    public IEnumerable<ToPage.ProfileSummary> Summaries() =>
        _profiles.Select(p => new ToPage.ProfileSummary(p.Id, p.Name, p.Description, p.Icon, p.Source, p.Tags ?? []));

    public void Post() => _page.Post(new ToPage.ProfileList(Summaries()));

    /// <summary>The settings profiles come from: custom profiles, SSH connections, serial ports and network consoles.</summary>
    private static string MakesProfiles(AppSettings settings) =>
        JsonSerializer.Serialize(new ProfileSources(settings.Shells.Profiles, settings.Ssh.Connections, settings.Shells.SerialPorts, settings.Shells.NetworkConsoles), PageChannel.Json);

    private sealed record ProfileSources(IReadOnlyList<CustomProfile>? Profiles, IReadOnlyList<SshConnection>? Connections,
        IReadOnlyList<SerialSettings>? SerialPorts, IReadOnlyList<NetworkConsole>? NetworkConsoles);
}
