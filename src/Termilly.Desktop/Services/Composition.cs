using Microsoft.Extensions.DependencyInjection;
using Termilly.Desktop.Features;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Security;

namespace Termilly.Desktop.Services;

/// <summary>
/// The shared services, for the composition root on each system: MainWindow on Windows, Program on Linux. Each adds
/// its own platform services (AddPlatform, its keyring and fonts) and builds the container once its window exists.
/// Everything is one instance for the window's life; the container disposes them when the window closes.
/// </summary>
internal static class Composition
{
    public static IServiceCollection AddTermilly(this IServiceCollection services) => services
        // Storage: settings, and the vault with what it encrypts.
        .AddSingleton<ISettingsStore, SettingsStore>()
        .AddSingleton<WindowTheme>()
        .AddSingleton(_ => Vault.Open(AppPaths.DataDirectory))
        .AddSingleton<WorkspaceStore>()
        .AddSingleton<SessionSnapshot>()
        .AddSingleton<HistoryStore>()
        .AddSingleton<CommandHistory>()
        .AddSingleton<HistorySync>()
        // Programs Termilly runs, and what it reads with them.
        .AddSingleton<IProcessRunner, ProcessRunner>()
        .AddSingleton(_ => UpdateDownload.Create())
        .AddSingleton<LocalGit>()
        .AddSingleton<LocalGitRunner>()
        .AddSingleton<GitStatus>()
        .AddSingleton<Worktrees>()
        .AddSingleton<Sftp>()
        .AddSingleton<DynamicSources>()
        .AddSingleton<ClaudePlan>()
        .AddSingleton(_ => new ChangeStore())
        .AddSingleton<ChangePreview>()
        // The page, and what the features share.
        .AddSingleton<PageChannel>()
        .AddSingleton<QuitGate>()
        .AddSingleton<Credentials>()
        .AddSingleton<TerminalSessions>()
        .AddSingleton<BackgroundHost>()
        .AddSingleton<TmuxClients>()
        .AddSingleton<PageBoot>()
        .AddSingleton<LastSnapshot>()
        .AddStartable<ProfileCatalog>()
        .AddStartable<ActivityWatcher>()
        .AddStartable<AgentMonitor>()
        .AddStartable<RetiredAssistantKey>()
        .AddStartable<RetiredPhonePairings>()
        // Each feature's messages.
        .AddHandler<WindowHandler>()
        .AddHandler<PageApi>()
        .AddHandler<TerminalHandler>()
        .AddHandler<SystemHandler>()
        .AddHandler<SettingsHandler>()
        .AddHandler<HistoryHandler>()
        .AddHandler<SecurityHandler>()
        .AddHandler<RemoteHandler>()
        .AddHandler<ChangesHandler>()
        .AddHandler<GitHandler>()
        .AddHandler<WorktreeHandler>()
        .AddHandler<LayoutHandler>()
        .AddHandler<SshHandler>()
        .AddHandler<SftpHandler>()
        .AddHandler<RecordingHandler>()
        .AddHandler<LogHandler>()
        .AddHandler<SyncHandler>()
        .AddHandler<UpdateHandler>()
        .AddSingleton<PageHost>();

    /// <summary>A service that's started once the window is up, as itself and as one of the <see cref="IStartable"/>s.</summary>
    private static IServiceCollection AddStartable<T>(this IServiceCollection services)
        where T : class, IStartable => services
        .AddSingleton<T>()
        .AddSingleton<IStartable>(provider => provider.GetRequiredService<T>());

    /// <summary>A feature's message handler, as itself (other features may use it) and as one of the <see cref="IMessageHandler"/>s.</summary>
    private static IServiceCollection AddHandler<T>(this IServiceCollection services)
        where T : class, IMessageHandler
    {
        services.AddSingleton<T>().AddSingleton<IMessageHandler>(provider => provider.GetRequiredService<T>());
        if (typeof(IStartable).IsAssignableFrom(typeof(T)))
        {
            services.AddSingleton(provider => (IStartable)provider.GetRequiredService<T>());
        }
        return services;
    }
}
