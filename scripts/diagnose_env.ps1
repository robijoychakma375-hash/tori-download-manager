Write-Host "=== 1. RUST TOOLCHAINS & TARGETS ==="
rustup show
rustc -vV

Write-Host "`n=== 2. LOCATING cl.exe, link.exe, rc.exe IN PATH ==="
Get-Command cl.exe, link.exe, rc.exe, rustc, cargo, node, npm -ErrorAction SilentlyContinue |
    Select-Object Name, Source | Format-Table -AutoSize

Write-Host "`n=== 3. QUERYING INSTALLED VISUAL STUDIO / SDK PACKAGES IN REGISTRY ==="
$keys = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
Get-ItemProperty $keys -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -match 'Visual Studio|Visual C\+\+|Windows Software Development Kit|Build Tools|MSVC|SDK|Windows Kits' } |
    Select-Object DisplayName, DisplayVersion, InstallLocation, Publisher |
    Format-Table -AutoSize

Write-Host "`n=== 4. WINDOWS KITS / SDK LOCATIONS ==="
Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows Kits\Installed Roots' -ErrorAction SilentlyContinue |
    Format-List

Write-Host "`n=== 5. CHECKING COMMON MSVC AND SDK DIRECTORIES ON DISK ==="
$pathsToCheck = @(
    "C:\Program Files\Microsoft Visual Studio",
    "C:\Program Files (x86)\Microsoft Visual Studio",
    "C:\Program Files (x86)\Windows Kits",
    "C:\Program Files\Windows Kits",
    "C:\BuildTools",
    "F:\BuildTools",
    "F:\Program Files",
    "C:\tools",
    "C:\ProgramData\chocolatey",
    "C:\Users\ritud\scoop",
    "C:\Users\ritud\AppData\Local\Programs"
)

foreach ($p in $pathsToCheck) {
    if (Test-Path $p) {
        Write-Host "EXISTS: $p"
        Get-ChildItem -Path $p -Depth 2 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
    }
}

