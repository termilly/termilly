namespace Termilly.Desktop.Services;

/// <summary>Settings were saved: what they were, and what they are now.</summary>
internal sealed record SettingsSaved(AppSettings Previous, AppSettings Current);

/// <summary>The user's settings (settings.json): the current ones, and saving new ones.</summary>
internal interface ISettingsStore
{
    AppSettings Current { get; }

    /// <summary>New settings were saved: what follows them (the window's theme, hotkeys, the watchers…) updates.</summary>
    event Action<SettingsSaved>? Saved;

    /// <summary>Makes <paramref name="settings"/> current and writes them; a failed write is reported, not thrown.</summary>
    void Save(AppSettings settings);
}

internal sealed class SettingsStore : ISettingsStore
{
    public AppSettings Current { get; private set; } = SettingsFile.Load();

    public event Action<SettingsSaved>? Saved;

    public void Save(AppSettings settings)
    {
        var previous = Current;
        Current = settings;
        Storage.Try(() => SettingsFile.Save(settings));
        Saved?.Invoke(new SettingsSaved(previous, settings));
    }
}
