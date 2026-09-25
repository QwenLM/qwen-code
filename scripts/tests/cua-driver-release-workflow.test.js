/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/cd-cua-driver.yml', 'utf8');
const packageVerifier = readFileSync(
  'packages/cua-driver/scripts/verify-cua-sdk-package.mjs',
  'utf8',
);
const shellInstaller = readFileSync(
  'packages/cua-driver/scripts/_install-rust.sh',
  'utf8',
);
const powershellInstaller = readFileSync(
  'packages/cua-driver/scripts/install.ps1',
  'utf8',
);

describe('CUA SDK release workflow', () => {
  it('fails closed when a driver production dispatch disables notarization', () => {
    expect(workflow).toContain(
      '"${{ inputs.dry_run }}" != "true" && "${{ inputs.node_repl_only }}" != "true" && "${{ inputs.notarize }}" != "true"',
    );
  });

  it('requires Gatekeeper to accept the notarized app', () => {
    expect(workflow).toContain(
      'spctl -a -vv -t exec release/QwenCuaDriver.app',
    );
    expect(workflow).not.toMatch(/spctl[^\n]+\|\| true/u);
  });

  it('retries transient Debian mirror failures', () => {
    expect(workflow.match(/apt-get -o Acquire::Retries=3/g)).toHaveLength(2);
  });

  it('smokes the high-level ComputerUse runtime from a clean package', () => {
    expect(packageVerifier).toContain('await ComputerUse.create(');
    expect(packageVerifier).toContain(
      'await computer.supportsObservationRevision()',
    );
    expect(workflow).toContain('await ComputerUse.create(');
    expect(workflow).toContain('await computer.close()');
  });

  it('keeps installer version assignments machine-rewritable', () => {
    expect(shellInstaller).toMatch(/^CUA_DRIVER_RS_BAKED_VERSION="[^"\n]+"$/mu);
    expect(powershellInstaller).toMatch(
      /^\$Script:CuaDriverRsBakedVersion = "[^"\n]+"$/mu,
    );
  });

  it('keeps historical Windows UIAccess assets installable', () => {
    expect(powershellInstaller).toContain(
      '$SignedUiaRequiredFrom = [version]"0.20.3"',
    );
    expect(powershellInstaller).toContain(
      '$LegacyUiaRequiredFrom = [version]"0.2.8"',
    );
    expect(powershellInstaller).toMatch(
      /\$requiresSignedUia = \[version\]\$version -ge \$SignedUiaRequiredFrom/,
    );
    expect(powershellInstaller).toMatch(
      /elseif \(\$requiresLegacyUia\) \{[\s\S]*?cua-driver-uia\.exe/,
    );
    expect(powershellInstaller).toContain(
      "@('qwen-cua-driver-uia.exe', 'cua-driver-uia.exe')",
    );
    expect(powershellInstaller).toMatch(
      /if \(\$requiresSignedUia\) \{[\s\S]*?release archive is missing required qwen-cua-driver-uia\.exe[\s\S]*?Get-AuthenticodeSignature/,
    );
  });
});
