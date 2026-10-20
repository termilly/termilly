using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>
/// Profiles that come and go: running Docker containers and Kubernetes pods (in the current kubectl context), each
/// opening a shell inside with one click. They're read from the docker and kubectl commands when Termilly starts
/// and on "Refresh", never on every change, since those commands can be slow. Missing commands just mean no
/// such profiles.
/// </summary>
internal sealed partial class DynamicSources(IProcessRunner runner)
{
    private const int MaxEach = 60;

    /// <summary>A shell that works in most images: bash where there is one, else sh.</summary>
    private const string BestShell = "sh -c \"if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi\"";

    [GeneratedRegex(@"^[A-Za-z0-9][A-Za-z0-9_.:/@-]*$")]
    private static partial Regex SafeName();

    [GeneratedRegex(@"(?<![a-z])prod(uction)?(?![a-z])", RegexOptions.IgnoreCase)]
    private static partial Regex LooksLikeProduction();

    /// <summary>A command's output, or null when it's missing, fails or takes too long.</summary>
    public delegate string? Runner(string file, params string[] args);

    /// <summary>How long docker or kubectl may take: a cluster that's away shouldn't hold up Refresh.</summary>
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(8);
    private const string Kubectl = "kubectl";
    private static readonly string[] CurrentContext = ["config", "current-context"];

    /// <summary>The fields of a pod in `kubectl get pods -o json` that are read.</summary>
    private static class PodFields
    {
        public const string Items = "items";
        public const string Metadata = "metadata";
        public const string Name = "name";
        public const string Namespace = "namespace";
        public const string DefaultNamespace = "default";
    }

    /// <summary>The running containers and pods, from docker and kubectl.</summary>
    public List<SessionProfile> Detect() => Detect(Run);

    public static List<SessionProfile> Detect(Runner run)
    {
        var profiles = new List<SessionProfile>();
        profiles.AddRange(Containers(run));
        profiles.AddRange(Pods(run));
        return profiles;
    }

    private string? Run(string file, params string[] args)
    {
        try
        {
            var result = runner.Run(new ProcessRequest(file, args) { Timeout = Timeout });
            return result.Succeeded ? result.Text : null;
        }
        catch (IOException)
        {
            return null; // not installed, or too slow
        }
    }

    /// <summary>Running containers: `docker ps` prints one JSON object a line.</summary>
    public static IEnumerable<SessionProfile> Containers(Runner run)
    {
        var output = run("docker", "ps", "--format", "{{json .}}");
        if (output is null)
        {
            yield break;
        }
        var count = 0;
        foreach (var line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            JsonElement c;
            try
            {
                c = JsonDocument.Parse(line).RootElement;
            }
            catch (JsonException)
            {
                continue;
            }
            var name = c.TryGetProperty("Names", out var n) ? n.GetString()?.Split(',')[0] : null;
            if (name is null || !SafeName().IsMatch(name) || ++count > MaxEach)
            {
                continue;
            }
            var image = c.TryGetProperty("Image", out var i) ? i.GetString() : null;
            var status = c.TryGetProperty("Status", out var s) ? s.GetString() : null;
            yield return new SessionProfile(
                ProfileIds.Docker + name.ToLowerInvariant(), name, string.Join(" · ", new[] { image, status }.Where(x => !string.IsNullOrEmpty(x))),
                ProfileIcons.Docker, $"docker exec -it {name} {BestShell}", ProfileSources.Docker,
                Tags: LooksLikeProduction().IsMatch(name) ? [ProfileTags.Production] : null);
        }
    }

    /// <summary>Running pods in the current context, in every namespace the user may list.</summary>
    public static IEnumerable<SessionProfile> Pods(Runner run)
    {
        var context = run(Kubectl, CurrentContext)?.Trim();
        if (string.IsNullOrEmpty(context) || !SafeName().IsMatch(context))
        {
            yield break;
        }
        var json = run(Kubectl, "--context", context, "get", "pods", "--all-namespaces", "--field-selector=status.phase=Running", "-o", "json");
        if (json is null)
        {
            yield break;
        }
        JsonElement items;
        try
        {
            items = JsonDocument.Parse(json).RootElement.GetProperty(PodFields.Items);
        }
        catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException)
        {
            yield break;
        }
        var production = LooksLikeProduction().IsMatch(context);
        var count = 0;
        foreach (var pod in items.EnumerateArray())
        {
            if (!pod.TryGetProperty(PodFields.Metadata, out var meta))
            {
                continue;
            }
            var name = meta.TryGetProperty(PodFields.Name, out var n) ? n.GetString() : null;
            var ns = meta.TryGetProperty(PodFields.Namespace, out var s) ? s.GetString() : PodFields.DefaultNamespace;
            if (name is null || ns is null || !SafeName().IsMatch(name) || !SafeName().IsMatch(ns) || ++count > MaxEach)
            {
                continue;
            }
            yield return new SessionProfile(
                (ProfileIds.Kubernetes + $"{context}-{ns}-{name}").ToLowerInvariant(), name, $"{ns} · {context}",
                ProfileIcons.Kubernetes, $"kubectl --context {context} -n {ns} exec -it {name} -- {BestShell}", ProfileSources.Kubernetes,
                Tags: production ? [ProfileTags.Production] : null);
        }
    }
}
