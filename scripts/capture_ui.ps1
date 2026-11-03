$distDir = (Resolve-Path "ui\dist").Path -replace '\\', '/'
$outPng = (Resolve-Path .).Path + "\design\tori_desktop_ui_rendered.png"

$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) {
    $edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
}

Write-Host "Rendering $distDir/index.html to $outPng..."
$argList = @(
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--window-size=1180,740",
    "--screenshot=$outPng",
    "file:///$distDir/index.html"
)

$proc = Start-Process -FilePath $edge -ArgumentList $argList -PassThru
$proc.WaitForExit(10000)

if (Test-Path $outPng) {
    $item = Get-Item $outPng
    Write-Host "SUCCESS: Screenshot rendered! Size: $($item.Length) bytes ($outPng)"
} else {
    Write-Host "Warning: screenshot file not generated directly via file URL."
}

