/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/cd-cua-driver.yml', 'utf8');

describe('CUA SDK release workflow', () => {
  it('fails closed when a production dispatch disables notarization', () => {
    expect(workflow).toContain(
      '"${{ inputs.dry_run }}" != "true" && "${{ inputs.notarize }}" != "true"',
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
});
