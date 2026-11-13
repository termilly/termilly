using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Termilly.Desktop.Security;
using YamlDotNet.Serialization;

namespace Termilly.Desktop;

/// <summary>Writes a workspace layout (WorkspaceLayout.cs reads and checks it) as a YAML file to share.</summary>
internal static partial class WorkspaceLayoutWriter
{
    /// <summary>What a secret-looking variable's value is written as.</summary>
    private const string SetMe = "<set me>";

    /// <summary>
    /// Writes a layout as YAML for sharing. Variables whose value looks like a secret (the same detection as
    /// history redaction) are written as "&lt;set me&gt;", so a file can be committed safely.
    /// </summary>
    public static string ToYaml(JsonObject layout)
    {
        var plain = ToPlain(Scrub(layout.DeepClone()));
        var yaml = new SerializerBuilder().Build().Serialize(plain);
        return $"# Termilly workspace layout. Open it with \"Import a workspace layout\", or name it {WorkspaceLayout.FileName} in a project folder.\n{yaml}";
    }

    private static JsonNode? Scrub(JsonNode? node)
    {
        if (node is JsonObject obj)
        {
            foreach (var key in obj.Select(kv => kv.Key).ToList())
            {
                if (key == WorkspaceLayout.Keys.Env && obj[key] is JsonObject env)
                {
                    foreach (var name in env.Select(kv => kv.Key).ToList())
                    {
                        var value = env[name]?.ToString() ?? "";
                        if (LooksSecret(name, value))
                        {
                            env[name] = SetMe;
                        }
                    }
                }
                else
                {
                    Scrub(obj[key]);
                }
            }
        }
        else if (node is JsonArray array)
        {
            foreach (var item in array)
            {
                Scrub(item);
            }
        }
        return node;
    }

    [GeneratedRegex("TOKEN|SECRET|PASSW|PWD|API_?KEY|PRIVATE|CREDENTIAL|AUTH", RegexOptions.IgnoreCase)]
    private static partial Regex SecretName();

    /// <summary>A variable named like a secret, or a value in a known token format (the history redactor's list).</summary>
    internal static bool LooksSecret(string name, string value) =>
        value.Length > 0 && value != SetMe && (SecretName().IsMatch(name) || SecretRedactor.Redact(value) != value);

    private static object? ToPlain(JsonNode? node) => node switch
    {
        JsonObject obj => obj.ToDictionary(kv => kv.Key, kv => ToPlain(kv.Value)),
        JsonArray array => array.Select(ToPlain).ToList(),
        JsonValue value when value.TryGetValue<double>(out var d) => d,
        JsonValue value when value.TryGetValue<int>(out var i) => i,
        JsonValue value when value.TryGetValue<bool>(out var b) => b,
        JsonValue value => value.ToString(),
        _ => null,
    };
}
