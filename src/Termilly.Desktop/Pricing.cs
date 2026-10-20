namespace Termilly.Desktop;

/// <summary>
/// What tokens would cost on the Claude API, per million tokens, for the cost estimates of subagents and of sessions
/// whose status line hasn't reported Claude's own figure yet. An estimate: list prices as of 2026-10 (Anthropic's
/// first-party API), cache writes at 1.25× input (5-minute cache). For Pro and Max plans it's what the work would cost
/// on the API, not a bill. Easy to update: one row per model family.
/// </summary>
internal static class Pricing
{
    /// <summary>Prices are per this many tokens.</summary>
    private const double TokensPerPrice = 1_000_000;

    /// <summary>A model family's prices: input, output, cache write and cache read, in dollars per million tokens.</summary>
    private readonly record struct ModelPrice(string Prefix, double In, double Out, double Write, double Read);

    /// <summary>One row per model id prefix. Longest prefix wins.</summary>
    private static readonly ModelPrice[] Table = [
        new("claude-fable-5-1", 10, 50, 12.5, 0.25),
        new("claude-mythos-5-1", 10, 50, 12.5, 0.25),
        new("claude-fable-5", 10, 50, 12.5, 1.0),
        new("claude-mythos-5", 10, 50, 12.5, 1.0),
        new("claude-opus-5-5", 4, 20, 5, 0.20),
        new("claude-opus-5", 5, 25, 6.25, 0.50),
        new("claude-opus-4", 5, 25, 6.25, 0.50),
        new("claude-sonnet-5-5", 2, 10, 2.5, 0.20),
        new("claude-sonnet-5", 2, 10, 2.5, 0.20),
        new("claude-sonnet-4", 3, 15, 3.75, 0.30),
        new("claude-haiku-5-5", 0.10, 0.50, 0.125, 0.01),
        new("claude-haiku-4", 1, 5, 1.25, 0.10),
    ];

    /// <summary>The estimated dollars for these tokens on <paramref name="model"/>; null for a model not in the table.</summary>
    public static double? Estimate(string? model, long input, long cacheWrite, long cacheRead, long output)
    {
        if (string.IsNullOrEmpty(model))
        {
            return null;
        }
        var id = model.ToLowerInvariant();
        var row = Table.Where(r => id.StartsWith(r.Prefix, StringComparison.Ordinal)).OrderByDescending(r => r.Prefix.Length).FirstOrDefault();
        if (row.Prefix is null)
        {
            return null;
        }
        return (input * row.In + output * row.Out + cacheWrite * row.Write + cacheRead * row.Read) / TokensPerPrice;
    }
}
