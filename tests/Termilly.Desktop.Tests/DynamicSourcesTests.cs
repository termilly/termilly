namespace Termilly.Desktop.Tests;

public sealed class DynamicSourcesTests
{
    private static DynamicSources.Runner Fake(Dictionary<string, string?> outputs) =>
        (file, args) => outputs.TryGetValue($"{file} {string.Join(' ', args)}", out var output) ? output : null;

    [Fact]
    public void Running_containers_open_a_shell_inside()
    {
        var run = Fake(new()
        {
            ["docker ps --format {{json .}}"] =
                """
                {"ID":"a1b2","Image":"postgres:16","Names":"db","Status":"Up 3 hours"}
                {"ID":"c3d4","Image":"api:latest","Names":"api-prod,api-alias","Status":"Up 5 minutes"}
                {"ID":"e5f6","Image":"x","Names":"bad name; rm -rf /","Status":"Up"}
                not json
                """,
        });

        var profiles = DynamicSources.Containers(run).ToList();

        Assert.Equal(["db", "api-prod"], profiles.Select(p => p.Name));
        Assert.Equal("postgres:16 · Up 3 hours", profiles[0].Description);
        Assert.StartsWith("docker exec -it db sh -c ", profiles[0].CommandLine);
        Assert.Equal(ProfileSources.Docker, profiles[0].Source);
        Assert.Equal(["prod"], profiles[1].Tags);
    }

    [Fact]
    public void Running_pods_in_the_current_context_open_a_shell_inside()
    {
        var run = Fake(new()
        {
            ["kubectl config current-context"] = "prod-eu\n",
            ["kubectl --context prod-eu get pods --all-namespaces --field-selector=status.phase=Running -o json"] =
                """
                { "items": [
                  { "metadata": { "name": "web-7d9f", "namespace": "shop" } },
                  { "metadata": { "name": "worker-1", "namespace": "jobs" } },
                  { "metadata": { "name": "$(evil)", "namespace": "x" } }
                ] }
                """,
        });

        var pods = DynamicSources.Pods(run).ToList();

        Assert.Equal(["web-7d9f", "worker-1"], pods.Select(p => p.Name));
        Assert.Equal("shop · prod-eu", pods[0].Description);
        Assert.StartsWith("kubectl --context prod-eu -n shop exec -it web-7d9f -- sh -c ", pods[0].CommandLine);
        Assert.All(pods, p => Assert.Equal(["prod"], p.Tags)); // a production context
    }

    [Fact]
    public void Without_docker_or_kubectl_there_are_no_such_profiles() =>
        Assert.Empty(DynamicSources.Detect((_, _) => null));
}
