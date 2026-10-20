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
#>
param(
    [switch]$NoPrereqs,
    [switch]$Refresh
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is many times slower with its progress bar
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

$root = Split-Path $PSScriptRoot -Parent
$cache = Join-Path $PSScriptRoot '.cache'
$dist = Join-Path $root 'dist'

function Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }

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

    Step "Done: $out"
    Write-Host ("    {0:N1} MB (setup {1:N0} KB + payload {2:N1} MB)" -f ((Get-Item $out).Length / 1MB), ($stubBytes.Length / 1KB), ((Get-Item $zipPath).Length / 1MB))
    Write-Host '    Sign it (signtool sign /fd sha256 /tr <timestamp url> /td sha256 ...) after this step: signing covers the payload.'
}
finally {
    Remove-Item -Recurse -Force $staging -ErrorAction SilentlyContinue
    Remove-Item -Force $zipPath -ErrorAction SilentlyContinue
}
