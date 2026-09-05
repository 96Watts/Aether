[CmdletBinding()]
param(
  [ValidatePattern('^[^/\\]+/[^/\\]+$')]
  [string] $Repository = '96Watts/Aether'
)

$ErrorActionPreference = 'Stop'
$apiHeaders = @{ 'User-Agent' = 'Aether-installer'; 'Accept' = 'application/vnd.github+json' }
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository/releases/latest" -Headers $apiHeaders
$installer = $release.assets | Where-Object { $_.name -match '_x64-setup\.exe$' } | Select-Object -First 1
$checksums = $release.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' } | Select-Object -First 1
if (-not $installer -or -not $checksums) { throw 'The latest Aether release does not contain the expected signed installer assets.' }

$directory = Join-Path ([System.IO.Path]::GetTempPath()) ('aether-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $directory | Out-Null
$installerPath = Join-Path $directory $installer.name
$checksumsPath = Join-Path $directory 'SHA256SUMS.txt'
Invoke-WebRequest -Uri $installer.browser_download_url -OutFile $installerPath -Headers $apiHeaders
Invoke-WebRequest -Uri $checksums.browser_download_url -OutFile $checksumsPath -Headers $apiHeaders
$expected = ((Get-Content $checksumsPath | Where-Object { $_ -match [regex]::Escape($installer.name) }) -split '\s+')[0]
$actual = (Get-FileHash $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
if (-not $expected -or $actual -ne $expected.ToLowerInvariant()) { throw 'Installer checksum verification failed.' }
Start-Process -FilePath $installerPath -Wait
Remove-Item -LiteralPath $directory -Recurse -Force