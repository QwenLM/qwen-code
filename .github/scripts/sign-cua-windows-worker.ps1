# Copyright 2026 Qwen Team
# SPDX-License-Identifier: Apache-2.0

param([Parameter(Mandatory = $true)][string]$Worker)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $worker -PathType Leaf)) {
  throw 'Windows build did not produce cua-driver-uia.exe'
}
$certificate = $null
if ($env:SIGNING_TEST_ONLY -eq 'true') {
  $certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=Qwen CUA Driver CI Test' -CertStoreLocation Cert:\CurrentUser\My
  $cer = Join-Path $env:RUNNER_TEMP 'qwen-cua-driver-ci-test.cer'
  Export-Certificate -Cert $certificate -FilePath $cer | Out-Null
  Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
  Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\TrustedPublisher | Out-Null
} else {
  if ($env:WINDOWS_CERTIFICATE -and $env:WINDOWS_CERTIFICATE_PASSWORD) {
    $pfx = $env:WINDOWS_CERTIFICATE
    $pfxPassword = $env:WINDOWS_CERTIFICATE_PASSWORD
  } elseif ($env:LEGACY_WIN_CSC_LINK -and $env:LEGACY_WIN_CSC_KEY_PASSWORD) {
    $pfx = $env:LEGACY_WIN_CSC_LINK
    $pfxPassword = $env:LEGACY_WIN_CSC_KEY_PASSWORD
  } else {
    throw 'A trusted Windows code-signing certificate is required for a CUA release. Configure WINDOWS_CERTIFICATE and WINDOWS_CERTIFICATE_PASSWORD.'
  }
  $path = Join-Path $env:RUNNER_TEMP 'qwen-cua-driver.pfx'
  try {
    [IO.File]::WriteAllBytes($path, [Convert]::FromBase64String($pfx))
    $password = ConvertTo-SecureString $pfxPassword -AsPlainText -Force
    $imported = @(Import-PfxCertificate -FilePath $path -CertStoreLocation Cert:\CurrentUser\My -Password $password)
    $certificate = $imported | Where-Object {
      $_.HasPrivateKey -and $_.EnhancedKeyUsageList.ObjectId -contains '1.3.6.1.5.5.7.3.3'
    } | Select-Object -First 1
    if (-not $certificate) { throw 'The Windows PFX must contain a code-signing certificate with a private key.' }
  } finally {
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  }
}
$signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Filter signtool.exe -Recurse |
  Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
  Sort-Object FullName -Descending | Select-Object -First 1
if (-not $signtool) { throw 'signtool.exe was not found' }
& $signtool.FullName sign /sha1 $certificate.Thumbprint /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 $worker
if ($LASTEXITCODE -ne 0) { throw "signtool failed with exit code $LASTEXITCODE" }
$signature = Get-AuthenticodeSignature -LiteralPath $worker
if ($signature.Status -ne 'Valid') {
  throw "UIAccess worker signature status is $($signature.Status)"
}
