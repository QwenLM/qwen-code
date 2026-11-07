# Copyright 2026 Qwen Team
# SPDX-License-Identifier: Apache-2.0

# Test-signs the UIAccess worker through the SignPath REST API so a dry run can
# exercise the signed install path. The test certificate is trusted only on the
# disposable hosted runner; release builds do not run this script.

param(
  [Parameter(Mandatory = $true)][string]$Worker
)

$ErrorActionPreference = 'Stop'
if (-not $env:SIGNPATH_API_TOKEN) {
  throw 'SIGNPATH_API_TOKEN is not configured'
}

$api = 'https://app.signpath.io/Api/v1/e2bc00ea-6f24-4cde-9cfc-f0b19b2b6ece'
$headers = @{ Authorization = "Bearer $env:SIGNPATH_API_TOKEN" }
$submitted = Invoke-WebRequest -Method Post -Uri "$api/SigningRequests/SubmitWithArtifact" -Headers $headers -Form @{
  projectSlug               = 'qwen-code'
  signingPolicySlug         = 'test-signing'
  artifactConfigurationSlug = 'initial'
  description               = "$env:GITHUB_REPOSITORY@$env:GITHUB_SHA run $env:GITHUB_RUN_ID"
  artifact                  = Get-Item -LiteralPath $Worker
}
$request = $submitted.Headers['Location'] | Select-Object -First 1
if (-not $request) {
  throw 'SignPath did not return a signing request location'
}
Write-Host "SignPath signing request: $request"

$deadline = (Get-Date).AddMinutes(30)
do {
  Start-Sleep -Seconds 10
  $status = Invoke-RestMethod -Uri $request -Headers $headers -MaximumRetryCount 5 -RetryIntervalSec 10
  Write-Host "SignPath status: $($status.status) ($($status.workflowStatus))"
} until ($status.isFinalStatus -or (Get-Date) -gt $deadline)
if ($status.status -ne 'Completed') {
  throw "SignPath signing request ended with $($status.status) ($($status.workflowStatus))"
}

$signed = Join-Path $env:RUNNER_TEMP "signed-$(Split-Path -Leaf $Worker)"
Invoke-WebRequest -Uri "$request/SignedArtifact" -Headers $headers -OutFile $signed -MaximumRetryCount 5 -RetryIntervalSec 10
$signature = Get-AuthenticodeSignature -LiteralPath $signed
if ($signature.SignerCertificate.Thumbprint -ne '0B27B4BA9D646BCDB1FD59B4F229C0DAA7E8EEF0') {
  throw 'SignPath returned an unexpected signer certificate'
}

$certificatePath = Join-Path $env:RUNNER_TEMP 'signpath-test-certificate.cer'
Export-Certificate -Cert $signature.SignerCertificate -FilePath $certificatePath | Out-Null
Import-Certificate -FilePath $certificatePath -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
Import-Certificate -FilePath $certificatePath -CertStoreLocation Cert:\LocalMachine\TrustedPublisher | Out-Null
$signature = Get-AuthenticodeSignature -LiteralPath $signed
if ($signature.Status -ne 'Valid') {
  throw "UIAccess worker signature status is $($signature.Status)"
}
Copy-Item -LiteralPath $signed -Destination $Worker -Force
