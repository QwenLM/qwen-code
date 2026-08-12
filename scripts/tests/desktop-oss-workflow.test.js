/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getWorkflowJob, getWorkflowStep } from './workflow-helpers.js';

const releaseWorkflow = readFileSync(
  '.github/workflows/desktop-release.yml',
  'utf8',
);
const syncWorkflow = readFileSync(
  '.github/workflows/sync-desktop-to-oss.yml',
  'utf8',
);

describe('Desktop OSS mirror workflow', () => {
  it('mirrors only published stable Desktop releases', () => {
    expect(syncWorkflow).not.toContain('pull_request:');
    const syncOss = getWorkflowJob(releaseWorkflow, 'sync-oss');
    expect(syncOss).toContain(
      "if: \"${{ github.event_name == 'workflow_dispatch' && inputs.dry_run == false && inputs.draft == false && inputs.prerelease == false && github.repository == 'QwenLM/qwen-code' }}\"",
    );
    expect(syncOss).toContain("- 'publish'");
    expect(syncOss).toContain("source: 'artifact'");
    expect(syncOss).not.toContain('secrets: inherit');
  });

  it('passes only the OSS credentials into the reusable workflow', () => {
    expect(releaseWorkflow).toContain(
      "permissions:\n  actions: 'read'\n  contents: 'read'",
    );
    for (const secret of [
      'ALIYUN_OSS_ACCESS_KEY_ID',
      'ALIYUN_OSS_ACCESS_KEY_SECRET',
    ]) {
      expect(syncWorkflow).toContain(`${secret}:\n        required: true`);
      expect(getWorkflowJob(releaseWorkflow, 'sync-oss')).toContain(
        `${secret}: '\${{ secrets.${secret} }}'`,
      );
    }
  });

  it('publishes verified versioned assets before advancing the OSS feed', () => {
    const sync = getWorkflowJob(syncWorkflow, 'sync');
    const prepare = getWorkflowStep(sync, 'Verify and prepare mirror assets');
    expect(prepare).toContain(
      '--base-url "${ALIYUN_OSS_PUBLIC_BASE_URL}/desktop/v${VERSION}"',
    );
    expect(prepare).toContain('sha256sum -- * > SHA256SUMS.txt');

    const upload = getWorkflowStep(
      sync,
      'Upload versioned assets to Aliyun OSS',
    );
    expect(upload).toContain('--prefix "desktop/v${VERSION}"');

    const latest = getWorkflowStep(
      sync,
      'Publish latest manifest to Aliyun OSS',
    );
    expect(latest).toContain("--prefix 'desktop/latest'");
    expect(latest).toContain('dist/desktop/desktop-latest.json');
    expect(latest).not.toContain('.dmg');
    expect(
      sync.indexOf("name: 'Verify versioned assets on Aliyun OSS'"),
    ).toBeLessThan(
      sync.indexOf("name: 'Publish latest manifest to Aliyun OSS'"),
    );
  });

  it('checks the GitHub stable version before changing the OSS feed', () => {
    const check = getWorkflowStep(
      getWorkflowJob(syncWorkflow, 'sync'),
      'Confirm latest manifest matches GitHub stable feed',
    );
    expect(check).toContain("gh release download 'desktop-latest'");
    expect(check).toContain('test "$actual" = "$expected"');
  });
});
