using System.Text.Json;

namespace Termilly.Desktop.Messaging;

internal static partial class FromPage
{
    internal sealed record TestReady : IPageMessage
    {
        public static string Type => "test:ready";
    }

    internal sealed record TestResult(string Id = "", JsonElement? Value = null, string? Error = null) : IPageMessage
    {
        public static string Type => "test:result";
    }
}

internal static partial class ToPage
{
    internal sealed record TestEval(string Id, string Code) : IHostMessage
    {
        public static string Type => "test:eval";
    }
}
