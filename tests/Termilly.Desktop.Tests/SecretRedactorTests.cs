using Termilly.Desktop.Security;

namespace Termilly.Desktop.Tests;

public sealed class SecretRedactorTests
{
    [Theory]
    [InlineData("export GITHUB_TOKEN=ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8", "ghp_A1b2")]
    [InlineData("token: github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN", "github_pat_11")]
    [InlineData("aws_access_key_id = AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE")]
    [InlineData("aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI")]
    [InlineData("DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4==;EndpointSuffix=core.windows.net", "Zm9vYmFy")]
    [InlineData("SLACK=xoxb-123456789012-abcdefghijkl", "xoxb-1234")]
    [InlineData("stripe sk_live_4eC39HqLyjWDarjtT1zdp7dc", "sk_live_4eC3")]
    [InlineData("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "eyJhbGci")]
    [InlineData("Server=db;User Id=sa;Password=Sup3r$ecret!;", "Sup3r$ecret")]
    [InlineData("$env:API_KEY = \"abcd1234efgh5678\"", "abcd1234efgh5678")]
    [InlineData("{\"client_secret\": \"s3cr3t-value-here\"}", "s3cr3t-value")]
    [InlineData("git clone https://alex:hunter2pass@github.com/x/y.git", "hunter2pass")]
    [InlineData("OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz012345", "sk-proj-abc")]
    [InlineData("git remote add origin https://oauth2:glpat-A1b2C3d4E5f6G7h8I9j0@gitlab.com/x/y.git", "glpat-A1b2")]
    [InlineData("curl -H \"Authorization: Bearer A1b2C3d4E5f6G7h8I9j0K1l2\" https://api.example.com", "A1b2C3d4")]
    // Named like a password: any quoted length counts.
    [InlineData("$pwd = \"abc\"", "abc")]
    [InlineData("set DB_PASS=Hunter2x", "Hunter2x")]
    // Password sinks: the argument can only be a secret, whatever it looks like.
    [InlineData("net user alex Hunter2x /add", "Hunter2x")]
    [InlineData("net use Z: \\\\srv\\share Hunter2x /user:alex", "Hunter2x")]
    [InlineData("mysql -u root -pHunter2x shop", "Hunter2x")]
    [InlineData("sshpass -p Hunter2x ssh alex@host", "Hunter2x")]
    [InlineData("docker login -u alex -p Hunter2x registry.example.com", "Hunter2x")]
    [InlineData("psql --password Hunter2x", "Hunter2x")]
    [InlineData("New-LocalUser alex -Password Hunter2x", "Hunter2x")]
    [InlineData("$s = ConvertTo-SecureString \"Hunter2x\" -AsPlainText -Force", "Hunter2x")]
    [InlineData("$s = ConvertTo-SecureString -String 'Hunter2x' -AsPlainText -Force", "Hunter2x")]
    [InlineData("\"Hunter2x\" | ConvertTo-SecureString -AsPlainText -Force", "Hunter2x")]
    [InlineData("New-Object PSCredential(\"alex\", \"Hunter2x\")", "Hunter2x")]
    [InlineData("curl -u alex:Hunter2x https://api.example.com", "Hunter2x")]
    [InlineData("cmdkey /add:srv /user:alex /pass:Hunter2x", "Hunter2x")]
    [InlineData("echo Hunter2x | sudo -S apt update", "Hunter2x")]
    [InlineData("echo 'Hunter2x' | docker login -u alex --password-stdin", "Hunter2x")]
    public void Secrets_are_redacted(string line, string secret)
    {
        var redacted = SecretRedactor.Redact(line);
        Assert.DoesNotContain(secret, redacted);
        Assert.Contains(SecretRedactor.Mask, redacted);
    }

    [Fact]
    public void A_private_key_block_spanning_lines_is_removed()
    {
        string[] lines = ["before", "-----BEGIN OPENSSH PRIVATE KEY-----", "b3BlbnNzaC1rZXktdjEAAAAA", "AAAAbm9uZQ==", "-----END OPENSSH PRIVATE KEY-----", "after"];
        var redacted = string.Join('\n', SecretRedactor.Redact(lines));
        Assert.DoesNotContain("b3BlbnNzaC1rZXk", redacted);
        Assert.StartsWith("before", redacted);
        Assert.EndsWith("after", redacted);
    }

    [Theory]
    // A variable of any name that reaches a sink: what was assigned to it, on any earlier line.
    [InlineData("PS C:\\> $p = \"mypwd\"\nPS C:\\> net user alex $p /add", "mypwd")]
    [InlineData("PS C:\\> $p = 'x'\nPS C:\\> $sec = ConvertTo-SecureString $p -AsPlainText -Force", "'x'")]
    [InlineData("$a = \"mypwd\"\n$b = $a\nNew-LocalUser alex -Password $b", "mypwd")]
    [InlineData("$s = ConvertTo-SecureString \"mypwd\" -AsPlainText -Force\n$c = New-Object PSCredential(\"alex\", $s)", "mypwd")]
    [InlineData("C:\\> set P=mypwd\nC:\\> net user alex %P% /add", "mypwd")]
    [InlineData("$ export P=mypwd\n$ sshpass -p \"$P\" ssh alex@host", "mypwd")]
    public void A_variable_used_as_a_password_has_its_value_redacted(string text, string secret)
    {
        var redacted = SecretRedactor.Redact(text);
        Assert.DoesNotContain(secret, redacted);
        Assert.Contains(SecretRedactor.Mask, redacted);
    }

    [Fact]
    public void Usernames_and_the_variable_itself_are_kept()
    {
        var redacted = SecretRedactor.Redact("$p = \"mypwd\"\nnet user alex $p /add");
        Assert.Equal("$p = \"[redacted]\"\nnet user alex $p /add", redacted);
    }

    [Theory]
    [InlineData(@"PS C:\Users\alex\source\repos> git log --oneline")]
    [InlineData("git log -p --stat")]
    [InlineData("psql -h db -p 5432 -U alex shop")]
    [InlineData("mysql -h db -P 3306 -u alex -p")]
    [InlineData("dotnet build /p:Configuration=Release")]
    [InlineData("net user alex")]
    [InlineData("net user alex * /add")]
    [InlineData("net user alex /delete")]
    [InlineData("docker login -u alex --password-stdin registry.example.com")]
    [InlineData("$password = Read-Host -AsSecureString")]
    [InlineData("$cred = Get-Credential alex")]
    [InlineData("The API uses a Bearer token.")]
    [InlineData("[sudo] password for alex:\nReading package lists... Done")]
    [InlineData("$name = \"Alex\"\nWrite-Host $name")]
    [InlineData("5836e24 Centre the search bar, resizable sidebar")]
    [InlineData("Id: 3f2504e0-4f89-11d3-9a0c-0305e82c3301")]
    [InlineData("Compiled 214 files in 3.2s, 0 warnings")]
    [InlineData("https://github.com/alexunder18/termilly")]
    [InlineData("for /f \"tokens=1,2\" %a in (file.txt) do echo %a")]
    public void Ordinary_output_is_left_alone(string line) => Assert.Equal(line, SecretRedactor.Redact(line));
}
