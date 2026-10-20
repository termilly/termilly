<#
  Renders the Termilly "T:" icon pixel-exact at each size and packs the Windows sizes into an .ico.

  Small sizes have hand-placed layouts: every bar, dot and the rim sit on whole pixels and the glyph is
  drawn without anti-aliasing, so nothing is blurred by half-covered pixels. Sizes that are multiples of
  32 scale the 32 px layout exactly; any other size scales it with rounding.

  Usage: powershell -File branding/make-icon.ps1 [-IcoPath <path>] [-PngDir <dir>] [-PngSizes 20,30,40,...]
#>
param(
    [string]$IcoPath = (Join-Path $PSScriptRoot 'termilly.ico'),
    [string]$PngDir = (Join-Path $PSScriptRoot 'png'),
    [int[]]$PngSizes = @(16, 18, 20, 24, 30, 32, 36, 40, 48, 56, 60, 64, 72, 80, 84, 96, 112, 128, 256)
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$IcoSizes = 16, 20, 24, 30, 32, 36, 40, 48, 64, 72, 96, 128, 256

# Glyph rectangles [x, y, w, h] in pixels: T top bar, T stem, colon upper dot, colon lower dot.
# Each layout keeps the stem centred under the bar, the lower dot level with the stem's foot, and the
# glyph centred in the tile.
$Layouts = @{
    16 = @{ Radius = 3;  Bars = @(@(3, 4, 6, 2),   @(5, 4, 2, 8),    @(10, 6, 2, 2),  @(10, 10, 2, 2)) }
    20 = @{ Radius = 4;  Bars = @(@(4, 5, 8, 2),   @(7, 5, 2, 10),   @(14, 9, 2, 2),  @(14, 13, 2, 2)) }
    24 = @{ Radius = 5;  Bars = @(@(5, 6, 9, 3),   @(8, 6, 3, 12),   @(16, 10, 3, 3), @(16, 15, 3, 3)) }
    30 = @{ Radius = 6;  Bars = @(@(5, 8, 14, 4),  @(10, 8, 4, 15),  @(21, 12, 4, 4), @(21, 19, 4, 4)) }
    32 = @{ Radius = 7;  Bars = @(@(7, 8, 12, 4),  @(11, 8, 4, 16),  @(21, 13, 4, 4), @(21, 20, 4, 4)) }
    40 = @{ Radius = 9;  Bars = @(@(9, 10, 15, 5), @(14, 10, 5, 20), @(26, 16, 5, 5), @(26, 25, 5, 5)) }
    48 = @{ Radius = 10; Bars = @(@(10, 12, 18, 6), @(16, 12, 6, 24), @(31, 20, 6, 6), @(31, 30, 6, 6)) }
}

function Get-Layout([int]$size) {
    if ($Layouts.ContainsKey($size)) {
        return @{ Radius = $Layouts[$size].Radius; Bars = $Layouts[$size].Bars; Rim = 1; GlyphRadius = 0 }
    }
    # Scale the 32 px layout: exact for multiples of 32, rounded otherwise.
    $k = $size / 32.0
    $base = $Layouts[32]
    $bars = foreach ($b in $base.Bars) {
        $x = [Math]::Round($b[0] * $k); $y = [Math]::Round($b[1] * $k)
        , @($x, $y, ([Math]::Round(($b[0] + $b[2]) * $k) - $x), ([Math]::Round(($b[1] + $b[3]) * $k) - $y))
    }
    return @{ Radius = [Math]::Round(7 * $k); Bars = $bars; Rim = [Math]::Max(1, [Math]::Round($k)); GlyphRadius = [Math]::Floor($k / 2) }
}

function New-RoundRect([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    if ($r -le 0) { $path.AddRectangle((New-Object System.Drawing.RectangleF $x, $y, $w, $h)); return $path }
    $d = [Math]::Min($r * 2, [Math]::Min($w, $h))
    $path.AddArc($x, $y, $d, $d, 180, 90)
    $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

function Render-Icon([int]$size) {
    $layout = Get-Layout $size
    $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::Transparent)
    # Half: pixel (0,0) covers [0,1]x[0,1], so whole-number rectangles fill whole pixels exactly.
    $g.PixelOffsetMode = 'Half'

    # Tile: dark violet-black gradient. Rounded corners are the only anti-aliased edges.
    $g.SmoothingMode = 'AntiAlias'
    $tile = New-RoundRect 0 0 $size $size $layout.Radius
    $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.PointF 0, 0), (New-Object System.Drawing.PointF 0, $size),
        [System.Drawing.Color]::FromArgb(255, 0x1d, 0x18, 0x33), [System.Drawing.Color]::FromArgb(255, 0x07, 0x07, 0x0a))
    $g.FillPath($bg, $tile)

    # Rim: a whole-pixel violet line just inside the edge.
    $rimW = $layout.Rim
    $rim = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(205, 0x8b, 0x7b, 0xff)), $rimW
    $g.DrawPath($rim, (New-RoundRect ($rimW / 2) ($rimW / 2) ($size - $rimW) ($size - $rimW) ([Math]::Max(0, $layout.Radius - $rimW / 2))))

    # Glyph: hard-edged rectangles on the pixel grid. The T is light lavender, the colon violet; large
    # sizes get a slight vertical gradient and softened corners.
    $tLight = [System.Drawing.Color]::FromArgb(255, 0xee, 0xea, 0xff)
    $tDeep = [System.Drawing.Color]::FromArgb(255, 0xc9, 0xc0, 0xff)
    $colon = [System.Drawing.Color]::FromArgb(255, 0xa3, 0x95, 0xff)
    $g.SmoothingMode = if ($layout.GlyphRadius -gt 0) { 'AntiAlias' } else { 'None' }
    for ($i = 0; $i -lt 4; $i++) {
        $b = $layout.Bars[$i]
        $brush = if ($i -lt 2) {
            New-Object System.Drawing.Drawing2D.LinearGradientBrush(
                (New-Object System.Drawing.PointF 0, $b[1]), (New-Object System.Drawing.PointF 0, ($layout.Bars[1][1] + $layout.Bars[1][3] + 1)),
                $tLight, $tDeep)
        } else {
            New-Object System.Drawing.SolidBrush $colon
        }
        $g.FillPath($brush, (New-RoundRect $b[0] $b[1] $b[2] $b[3] $layout.GlyphRadius))
    }

    $g.Dispose()
    return $bmp
}

New-Item -ItemType Directory -Force $PngDir | Out-Null
foreach ($size in ($PngSizes | Sort-Object -Unique)) {
    $bmp = Render-Icon $size
    $bmp.Save((Join-Path $PngDir "termilly-$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

# ICO container: header, one directory entry per size, then the PNG images.
$entries = foreach ($size in $IcoSizes) {
    $bmp = Render-Icon $size
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    [pscustomobject]@{ Size = $size; Data = $ms.ToArray() }
}
$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $out
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$entries.Count)
$offset = 6 + 16 * $entries.Count
foreach ($e in $entries) {
    $dim = if ($e.Size -ge 256) { 0 } else { $e.Size }
    $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([uint16]1); $w.Write([uint16]32)
    $w.Write([uint32]$e.Data.Length); $w.Write([uint32]$offset)
    $offset += $e.Data.Length
}
foreach ($e in $entries) { $w.Write($e.Data) }
$w.Flush()
New-Item -ItemType Directory -Force (Split-Path $IcoPath) | Out-Null
[System.IO.File]::WriteAllBytes($IcoPath, $out.ToArray())
Write-Output "Wrote $IcoPath (sizes: $($IcoSizes -join ', ')) and PNGs in $PngDir"
