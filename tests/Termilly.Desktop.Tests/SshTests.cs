extern alias agent;

using agent::Termilly.Agent;

namespace Termilly.Desktop.Tests;

public sealed class SshTests
{
    // ---- Connections ----

    [Fact]
    public void A_connection_becomes_ssh_arguments_with_port_jumps_and_key()
    {
        var c = new SshConnection("c1", "api", "api.internal", "deploy", 2222, "bastion,user@jump2", "key", @"C:\keys\id_ed25519");
        Assert.Equal("-p 2222 -J bastion,user@jump2 -i \"C:\\keys\\id_ed25519\" -o IdentitiesOnly=yes deploy@api.internal", SshConnections.Arguments(c));
        Assert.Equal("deploy@api.internal:2222 via bastion,user@jump2", SshConnections.Describe(c));
        Assert.Equal("db", SshConnections.Arguments(new SshConnection("c2", "db", "db")));
    }

    [Fact]
    public void Password_references_go_through_the_askpass_helper_never_as_text()
    {
        var wincred = new SshConnection("c1", "api", "h", Identity: "wincred");
        var env = SshConnections.EnvironmentFor(wincred, @"C:\app\agent")!;
        Assert.Equal(@"C:\app\agent\termilly-askpass.exe", env["SSH_ASKPASS"]);
        Assert.Equal("force", env["SSH_ASKPASS_REQUIRE"]);
        Assert.Equal("wincred:Termilly/ssh/c1", env["TERMILLY_CREDENTIAL"]);

        var op = new SshConnection("c2", "db", "h", Identity: "op", SecretRef: "op://Private/db/password");
        Assert.Equal("op:op://Private/db/password", SshConnections.EnvironmentFor(op, "x")!["TERMILLY_CREDENTIAL"]);
        Assert.Null(SshConnections.EnvironmentFor(new SshConnection("c3", "k", "h"), "x"));
    }

    [Fact]
    public void Unsafe_or_incomplete_connections_are_dropped()
    {
        var list = SshConnections.Normalize(
        [
            new SshConnection("a", " ok ", " host.example ", Jump: " j1 , j2 ", Port: 70000, Identity: "magic", SecretRef: "not-a-ref"),
            new SshConnection("b", "spaces", "evil host"),
            new SshConnection("c", "quotes", "h", User: "a\"b"),
            new SshConnection("a", "duplicate", "h"),
            new SshConnection("d", "", "h"),
        ]);
        var only = Assert.Single(list);
        Assert.Equal(("ok", "host.example", "j1,j2", (int?)null, "agent", (string?)null), (only.Name, only.Host, only.Jump, only.Port, only.Identity, only.SecretRef));
    }

    [Fact]
    public void Connections_become_profiles_and_production_ones_are_tagged()
    {
        var profiles = SessionProfiles.Connections([new SshConnection("c1", "api-prod", "10.0.0.5", "deploy")], [], @"C:\agent").ToList();
        var p = Assert.Single(profiles);
        Assert.Equal(("conn-c1", "ssh.exe deploy@10.0.0.5", ProfileSources.Ssh), (p.Id, p.CommandLine, p.Source));
        Assert.Equal(["prod"], p.Tags);
    }

    [Fact]
    public void ProxyJump_from_the_config_is_shown()
    {
        var hosts = SshConfig.Parse("Host app\n  HostName 10.1.1.1\n  ProxyJump bastion\nHost direct\n  ProxyJump none\n");
        Assert.Equal("bastion", hosts[0].ProxyJump);
        Assert.Null(hosts[1].ProxyJump);
    }

    // ---- Forwards ----

    [Fact]
    public void Forwards_listen_on_this_pc_only_and_fail_fast()
    {
        var local = new PortForward("f", "db", "conn-c1", "L", 15432, "db.internal", 5432);
        Assert.Equal("-N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o BatchMode=yes -L 127.0.0.1:15432:db.internal:5432 bastion",
            SshConnections.ForwardArguments(local, "bastion", batch: true));
        Assert.Contains("-D 127.0.0.1:1080", SshConnections.ForwardArguments(local with { Kind = "D", ListenPort = 1080 }, "x", false));
        Assert.Contains("-R 9000:localhost:3000", SshConnections.ForwardArguments(local with { Kind = "R", ListenPort = 9000, DestHost = "localhost", DestPort = 3000 }, "x", false));
    }

    [Fact]
    public void Forwards_need_valid_ports_and_a_destination()
    {
        var list = SshConnections.Normalize(
        [
            new PortForward("a", "ok", "conn-x", "L", 8080, "", 80),
            new PortForward("b", "no dest port", "conn-x", "L", 8080),
            new PortForward("c", "socks", "conn-x", "D", 1080),
            new PortForward("d", "bad port", "conn-x", "L", 0, "h", 80),
            new PortForward("e", "bad host", "conn-x", "L", 1, "a b", 80),
        ]);
        Assert.Equal(["a", "c"], list.Select(f => f.Id));
        Assert.Equal("localhost", list[0].DestHost);
    }

    // ---- Askpass ----

    [Theory]
    [InlineData("deploy@api's password: ", true)]
    [InlineData("Enter passphrase for key 'C:/keys/id': ", true)]
    [InlineData("Enter PIN for ED25519-SK key: ", true)]
    [InlineData("Are you sure you want to continue connecting (yes/no/[fingerprint])? ", false)]
    public void Askpass_answers_password_prompts_and_leaves_questions_to_the_user(string prompt, bool secret) =>
        Assert.Equal(secret, Askpass.IsSecretPrompt(prompt));

    [Fact]
    public void Askpass_without_a_reference_has_no_secret() =>
        Assert.Null(Askpass.Secret("wincred:Termilly/ssh/does-not-exist-" + Guid.NewGuid()));

    // ---- Importing ----

    [Fact]
    public void PuTTY_sessions_import_ssh_only_with_user_and_port()
    {
        var api = SshImport.PuTTYSession("api%20prod", new Dictionary<string, object?> { ["HostName"] = "deploy@10.0.0.5", ["PortNumber"] = 2222, ["Protocol"] = "ssh", ["PublicKeyFile"] = @"C:\k.ppk" });
        Assert.Equal(new ImportedHost("PuTTY", "api prod", "10.0.0.5", "deploy", 2222, @"C:\k.ppk"), api);
        Assert.Null(SshImport.PuTTYSession("serial", new Dictionary<string, object?> { ["HostName"] = "COM1", ["Protocol"] = "serial" }));
        Assert.Null(SshImport.PuTTYSession("Default%20Settings", new Dictionary<string, object?> { ["HostName"] = "x" }));
    }

    [Fact]
    public void MobaXterm_ssh_bookmarks_import()
    {
        var hosts = SshImport.MobaXterm("""
            [Bookmarks]
            SubRep=
            ImgNum=42
            web01=#109#0%192.168.1.10%2222%root%%-1%-1%%%%%0%0%0%_CurrentDrive_:\keys\id_rsa%%-1%0%0%0%%1080%%0%0%1#MobaFont%10
            rdp=#91#4%10.0.0.9%3389%admin%0%-1%-1%-1%-1%0%0%-1
            [Bookmarks_1]
            SubRep=prod
            db=#109#0%db.internal%22%%%-1
            """).ToList();
        Assert.Equal(2, hosts.Count);
        Assert.Equal(new ImportedHost("MobaXterm", "web01", "192.168.1.10", "root", 2222, @"C:\keys\id_rsa"), hosts[0]);
        Assert.Equal(("db", "db.internal", (string?)null, (int?)null), (hosts[1].Name, hosts[1].Host, hosts[1].User, hosts[1].Port));
    }

    [Fact]
    public void SecureCrt_sessions_import()
    {
        var host = SshImport.SecureCrt("prod/api", "S:\"Protocol Name\"=SSH2\nS:\"Hostname\"=api.example.com\nS:\"Username\"=deploy\nD:\"[SSH2] Port\"=000008ae\n");
        Assert.Equal(new ImportedHost("SecureCRT", "prod/api", "api.example.com", "deploy", 2222, null), host);
        Assert.Null(SshImport.SecureCrt("telnet", "S:\"Protocol Name\"=Telnet\nS:\"Hostname\"=x\n"));
    }

    [Fact]
    public void MRemoteNg_ssh_connections_import_and_encrypted_files_are_explained()
    {
        var notes = new List<string>();
        var hosts = SshImport.MRemoteNg("""
            <Connections Name="Connections" FullFileEncryption="false">
              <Node Name="Servers" Type="Container">
                <Node Name="api" Type="Connection" Protocol="SSH2" Hostname="10.0.0.5" Username="deploy" Port="22" Password="secret" />
                <Node Name="desk" Type="Connection" Protocol="RDP" Hostname="10.0.0.9" />
              </Node>
            </Connections>
            """, notes).ToList();
        Assert.Equal(new ImportedHost("mRemoteNG", "api", "10.0.0.5", "deploy", null, null), Assert.Single(hosts));

        Assert.Empty(SshImport.MRemoteNg("<Connections FullFileEncryption=\"true\">gibberish</Connections>", notes));
        Assert.Contains(notes, n => n.Contains("encrypted"));
    }
}
