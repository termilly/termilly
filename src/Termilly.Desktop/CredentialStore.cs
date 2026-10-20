using System.Runtime.Versioning;

namespace Termilly.Desktop;

/// <summary>
/// Where Termilly keeps an SSH connection's password and the AI assistant's API key, outside its own files: the
/// system's credential store, for the current user. Calls throw when the store says no.
/// </summary>
internal interface ICredentialStore
{
    /// <summary>The store's name, as the user knows it ("Windows Credential Manager").</summary>
    string Name { get; }

    /// <summary>Whether this system has one Termilly can use.</summary>
    bool IsAvailable { get; }

    void Save(string target, string user, string secret, string comment);

    bool Exists(string target);

    void Delete(string target);

    string? Read(string target);
}

/// <summary>Windows Credential Manager (<see cref="WindowsCredentials"/>).</summary>
internal sealed class WindowsCredentialStore : ICredentialStore
{
    public string Name => "Windows Credential Manager";

    public bool IsAvailable => true;

    public void Save(string target, string user, string secret, string comment) => WindowsCredentials.Save(target, user, secret, comment);

    public bool Exists(string target) => WindowsCredentials.Exists(target);

    public void Delete(string target) => WindowsCredentials.Delete(target);

    public string? Read(string target) => WindowsCredentials.Read(target);
}

/// <summary>No credential store: saved passwords and the API key aren't available.</summary>
internal sealed class NoCredentialStore(string name) : ICredentialStore
{
    public string Name => name;

    public bool IsAvailable => false;

    public void Save(string target, string user, string secret, string comment) =>
        throw new InvalidOperationException($"Termilly can't use {name} yet.");

    public bool Exists(string target) => false;

    public void Delete(string target)
    {
    }

    public string? Read(string target) => null;
}

/// <summary>The Linux keyring (<see cref="LibSecret"/>) as Termilly's credential store.</summary>
[SupportedOSPlatform("linux")]
internal sealed class LinuxKeyringStore : ICredentialStore
{
    public string Name => "the system keyring";

    public bool IsAvailable => LibSecret.IsAvailable;

    public void Save(string target, string user, string secret, string comment) =>
        LibSecret.Store(target, string.IsNullOrEmpty(user) ? $"Termilly: {comment}" : $"Termilly: {comment} ({user})", secret);

    public bool Exists(string target) => LibSecret.Lookup(target) is not null;

    public void Delete(string target) => LibSecret.Clear(target);

    public string? Read(string target) => LibSecret.Lookup(target);
}
