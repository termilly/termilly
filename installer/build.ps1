<#
.SYNOPSIS
  Builds Termilly Setup: dist\TermillySetup-<version>.exe.

.DESCRIPTION
  1. Builds Termilly (Release) and takes its output folder as the app to install.
  2. Downloads Microsoft's .NET 10 Desktop Runtime and WebView2 standalone installers into installer\.cache
     (once; -Refresh fetches them again), and checks they're signed by Microsoft.
  3. Builds the setup program (installer\TermillySetup, .NET Framework 4.8).
  4. Appends the payload to it: a zip of app\, prereqs\ and version.txt, then a footer with the zip's offset,
     SHA-256 and the magic "TMLYPAY1" (installer\TermillySetup\Engine\Payload.cs reads it back).

.PARAMETER NoPrereqs
  Leaves the runtimes out (setup then only downloads them): a small setup for testing.

.PARAMETER Refresh
  Downloads the runtime installers again (newer versions).

.PARAMETER Sign
  Signs with the maintainer's code signing certificate (Certum, in the cloud through SimplySign Desktop, which must be
  connected): every unsigned program and library going into the setup, before it's packed, then the setup itself, so
  Windows' Smart App Control lets them run and SmartScreen names the publisher. Uses Jsign (downloaded once into
  installer\.cache and checked against its SHA-256) with SimplySign's PKCS#11 library: signtool can only make SHA-1
  signatures through SimplySign's key provider. Runs on the maintainer's PC, not in GitHub Actions (SimplySign wants a
  code from its phone app).
#>
param(
    [switch]$NoPrereqs,
    [switch]$Refresh,
    [switch]$Sign
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is many times slower with its progress bar
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

$root = Split-Path $PSScriptRoot -Parent
$cache = Join-Path $PSScriptRoot '.cache'
$dist = Join-Path $root 'dist'

function Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }

# ---- Signing (-Sign) ----
# The certificate (Certum Open Source Code Signing, "Open Source Developer Aleksandar Milic"), Jsign and where they're reached.
$signing = @{
    Thumbprint = '9525CCE86C3ACE1C784718D6F6798C1245464679'
    Pkcs11 = Join-Path $env:SystemRoot 'System32\SimplySignPKCS.dll'
    Java = 'C:\Program Files\Certum\SimplySign Desktop\proCertum SmartSign\jre\bin\java.exe'
    JsignUrl = 'https://repo1.maven.org/maven2/net/jsign/jsign/7.6/jsign-7.6.jar'
    JsignSha256 = '6cf58aa080e7ff82656f320cff8d4a3bff30408df8766806dcba3740dd839fa5'
    Timestamp = 'http://time.certum.pl'
}

# Checks signing can work before the build starts: SimplySign there and connected, Java, Jsign (fetched once, checked).
function Initialize-Signing {
    Step 'Checking signing (SimplySign, Jsign)'
    if (-not (Test-Path $signing.Pkcs11)) { throw "SimplySign isn't installed ($($signing.Pkcs11) is missing): install SimplySign Desktop." }
    if (-not (Get-ChildItem Cert:\CurrentUser\My | Where-Object Thumbprint -eq $signing.Thumbprint)) {
        throw 'The code signing certificate isn''t there: open SimplySign Desktop and connect (the code from its phone app), then run again.'
    }
    $script:java = if (Test-Path $signing.Java) { $signing.Java } else { (Get-Command java -ErrorAction SilentlyContinue).Source }
    if (-not $script:java) { throw 'No Java to run Jsign: SimplySign Desktop brings one; install it, or Java 11 or newer.' }
    New-Item -ItemType Directory -Force $cache | Out-Null
    $script:jsign = Join-Path $cache 'jsign-7.6.jar'
    if (-not (Test-Path $script:jsign)) {
        Step 'Downloading Jsign 7.6'
        Invoke-WebRequest -Uri $signing.JsignUrl -OutFile $script:jsign -UseBasicParsing
    }
    if ((Get-FileHash $script:jsign -Algorithm SHA256).Hash -ne $signing.JsignSha256) {
        Remove-Item $script:jsign
        throw 'Jsign doesn''t match its known SHA-256; deleted it, run again to download it afresh.'
    }
    $script:jsignConfig = Join-Path $cache 'simplysign.cfg'
    [IO.File]::WriteAllText($script:jsignConfig, "name=SimplySign`nlibrary=$($signing.Pkcs11.Replace('\', '/'))`n")
    Write-Host '    SimplySign connected, Jsign 7.6 checked'
}

# Signs files (SHA-256, timestamped) and checks each now carries a valid signature by this certificate.
function Set-Signature([string[]]$files) {
    & $script:java -jar $script:jsign --storetype PKCS11 --keystore $script:jsignConfig --alg SHA-256 `
        --tsaurl $signing.Timestamp --tsmode RFC3161 @files
    if ($LASTEXITCODE) { throw "Signing failed (Jsign $LASTEXITCODE): is SimplySign Desktop still connected?" }
    foreach ($file in $files) {
        $signature = Get-AuthenticodeSignature $file
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $signing.Thumbprint -or -not $signature.TimeStamperCertificate) {
            throw "$file isn't signed as it should be ($($signature.Status))"
        }
    }
}

if ($Sign) { Initialize-Signing }

# ---- 1. Termilly ----
Step 'Building Termilly (Release)'
dotnet build (Join-Path $root 'src\Termilly.Desktop\Termilly.Desktop.csproj') -c Release -nologo -v q
if ($LASTEXITCODE) { throw 'Termilly build failed' }
$app = Join-Path $root 'src\Termilly.Desktop\bin\Release\net10.0-windows10.0.19041.0'
$exe = Join-Path $app 'Termilly.exe'
$version = ((Get-Item $exe).VersionInfo.ProductVersion -split '\+')[0]
Write-Host "    Termilly $version"

# ---- 2. Runtimes ----
$prereqs = @(
    @{ Name = 'windowsdesktop-runtime-win-x64.exe'; Url = 'https://aka.ms/dotnet/10.0/windowsdesktop-runtime-win-x64.exe' },
    @{ Name = 'MicrosoftEdgeWebView2RuntimeInstallerX64.exe'; Url = 'https://go.microsoft.com/fwlink/?linkid=2124701' }
)
if (-not $NoPrereqs) {
    New-Item -ItemType Directory -Force $cache | Out-Null
    foreach ($p in $prereqs) {
        $file = Join-Path $cache $p.Name
        if ($Refresh -or -not (Test-Path $file)) {
            Step "Downloading $($p.Name)"
            Invoke-WebRequest -Uri $p.Url -OutFile $file -UseBasicParsing
        }
        $signature = Get-AuthenticodeSignature $file
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
            Remove-Item $file
            throw "$($p.Name) isn't signed by Microsoft ($($signature.Status)); deleted it, run again to download it afresh"
        }
        Write-Host ("    {0} {1:N0} MB, signed by Microsoft" -f $p.Name, ((Get-Item $file).Length / 1MB))
    }
}

# ---- 3. Setup program ----
Step 'Building setup'
$setupProject = Join-Path $PSScriptRoot 'TermillySetup\TermillySetup.csproj'
dotnet build $setupProject -c Release -nologo -v q -p:Version=$version
if ($LASTEXITCODE) { throw 'Setup build failed' }
$stub = Join-Path $PSScriptRoot 'TermillySetup\bin\Release\net48\TermillySetup.exe'

# ---- 4. Payload ----
Step 'Packing the payload'
$staging = Join-Path ([IO.Path]::GetTempPath()) ("termilly-setup-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
$zipPath = "$staging.zip"
try {
    New-Item -ItemType Directory -Force (Join-Path $staging 'app') | Out-Null
    # Everything the build put next to Termilly.exe, without debug symbols and XML docs.
    robocopy $app (Join-Path $staging 'app') /E /XF *.pdb *.xml /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "copying Termilly's files failed (robocopy $LASTEXITCODE)" }
    if ($Sign) {
        # Termilly's own programs and libraries, and any other one without a signature; those signed already (Microsoft's,
        # .NET's) keep theirs.
        $unsigned = @(Get-ChildItem (Join-Path $staging 'app') -Recurse -File -Include *.exe, *.dll |
            Where-Object { (Get-AuthenticodeSignature $_.FullName).Status -eq 'NotSigned' } | ForEach-Object FullName)
        Step "Signing $($unsigned.Count) programs and libraries"
        Set-Signature $unsigned
    }
    if (-not $NoPrereqs) {
        New-Item -ItemType Directory -Force (Join-Path $staging 'prereqs') | Out-Null
        foreach ($p in $prereqs) { Copy-Item (Join-Path $cache $p.Name) (Join-Path $staging 'prereqs') }
    }
    [IO.File]::WriteAllText((Join-Path $staging 'version.txt'), $version)
    # Entry names with forward slashes (PowerShell 5's ZipFile.CreateFromDirectory writes backslashes). The runtime
    # installers are stored as they are, being compressed already; Termilly's files are compressed.
    $zip = [IO.Compression.ZipFile]::Open($zipPath, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in Get-ChildItem $staging -Recurse -File) {
            $name = $file.FullName.Substring($staging.Length + 1).Replace('\', '/')
            $level = if ($name.StartsWith('prereqs/')) { [IO.Compression.CompressionLevel]::NoCompression } else { [IO.Compression.CompressionLevel]::Optimal }
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $name, $level)
        }
    } finally { $zip.Dispose() }

    New-Item -ItemType Directory -Force $dist | Out-Null
    $out = Join-Path $dist "TermillySetup-$version$(if ($NoPrereqs) { '-online' }).exe"
    $stubBytes = [IO.File]::ReadAllBytes($stub)
    $sha = [Security.Cryptography.SHA256]::Create()
    $zipStream = [IO.File]::OpenRead($zipPath)
    try { $hash = $sha.ComputeHash($zipStream) } finally { $zipStream.Dispose() }

    $output = [IO.File]::Create($out)
    try {
        $output.Write($stubBytes, 0, $stubBytes.Length)
        $zipStream = [IO.File]::OpenRead($zipPath)
        try { $zipStream.CopyTo($output) } finally { $zipStream.Dispose() }
        $footer = [BitConverter]::GetBytes([long]$stubBytes.Length) + $hash + [Text.Encoding]::ASCII.GetBytes('TMLYPAY1')
        $output.Write($footer, 0, $footer.Length)
    } finally { $output.Dispose() }

    if ($Sign) {
        # After the payload: the signature goes at the end and covers it (Payload.cs finds the payload before it).
        Step 'Signing the setup'
        Set-Signature @($out)
    }
    Step "Done: $out"
    Write-Host ("    {0:N1} MB (setup {1:N0} KB + payload {2:N1} MB)" -f ((Get-Item $out).Length / 1MB), ($stubBytes.Length / 1KB), ((Get-Item $zipPath).Length / 1MB))
    if (-not $Sign) { Write-Host '    Not signed: build.ps1 -Sign signs it and everything in it.' }
}
finally {
    Remove-Item -Recurse -Force $staging -ErrorAction SilentlyContinue
    Remove-Item -Force $zipPath -ErrorAction SilentlyContinue
}
