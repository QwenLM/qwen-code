# One-click local Qwen Desktop setup. Run from the extracted artifact folder.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Model = 'dolphin3:8b'
function Find-Ollama {
  $cmd = Get-Command ollama.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidate = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
  if (Test-Path $candidate) { return $candidate }
  return $null
}
try {
  Write-Host '=== Qwen Desktop local setup ===' -ForegroundColor Cyan
  $ollama = Find-Ollama
  if (-not $ollama) {
    Write-Host 'Installing Ollama through Windows Package Manager...'
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
      throw 'Windows Package Manager (winget) is missing. Install Ollama from https://ollama.com/download/windows and run this script again.'
    }
    & winget.exe install --id Ollama.Ollama --exact --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { throw "Ollama installation failed (exit $LASTEXITCODE)." }
    $ollama = Find-Ollama
    if (-not $ollama) { throw 'Ollama was installed but its executable could not be located. Restart Windows and run setup again.' }
  }
  Write-Host 'Checking local Ollama service...'
  try { Invoke-RestMethod 'http://127.0.0.1:11434/api/tags' -TimeoutSec 3 | Out-Null }
  catch {
    Start-Process -FilePath $ollama -ArgumentList 'serve' -WindowStyle Hidden
    $ready = $false
    for ($i=0; $i -lt 30; $i++) {
      Start-Sleep -Seconds 1
      try { Invoke-RestMethod 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2 | Out-Null; $ready=$true; break } catch {}
    }
    if (-not $ready) { throw 'Ollama did not start. Check whether port 11434 is already in use.' }
  }
  Write-Host "Downloading/checking $Model (first download may take a while)..."
  & $ollama pull $Model
  if ($LASTEXITCODE -ne 0) { throw "Model download failed (exit $LASTEXITCODE)." }
  $tags = Invoke-RestMethod 'http://127.0.0.1:11434/api/tags' -TimeoutSec 10
  if (-not @($tags.models | Where-Object { $_.name -eq $Model -or $_.model -eq $Model }).Count) {
    throw "Model $Model was not found after download."
  }
  $installer = Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.exe' -File |
    Where-Object { $_.Name -match '(?i)qwen' } | Select-Object -First 1
  if (-not $installer) { throw 'Qwen desktop installer not found beside setup script. Extract the entire artifact ZIP first.' }
  Write-Host 'Local model ready. Opening official Qwen Desktop installer...' -ForegroundColor Green
  $installed = Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait -PassThru
  if ($installed.ExitCode -ne 0) { throw "Qwen Desktop installer failed (exit $($installed.ExitCode))." }
  Write-Host 'Setup complete. Qwen Code Desktop is installed.' -ForegroundColor Green
  $shortcut = Get-ChildItem (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs') -Filter '*Qwen*.lnk' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($shortcut) { Start-Process -FilePath $shortcut.FullName }
  Write-Host 'In provider settings, select OpenAI-compatible Chat Completions if the saved provider is still Alibaba.'
  Write-Host 'Base URL: http://127.0.0.1:11434/v1 | Model: dolphin3:8b | API key: ollama'
} catch {
  Write-Host ("Setup failed: " + $_.Exception.Message) -ForegroundColor Red
  exit 1
}
