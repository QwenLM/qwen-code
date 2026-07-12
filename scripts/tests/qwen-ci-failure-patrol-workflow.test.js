/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflowPath = '.github/workflows/qwen-ci-failure-patrol.yml';

describe('qwen ci failure patrol workflow', () => {
  it('runs every ten minutes and supports dry-run manual dispatch', () => {
    const workflow = readFileSync(workflowPath, 'utf8');

    expect(workflow).toContain("cron: '*/10 * * * *'");
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('dry_run:');
    expect(workflow).not.toContain('pr_number:');
    expect(workflow).not.toContain('run_id:');
    expect(workflow).toContain("group: 'qwen-ci-failure-patrol'");
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain(
      'if: "${{ github.repository == \'QwenLM/qwen-code\' }}"',
    );
  });

  it('keeps write credentials out of the classifier step', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const classifierStep =
      workflow.match(
        /- name: 'Classify CI failure'[\s\S]*?(?=\n[ ]{6}- name: 'Act on classification')/,
      )?.[0] ?? '';
    const actStep =
      workflow.match(
        /- name: 'Act on classification'[\s\S]*?(?=\n[ ]{6}- name: 'Upload patrol artifacts')/,
      )?.[0] ?? '';

    expect(workflow).toContain("actions: 'write'");
    expect(workflow).toContain("pull-requests: 'write'");
    expect(workflow).toContain("issues: 'write'");
    expect(workflow).toContain("contents: 'read'");
    expect(workflow).toContain("GH_TOKEN: '${{ secrets.CI_DEV_BOT_PAT }}'");
    expect(workflow).toContain('verify-bot');
    expect(classifierStep).toContain(
      "OPENAI_API_KEY: '${{ secrets.AUTOFIX_OPENAI_API_KEY }}'",
    );
    expect(classifierStep).toContain(
      "OPENAI_MODEL: '${{ vars.QWEN_PR_REVIEW_MODEL }}'",
    );
    expect(classifierStep).toContain('--mode classify-ci-failure');
    expect(classifierStep).not.toContain('CI_DEV_BOT_PAT');
    expect(classifierStep).not.toContain('GH_TOKEN');
    expect(workflow).not.toContain('qwen --version');
    expect(workflow).not.toContain('npm run bundle');
    expect(actStep).toContain("GH_TOKEN: '${{ secrets.CI_DEV_BOT_PAT }}'");
    expect(actStep).toContain('act');
  });

  it('scans PRs before main and preserves dry-run artifacts', () => {
    const workflow = readFileSync(workflowPath, 'utf8');

    expect(workflow.indexOf('scan-pr')).toBeLessThan(
      workflow.indexOf('scan-main'),
    );
    expect(workflow).toContain("STALE_MINUTES: '30'");
    expect(workflow).toContain("MAX_ATTEMPTS: '3'");
    expect(workflow).toContain('--main-sha "${{ github.sha }}"');
    expect(workflow).toContain(
      "ALLOWLISTED_MAIN_WORKFLOWS: 'E2E Tests,SDK Python'",
    );
    expect(workflow).toContain('actions/upload-artifact');
    expect(workflow).toContain('ci-failure.json');
    expect(workflow).toContain('ci-decision.json');
    expect(workflow).toContain(
      'if: "${{ always() && (failure() || inputs.dry_run == \'true\') }}"',
    );
    expect(workflow).not.toContain('raw-log');
  });
});
