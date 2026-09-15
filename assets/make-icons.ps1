Add-Type -AssemblyName System.Drawing

function New-Icon([int]$size, [string]$outPath) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.Clear([System.Drawing.Color]::Transparent)

  # Work in a 128-unit design space, scaled to the requested size.
  $k = $size / 128.0
  $g.ScaleTransform($k, $k)

  # Rounded black background (Twitter/X black).
  $r = 28
  $bg = New-Object System.Drawing.Drawing2D.GraphicsPath
  $bg.AddArc(0, 0, $r*2, $r*2, 180, 90)
  $bg.AddArc(128-$r*2, 0, $r*2, $r*2, 270, 90)
  $bg.AddArc(128-$r*2, 128-$r*2, $r*2, $r*2, 0, 90)
  $bg.AddArc(0, 128-$r*2, $r*2, $r*2, 90, 90)
  $bg.CloseFigure()
  $black = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,0,0,0))
  $g.FillPath($black, $bg)

  # White speech bubble.
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $bubble = New-Object System.Drawing.Drawing2D.GraphicsPath
  $bubble.AddEllipse(26, 30, 76, 56)
  $bubble.CloseFigure()
  $g.FillPath($white, $bubble)

  # Bubble tail (bottom-left).
  $tail = @(
    (New-Object System.Drawing.PointF(44, 74)),
    (New-Object System.Drawing.PointF(38, 94)),
    (New-Object System.Drawing.PointF(58, 80))
  )
  $g.FillPolygon($white, [System.Drawing.PointF[]]$tail)

  # Blue lightning bolt in the middle.
  $blue = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,29,155,240))
  $bolt = @(
    (New-Object System.Drawing.PointF(69, 34)),
    (New-Object System.Drawing.PointF(52, 62)),
    (New-Object System.Drawing.PointF(63, 62)),
    (New-Object System.Drawing.PointF(59, 84)),
    (New-Object System.Drawing.PointF(76, 55)),
    (New-Object System.Drawing.PointF(65, 55))
  )
  $g.FillPolygon($blue, [System.Drawing.PointF[]]$bolt)

  $g.Dispose()
  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

$dir = (Get-Location).Path
foreach ($s in @(16, 48, 128)) {
  New-Icon -size $s -outPath "$dir\icons\icon$s.png"
  Write-Output "wrote icon$s.png"
}
