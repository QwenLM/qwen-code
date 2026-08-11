/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getWorkflowJob, getWorkflowStep } from './workflow-helpers.js';

const releaseWorkflow = readFileSync(
  '.github/workflows/live-host-release.yml',
  'utf8',
);
const syncWorkflow = readFileSync(
  '.github/workflows/sync-live-host-to-oss.yml',
  'utf8',
);

describe('Live Host OSS mirror workflow', () => {
  it('grants the reusable mirror workflow its required token permissions', () => {
    expect(releaseWorkflow).toContain(
      "permissions:\n  actions: 'read'\n  contents: 'read'",
    );
  });

  it('runs only after a stable Live Host release or a manual re-run', () => {
    expect(syncWorkflow).not.toContain('pull_request:');
    expect(syncWorkflow).not.toContain('dry_run');

    const syncOss = getWorkflowJob(releaseWorkflow, 'sync-oss');
    expect(syncOss).toContain(
      "if: \"${{ github.event_name == 'workflow_dispatch' && inputs.dry_run == false && inputs.draft == false && inputs.prerelease == false && github.repository == 'QwenLM/qwen-code' }}\"",
    );
    expect(syncOss).toContain("- 'publish'");
    expect(syncOss).toContain("source: 'artifact'");
    expect(syncOss).not.toContain('secrets: inherit');
    expect(syncOss).toContain(
      "ALIYUN_OSS_ACCESS_KEY_ID: '${{ secrets.ALIYUN_OSS_ACCESS_KEY_ID }}'",
    );
    expect(syncOss).toContain(
      "ALIYUN_OSS_ACCESS_KEY_SECRET: '${{ secrets.ALIYUN_OSS_ACCESS_KEY_SECRET }}'",
    );
    expect(syncWorkflow).toContain(
      'ALIYUN_OSS_ACCESS_KEY_ID:\n        required: true',
    );
    expect(syncWorkflow).toContain(
      'ALIYUN_OSS_ACCESS_KEY_SECRET:\n        required: true',
    );
  });

  it('uploads and verifies one release without an OSS state machine', () => {
    const sync = getWorkflowJob(syncWorkflow, 'sync');
    expect(sync).toContain("name: 'production-release'");
    expect(sync).not.toContain('check-live-host-oss-state');
    expect(sync).not.toContain('allow-hidden-missing');

    const versionUpload = getWorkflowStep(
      sync,
      'Upload versioned assets to Aliyun OSS',
    );
    expect(versionUpload).toContain('--prefix "live-host/v${VERSION}"');

    const latestUpload = getWorkflowStep(
      sync,
      'Publish latest manifest to Aliyun OSS',
    );
    expect(latestUpload).toContain("--prefix 'live-host/latest'");
    expect(latestUpload).toContain('Qwen-Live-Host-manifest.json');
    expect(latestUpload).not.toContain('Qwen-Live-Host-arm64.zip');
  });

  it('serializes latest updates and checks the GitHub stable feed', () => {
    expect(syncWorkflow).toContain("group: 'sync-live-host-to-oss'");
    expect(syncWorkflow).not.toContain(
      "group: 'sync-live-host-to-oss-${{ inputs.version }}'",
    );

    const latestCheck = getWorkflowStep(
      getWorkflowJob(syncWorkflow, 'sync'),
      'Confirm latest manifest matches GitHub stable feed',
    );
    expect(latestCheck).toContain("gh release download 'live-host-latest'");
    expect(latestCheck).toContain(
      'cmp dist/live-host/Qwen-Live-Host-manifest.json',
    );
  });

  it('smoke-tests the installed ossutil binary', () => {
    const install = getWorkflowStep(
      getWorkflowJob(syncWorkflow, 'sync'),
      'Install ossutil',
    );
    expect(install).toContain('"$HOME/.local/bin/ossutil" >/dev/null');
  });
});
