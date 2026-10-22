# Copyright 2026 Qwen Team
# SPDX-License-Identifier: Apache-2.0

param(
  [Parameter(Mandatory = $true)][string]$Worker,
  [Parameter(Mandatory = $true)][string]$SignedWorker
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $SignedWorker -PathType Leaf)) {
  throw 'SignPath did not return the signed UIAccess worker'
}

Copy-Item -LiteralPath $SignedWorker -Destination $Worker -Force
$signature = Get-AuthenticodeSignature -LiteralPath $Worker
if (-not $signature.SignerCertificate) {
  throw 'The SignPath output does not contain an Authenticode signer certificate'
}

if ($env:SIGNPATH_TEST_SIGNING -eq 'true') {
  $expectedThumbprint = '0B27B4BA9D646BCDB1FD59B4F229C0DAA7E8EEF0'
  if ($signature.SignerCertificate.Thumbprint -ne $expectedThumbprint) {
    throw 'SignPath returned an unexpected test certificate'
  }
  $certificatePath = Join-Path $env:RUNNER_TEMP 'signpath-test-certificate.cer'
  Export-Certificate -Cert $signature.SignerCertificate -FilePath $certificatePath | Out-Null
  Import-Certificate -FilePath $certificatePath -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
  Import-Certificate -FilePath $certificatePath -CertStoreLocation Cert:\LocalMachine\TrustedPublisher | Out-Null
  $signature = Get-AuthenticodeSignature -LiteralPath $Worker
}

if ($signature.Status -ne 'Valid') {
  throw "UIAccess worker signature status is $($signature.Status)"
}
