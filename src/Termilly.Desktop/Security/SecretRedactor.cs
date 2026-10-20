using System.Text.RegularExpressions;

namespace Termilly.Desktop.Security;

/// <summary>
/// Replaces secrets in terminal output with [redacted] before it is saved to history.
/// Optional (Settings › Privacy &amp; security); it errs towards redacting too much.
/// <para>
/// A password has no shape of its own, so it is found by where it is used rather than by what it looks like:
/// <list type="number">
/// <item>tokens with a recognisable format (GitHub, AWS, Slack, JWTs, private keys…), replaced whole;</item>
/// <item>password sinks: arguments that can only be a secret (<c>net user name PASS</c>, <c>-p PASS</c>,
/// <c>-Password PASS</c>, <c>ConvertTo-SecureString PASS</c>, <c>curl -u user:PASS</c>…);</item>
/// <item>values assigned to a name that says it holds one (<c>$password = …</c>, <c>API_KEY=…</c>, JSON, connection strings);</item>
/// <item>variables that reach a sink, whatever their name: <c>$p = "x"</c> … <c>net user alex $p</c> redacts the "x";</item>
/// <item>passwords in URLs (<c>scheme://user:PASS@host</c>).</item>
/// </list>
/// A literal that is never used as a password and isn't named like one can't be told apart from any other text.
/// Separators are spaces and tabs only, so a rule never reaches into the next line.
/// </para>
/// </summary>
internal static partial class SecretRedactor
{
    public const string Mask = "[redacted]";
    /// <summary>The variable reference pattern's group with the variable's name.</summary>
    private const string NameGroup = "name";

    // A sink's argument: quoted (any length; the quotes are kept) or a bare word.
    private const string Value = @"(?:""(?<value>[^""\n]+)""|'(?<value>[^'\n]+)'|(?<value>[^\s""';|&()]+))";

    // Tokens with a recognisable prefix or shape: replaced whole.
    [GeneratedRegex(
        @"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)" +
        @"|\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}" +
        @"|\bgithub_pat_[A-Za-z0-9_]{40,}" +
        @"|\bglpat-[A-Za-z0-9_-]{20,}" +
        @"|\bnpm_[A-Za-z0-9]{36}\b" +
        @"|\bhf_[A-Za-z0-9]{30,}" +
        @"|\bdop_v1_[a-f0-9]{64}\b" +
        @"|\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}" +
        @"|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b" +
        @"|\bxox[abposr]-[A-Za-z0-9-]{10,}" +
        @"|\bxapp-[A-Za-z0-9-]{10,}" +
        @"|\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}" +
        @"|\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}" +
        @"|\bAIza[0-9A-Za-z_-]{35}\b" +
        @"|\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")]
    private static partial Regex Tokens();

    // ---- Password sinks: the "value" group is the secret, or a variable holding it. ----

    // net user alex PASS /add · net use Z: \\srv\share PASS /user:alex (not "*", which prompts, or a /switch)
    [GeneratedRegex(@"\bnet[ \t]+(?:user[ \t]+(?!/)[^\s/]+|use[ \t]+(?:[a-z]:[ \t]+|\*[ \t]+)?\\\\\S+)[ \t]+(?![*/])" + Value, RegexOptions.IgnoreCase)]
    private static partial Regex NetUser();

    // --password PASS, --password=PASS, -Password PASS, -NewPassword PASS, --client-secret PASS, -Token PASS…
    [GeneratedRegex(@"(?<=\s)--?[\w-]*(?:password|passwd|passphrase|pwd|secret|token|api-?key|credential)(?:[=:]|[ \t]+)(?!-)" + Value, RegexOptions.IgnoreCase)]
    private static partial Regex PasswordFlags();

    // -p is the password for these tools (mysql -pPASS, sshpass -p PASS, docker login -p PASS). Case-sensitive: -P is a port.
    [GeneratedRegex(@"\b(?:mysql\w*|mariadb\w*|sshpass|mongo(?:sh|dump|restore|import|export)?|(?:docker|podman|nerdctl|helm[ \t]+registry)[ \t]+login)\b[^\n|;&]*?[ \t]-p[ \t]*(?!-)" + Value)]
    private static partial Regex ShortPasswordFlag();

    // ConvertTo-SecureString "PASS" -AsPlainText -Force (also with -String, or the switches first)
    [GeneratedRegex(@"\bConvertTo-SecureString(?:[ \t]+-(?:AsPlainText|Force|String)\b)*[ \t]+(?!-)" + Value, RegexOptions.IgnoreCase)]
    private static partial Regex SecureString();

    // New-Object PSCredential("alex", PASS) · [PSCredential]::new("alex", PASS)
    [GeneratedRegex(@"\bPSCredential\]?(?:::new)?[ \t]*\([ \t]*(?:""[^""\n]*""|'[^'\n]*'|\$[\w:]+)[ \t]*,[ \t]*" + Value, RegexOptions.IgnoreCase)]
    private static partial Regex PsCredential();

    // curl -u alex:PASS · --user alex:PASS
    [GeneratedRegex(@"(?<=\s)(?:-u|--user)[ \t]+[""']?[^\s:""']+:" + Value)]
    private static partial Regex UserColonPassword();

    // cmdkey /pass:PASS · /password:PASS (not /p:, which is msbuild's property switch)
    [GeneratedRegex(@"(?<=\s)/(?:pass|password|pwd)[:=]" + Value, RegexOptions.IgnoreCase)]
    private static partial Regex SlashPassword();

    // echo PASS | sudo -S · … | docker login --password-stdin · … | chpasswd · "PASS" | ConvertTo-SecureString
    [GeneratedRegex(@"(?:\b(?:echo|printf|Write-Output)[ \t]+(?:-n[ \t]+)?)?" + Value + @"(?=[ \t]*\|[ \t]*(?:sudo\b[^\n|]*[ \t]-S\b|[^\n|]*--password-stdin|chpasswd|passwd\b|ConvertTo-SecureString))", RegexOptions.IgnoreCase)]
    private static partial Regex PipedPassword();

    // Authorization: Bearer TOKEN · Basic BASE64
    [GeneratedRegex(@"\b(?:Bearer|Basic)[ \t]+(?<value>[A-Za-z0-9._~+/-]{16,}=*)")]
    private static partial Regex AuthHeader();

    private static readonly Regex[] Sinks =
        [NetUser(), PasswordFlags(), ShortPasswordFlag(), SecureString(), PsCredential(), UserColonPassword(), SlashPassword(), PipedPassword(), AuthHeader()];

    // "name = value" pairs (also JSON "name": "value", env vars, connection strings): the value is replaced.
    // A quoted value of any length counts; a bare one needs 4+ characters.
    [GeneratedRegex(
        @"\b[\w.-]*(?:password|passwd|passphrase|pass|pwd|secret|token|api[_-]?key|access[_-]?key|account[_-]?key|private[_-]?key|client[_-]?secret|sharedaccesskey|credentials?|sig)\b[""']?[ \t]*[:=][ \t]*(?!=)" +
        @"(?:""(?<value>[^""\n]+)""|'(?<value>[^'\n]+)'|(?<value>[^\s""';,&()]{4,}))",
        RegexOptions.IgnoreCase)]
    private static partial Regex Assignments();

    // Credentials inside URLs: scheme://user:password@host
    [GeneratedRegex(@"\b[a-z][a-z0-9+.-]*://[^\s:/@]+:(?<value>[^\s@/]+)(?=@)", RegexOptions.IgnoreCase)]
    private static partial Regex UrlCredentials();

    // A variable as written in PowerShell ($p, ${p}, $env:P), cmd (%P%) or bash ($P, ${P}).
    [GeneratedRegex(@"^(?:\$\{?(?:env:)?(?<name>\w+)\}?|%(?<name>\w+)%)$", RegexOptions.IgnoreCase)]
    private static partial Regex Variable();

    // A cmdlet (Read-Host, Get-Credential): where a value is read from, not the secret itself.
    [GeneratedRegex(@"^[A-Z][a-z]+-[A-Z]\w+$")]
    private static partial Regex Cmdlet();

    public static string Redact(string text)
    {
        var tainted = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        text = Tokens().Replace(text, Mask);
        foreach (var sink in Sinks)
        {
            text = sink.Replace(text, m => MaskValue(m, tainted));
        }
        text = Assignments().Replace(text, m => MaskValue(m, tainted));
        text = RedactTainted(text, tainted);
        return UrlCredentials().Replace(text, m => MaskValue(m, tainted));
    }

    /// <summary>
    /// Redacts a terminal's lines. They are joined first so a private key block spanning lines, or a variable set on
    /// one line and used on another, is caught; the line count can shrink when a key block is.
    /// </summary>
    public static IReadOnlyList<string> Redact(IReadOnlyList<string> lines) =>
        Redact(string.Join('\n', lines)).Split('\n');

    /// <summary>
    /// Masks the match's value. A variable isn't the secret itself, so it is kept and remembered, and what was
    /// assigned to it is redacted afterwards.
    /// </summary>
    private static string MaskValue(Match m, HashSet<string> tainted)
    {
        var value = m.Groups["value"];
        if (value.Value.Contains(Mask) || Cmdlet().IsMatch(value.Value))
        {
            return m.Value;
        }
        if (Variable().Match(value.Value) is { Success: true } variable)
        {
            tainted.Add(variable.Groups[NameGroup].Value);
            return m.Value;
        }
        var start = value.Index - m.Index;
        return string.Concat(m.Value.AsSpan(0, start), Mask, m.Value.AsSpan(start + value.Length));
    }

    /// <summary>
    /// Redacts what was assigned to variables that reached a password sink ($p = "x", set P=x, export P=x),
    /// repeating while that turns up more of them ($b = $a).
    /// </summary>
    private static string RedactTainted(string text, HashSet<string> tainted)
    {
        var done = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        while (tainted.Except(done).ToList() is { Count: > 0 } next)
        {
            done.UnionWith(next);
            var names = string.Join('|', next.Select(Regex.Escape));
            var assignment = new Regex(
                $@"(?<![\w-])(?:\$\{{?(?:env:)?|set[ \t]+""?|export[ \t]+)?(?:{names})\}}?[ \t]*=[ \t]*(?!=)" + Value,
                RegexOptions.IgnoreCase);
            text = assignment.Replace(text, m => MaskValue(m, tainted));
        }
        return text;
    }
}
