$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$bundledPython = 'C:\Users\Я\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$python = if (Test-Path -LiteralPath $bundledPython) { $bundledPython } else { 'python' }

Set-Location -LiteralPath $projectRoot
Write-Host 'SPB Fuel Intelligence запускается на http://127.0.0.1:8765' -ForegroundColor Green
Write-Host 'Остановить сервер: Ctrl+C' -ForegroundColor DarkGray
Start-Process 'http://127.0.0.1:8765'
& $python -m src.server --port 8765
