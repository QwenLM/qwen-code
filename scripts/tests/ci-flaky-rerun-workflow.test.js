/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  '.github/workflows/qwen-ci-flaky-rerun.yml',
  'utf8',
);
const skill = readFileSync('.qwen/skills/ci-flaky-patrol/SKILL.md', 'utf8');

describe('ci flaky rerun workflow', () => {
  it('runs every ten minutes and limits write permissions to a separate action job', () => {
    expect(workflow).toContain("cron: '*/10 * * * *'");
    expect(workflow).toContain("ACTIVE_DAYS: '7'");
    expect(workflow).toContain("MAX_CANDIDATES_PER_RUN: '5'");
    expect(workflow).toContain('classify:');
    expect(workflow).toContain('act:');
    expect(workflow).toContain("actions: 'read'");
    expect(workflow).toContain("pull-requests: 'read'");
    expect(workflow).toContain("pull-requests: 'write'");
    expect(workflow).toContain("actions: 'write'");
    expect(workflow).toContain("GH_TOKEN: '${{ secrets.CI_BOT_PAT }}'");
    expect(workflow).not.toContain("issues: 'write'");
    expect(workflow).not.toContain('scan-main');
    expect(workflow).not.toContain('update-branch');
    expect(workflow).toContain('persist-credentials: false');
  });

  it('delegates PR failure judgment to the project skill', () => {
    expect(workflow).toContain('.qwen/skills/ci-flaky-patrol/SKILL.md');
    expect(workflow).toContain('ci-flaky-input.json');
    expect(workflow).toContain('ci-flaky-decisions.json');
    expect(workflow).toContain(
      "OPENAI_API_KEY: '${{ secrets.OPENAI_API_KEY }}'",
    );
    expect(workflow).toContain('"sandbox": true');
    expect(workflow).toContain('input_sha');
    expect(workflow).toContain('node .github/scripts/ci-flaky-rerun.mjs act');
    expect(workflow).toContain('node .github/scripts/ci-flaky-rerun.mjs reset');
    expect(workflow).toContain('actions/upload-artifact@');
    expect(workflow).toContain('actions/download-artifact@');
    expect(workflow).toContain("GITHUB_TOKEN: ''");
    expect(workflow).toContain('settings: |-');
    expect(workflow).toContain('--max-candidates "${MAX_CANDIDATES_PER_RUN}"');
    expect(workflow).not.toContain('settings_json');
  });

  it('keeps the skill responsible for judgment and JS responsible for GitHub writes', () => {
    expect(skill).toContain('Workflow contract');
    expect(skill).toContain('JavaScript driver owns');
    expect(skill).toContain('This skill chooses');
    expect(skill).toContain('every candidate');
    expect(skill).toContain('bounded batch');
    expect(skill).toContain('ci-flaky-input.json');
    expect(skill).toContain('ci-flaky-decisions.json');
    expect(skill).toContain('`rerun`');
    expect(skill).toContain('`update_branch`');
    expect(skill).toContain('`comment`');
    expect(skill).toContain('`failureKey`');
    expect(skill).toContain('main-branch failures');
    expect(skill).toContain('Never rerun jobs, comment, update branches');
  });
});
