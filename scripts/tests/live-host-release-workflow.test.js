/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const releaseWorkflow = readFileSync(
  '.github/workflows/live-host-release.yml',
  'utf8',
);
const syncWorkflow = readFileSync(
  '.github/workflows/sync-live-host-to-oss.yml',
  'utf8',
);

describe('Live Host release workflows', () => {
  it('runs the immutable-prefix check before mutating GitHub releases', () => {
    const preflight = releaseWorkflow.indexOf(
      "- name: 'Check immutable OSS prefix before publishing'",
    );
    const publish = releaseWorkflow.indexOf("- name: 'Create GitHub release'");
    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(publish).toBeGreaterThan(preflight);
  });

  it('serializes latest updates and never inherits unrelated secrets', () => {
    expect(syncWorkflow).toContain("group: 'sync-live-host-to-oss'");
    expect(syncWorkflow).not.toContain(
      "group: 'sync-live-host-to-oss-${{ inputs.version }}'",
    );
    expect(releaseWorkflow).not.toContain("secrets: 'inherit'");
    expect(syncWorkflow).toContain(
      'if: "${{ steps.latest.outputs.update == \'true\' }}"',
    );
  });

  it('exercises the read-only OSS state check during PR dry runs', () => {
    expect(releaseWorkflow).toContain(
      "- '.github/workflows/sync-live-host-to-oss.yml'",
    );
    const dryRun = syncWorkflow.slice(
      syncWorkflow.indexOf('  dry-run:'),
      syncWorkflow.indexOf('  sync:'),
    );
    expect(dryRun).toContain(
      "- name: 'Check immutable version prefix without writing'",
    );
    expect(dryRun).toContain(
      'node scripts/check-live-host-oss-state.js prefix',
    );
    expect(syncWorkflow).toContain(
      'cp release-assets/Qwen-Live-Host-manifest.json',
    );
  });
});
