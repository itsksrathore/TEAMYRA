param(
  [switch]$Clean
)
$ErrorActionPreference='Stop'
$Root=Split-Path -Parent $PSScriptRoot
Set-Location $Root
$Python=Join-Path $Root '.venv-build\Scripts\python.exe'
if(-not (Test-Path $Python)){ $Python=(Get-Command python).Source }
if($Clean){
  Remove-Item (Join-Path $Root 'build\teamyra-core') -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $Root 'dist\teamyra-core') -Recurse -Force -ErrorAction SilentlyContinue
}
& $Python -m PyInstaller --noconfirm teamyra-core.spec
if($LASTEXITCODE){ exit $LASTEXITCODE }
$Exe=Join-Path $Root 'dist\teamyra-core\teamyra-core.exe'
if(-not (Test-Path $Exe)){ throw "teamyra-core.exe was not created" }
& $Exe --help | Out-Null
if($LASTEXITCODE){ throw "teamyra-core.exe smoke check failed" }
Write-Output $Exe
