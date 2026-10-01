# Copyright 2026 Qwen Team
# SPDX-License-Identifier: Apache-2.0

param([Parameter(Mandatory = $true)][string]$Worker)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $worker -PathType Leaf)) {
  throw 'Windows build did not produce cua-driver-uia.exe'
}
$certificate = $null
# The workflow runs on ephemeral GitHub-hosted runners: the dry-run branch
# plants a self-signed root in LocalMachine and never removes it, and both
# branches' CurrentUser leaf is removed in the finally below. A self-hosted
# Windows runner would need the LocalMachine cleanup too.
if ($env:SIGNING_TEST_ONLY -eq 'true') {
  # Dry-run only.
  $certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=Qwen CUA Driver CI Test' -CertStoreLocation Cert:\CurrentUser\My
  $cer = Join-Path $env:RUNNER_TEMP 'qwen-cua-driver-ci-test.cer'
  Export-Certificate -Cert $certificate -FilePath $cer | Out-Null
  Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
  Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\TrustedPublisher | Out-Null
} else {
  # GitHub renders an unset secret as an empty string, so a half-configured
  # pair would silently fall through to the other identity. Fail closed the
  # way desktop-release.yml does instead of signing with a certificate
  # nobody intended.
  if (([bool]$env:WINDOWS_CERTIFICATE) -ne ([bool]$env:WINDOWS_CERTIFICATE_PASSWORD)) {
    throw 'Incomplete Windows signing configuration: WINDOWS_CERTIFICATE and WINDOWS_CERTIFICATE_PASSWORD must both be set or both be empty.'
  }
  if (([bool]$env:LEGACY_WIN_CSC_LINK) -ne ([bool]$env:LEGACY_WIN_CSC_KEY_PASSWORD)) {
    throw 'Incomplete Windows signing configuration: WIN_CSC_LINK and WIN_CSC_KEY_PASSWORD must both be set or both be empty.'
  }
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
    # Match the raw EKU extension. The Certificate provider's
    # `EnhancedKeyUsageList` holds display strings such as
    # "Code Signing (1.3.6.1.5.5.7.3.3)", and `Oid` exposes only FriendlyName
    # and Value - neither type has an `ObjectId` member to filter on.
    $certificate = $imported | Where-Object {
      $_.HasPrivateKey -and @(
        $_.Extensions |
          Where-Object { $_.Oid.Value -eq '2.5.29.37' } |
          ForEach-Object {
            [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($_, $false).EnhancedKeyUsages
          } |
          Where-Object { $_.Value -eq '1.3.6.1.5.5.7.3.3' }
      ).Count -gt 0
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
try {
  & $signtool.FullName sign /sha1 $certificate.Thumbprint /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 $worker
  if ($LASTEXITCODE -ne 0) { throw "signtool failed with exit code $LASTEXITCODE" }
  $signature = Get-AuthenticodeSignature -LiteralPath $worker
  if ($signature.Status -ne 'Valid') {
    throw "UIAccess worker signature status is $($signature.Status)"
  }
} finally {
  # Never leave the code-signing key resident in the user store past the
  # sign + verify lines: later steps in this job run registry-fetched
  # install scripts under the same user. SilentlyContinue because
  # $ErrorActionPreference = 'Stop' must not let a cleanup failure mask the
  # real error. The worker's own signature stays verifiable afterwards —
  # Authenticode embeds the signer certificate.
  if ($certificate) {
    Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($certificate.Thumbprint)" -Force -ErrorAction SilentlyContinue
  }
}
