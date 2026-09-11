param(
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Continue'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$OutDir = Join-Path $ProjectRoot 'data\live'
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$Rows = [System.Collections.Generic.List[object]]::new()
$BundledPython = 'C:\Users\Я\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$Python = if (Test-Path -LiteralPath $BundledPython) { $BundledPython } else { 'python' }

function Get-PublicJson {
  param([string]$Name, [string]$Url, [string]$Referer)
  $Target = Join-Path $OutDir ($Name + '.json')
  $Next = Join-Path $OutDir ($Name + '.next.json')
  $Started = [DateTimeOffset]::Now
  $Args = @(
    '--silent', '--show-error', '--location', '--compressed', '--max-time', '75',
    '--user-agent', 'Mozilla/5.0 Chrome/140 Safari/537.36',
    '--header', 'Accept: application/json', '--output', $Next,
    '--write-out', '%{http_code}'
  )
  if ($Referer) { $Args += @('--referer', $Referer) }
  $Args += $Url
  $Status = & curl.exe @Args
  $Exit = $LASTEXITCODE
  $Valid = $false
  $ErrorText = $null
  if ($Exit -eq 0 -and $Status -eq '200' -and (Test-Path -LiteralPath $Next)) {
    try {
      Get-Content -LiteralPath $Next -Raw -Encoding utf8 | ConvertFrom-Json | Out-Null
      Move-Item -LiteralPath $Next -Destination $Target -Force
      $Valid = $true
    } catch {
      $ErrorText = $_.Exception.Message
      Remove-Item -LiteralPath $Next -Force -ErrorAction SilentlyContinue
    }
  } else {
    $ErrorText = "curl_exit=$Exit http=$Status"
    Remove-Item -LiteralPath $Next -Force -ErrorAction SilentlyContinue
  }
  $Bytes = if (Test-Path -LiteralPath $Target) { (Get-Item -LiteralPath $Target).Length } else { 0 }
  $Rows.Add([pscustomobject]@{
    name = $Name
    ok = $Valid
    http_status = $Status
    bytes = $Bytes
    captured_at = $Started.ToString('o')
    elapsed_ms = [math]::Round(([DateTimeOffset]::Now - $Started).TotalMilliseconds)
    error = $ErrorText
  })
  $State = if ($Valid) { 'OK' } else { 'FAILED' }
  Write-Host "$State $Name HTTP=$Status bytes=$Bytes"
}

$BboxWSEN = '29.50,59.60,31.10,60.35'
$BboxSWNE = '59.60,29.50,60.35,31.10'
Get-PublicJson 'sber-full-aoi' "https://sberazs.ru/api/stations?bbox=$BboxWSEN" 'https://sberazs.ru/'
Get-PublicJson 'gdebenz-full-aoi' 'https://gdebenz.ru/api/stations?lat1=59.60&lon1=29.50&lat2=60.35&lon2=31.10' 'https://gdebenz.ru/'
Get-PublicJson 'benzas-full-aoi' 'https://benzas.ru/api/stations?lat1=59.60&lon1=29.50&lat2=60.35&lon2=31.10' 'https://benzas.ru/'
Get-PublicJson 'benzas-comments-full-aoi' 'https://benzas.ru/api/comments?lat1=59.60&lon1=29.50&lat2=60.35&lon2=31.10' 'https://benzas.ru/'
Get-PublicJson 'benzinest-full-aoi' "https://benzinest.ru/api/stations?bbox=$BboxSWNE" 'https://benzinest.ru/'
Get-PublicJson 'tutbenz-full-aoi' "https://tutbenz.app/api/stations?bbox=$BboxWSEN&prices=1" 'https://tutbenz.app/'
Get-PublicJson 'gdebenzin-full-aoi' "https://xn--90addebmh2bc.xn--p1ai/api/v1/map?bbox=$BboxSWNE&zoom=10&price=1&confidence=1" 'https://xn--90addebmh2bc.xn--p1ai/'
Get-PublicJson 'benzonavt-full-aoi' "https://benzonavt.ru/api/v1/stations?bbox=$BboxSWNE" 'https://benzonavt.ru/'
Get-PublicJson 'toplivo-data' 'https://tboo.ru/gpn/data.json' 'https://tboo.ru/gpn/'
Get-PublicJson 'toplivo-predict' 'https://tboo.ru/gpn/predict.json' 'https://tboo.ru/gpn/'

$GpnStarted = [DateTimeOffset]::Now
$GpnTarget = Join-Path $OutDir 'gpn-official.json'
& $Python (Join-Path $PSScriptRoot 'collect_gpn.py') --output $GpnTarget
$GpnExit = $LASTEXITCODE
$GpnValid = $GpnExit -eq 0 -and (Test-Path -LiteralPath $GpnTarget)
$Rows.Add([pscustomobject]@{
  name = 'gpn-official'
  ok = $GpnValid
  http_status = if ($GpnValid) { '200' } else { 'partial_or_failed' }
  bytes = if (Test-Path -LiteralPath $GpnTarget) { (Get-Item -LiteralPath $GpnTarget).Length } else { 0 }
  captured_at = $GpnStarted.ToString('o')
  elapsed_ms = [math]::Round(([DateTimeOffset]::Now - $GpnStarted).TotalMilliseconds)
  error = if ($GpnValid) { $null } else { "collector_exit=$GpnExit" }
})
$GpnState = if ($GpnValid) { 'OK' } else { 'FAILED' }
Write-Host "$GpnState gpn-official"

$Rows | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $OutDir 'full-aoi-probe-results.json') -Encoding utf8
$SuccessCount = @($Rows | Where-Object ok).Count
Write-Host "Completed: $SuccessCount/$($Rows.Count) endpoints"

if (-not $SkipBuild -and $SuccessCount -gt 0) {
  & $Python (Join-Path $PSScriptRoot 'build_snapshot.py') --raw-dir $OutDir
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & $Python (Join-Path $PSScriptRoot 'update_history.py')
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if ($SuccessCount -eq 0) { exit 2 }
