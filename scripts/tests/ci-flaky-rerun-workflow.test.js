/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = readFileSync(
  '.github/workflows/qwen-ci-flaky-rerun.yml',
  'utf8',
);
const skill = readFileSync('.qwen/skills/ci-flaky-patrol/SKILL.md', 'utf8');
const workflowYaml = parse(workflow);

describe('ci flaky rerun workflow', () => {
  it('runs every ten minutes and limits write permissions to a separate action job', () => {
    expect(workflow).toContain("cron: '*/10 * * * *'");
    expect(workflow).toContain("ACTIVE_DAYS: '7'");
    expect(workflow).toContain("MAX_CANDIDATES_PER_RUN: '5'");
    expect(workflow).toContain('classify:');
    expect(workflow).toContain('act:');
    expect(workflow).toContain('timeout-minutes: 5');
    expect(workflow).toContain('timeout-minutes: 10');
    expect(workflow).toContain("actions: 'read'");
    expect(workflow).toContain("pull-requests: 'read'");
    expect(workflow).toContain("pull-requests: 'write'");
    expect(workflow).toContain("actions: 'write'");
    expect(workflow).toContain("GH_TOKEN: '${{ secrets.CI_BOT_PAT }}'");
    expect(workflow).not.toContain("issues: 'write'");
    expect(workflow).not.toContain('scan-main');
    expect(workflow).not.toContain('update-branch');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('set -o pipefail');
    expect(workflow).toContain("grep -E '^(target_found|target_count)='");
    expect(workflow).toContain(
      "if: \"${{ always() && github.repository == 'QwenLM/qwen-code' && needs.identity.result == 'success' }}\"",
    );
    expect(workflow).toContain(
      'act always runs so reset can clean stale markers',
    );
  });

  it('checks out one captured trusted main commit in classify and act', () => {
    expect(workflow).toContain('trusted_sha:');
    expect(workflow).toContain('trusted_sha="$(gh api');
    expect(workflow).toContain(
      "ref: '${{ needs.identity.outputs.trusted_sha }}'",
    );
  });

  it('keeps PAT and write permissions out of the classifier job', () => {
    expect(workflowYaml.jobs.classify.permissions).toEqual({
      actions: 'read',
      contents: 'read',
      'pull-requests': 'read',
    });
    expect(workflowYaml.jobs.act.permissions).toEqual({
      actions: 'write',
      contents: 'read',
      'pull-requests': 'write',
    });
    expect(JSON.stringify(workflowYaml.jobs.classify)).not.toContain(
      'CI_BOT_PAT',
    );
    expect(JSON.stringify(workflowYaml.jobs.act)).toContain('CI_BOT_PAT');
    expect(JSON.stringify(workflowYaml.jobs.identity)).toContain('CI_BOT_PAT');
  });

  it('resolves the patrol identity from CI_BOT_PAT rather than a hardcoded login', () => {
    expect(workflow).toContain('identity:');
    expect(workflow).toContain('gh api user --jq .login');
    expect(workflow).toContain(
      "bot_login: '${{ steps.identity.outputs.bot_login }}'",
    );
    expect(workflow).toContain(
      '--trusted-marker-login "${{ needs.identity.outputs.bot_login }}"',
    );
    expect(workflow).not.toContain('qwen-code-ci-bot');
    expect(workflow).not.toContain('github-actions[bot]');
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
    expect(workflow).toContain('decisions_sha');
    expect(workflow).toContain(
      'sha256sum "${WORKDIR}/ci-flaky-decisions.json"',
    );
    expect(workflow).toContain('node .github/scripts/ci-flaky-rerun.mjs act');
    expect(workflow).toContain('node .github/scripts/ci-flaky-rerun.mjs reset');
    expect(workflow).toContain('actions/upload-artifact@');
    expect(workflow).toContain('actions/download-artifact@');
    expect(workflow).toContain("GITHUB_TOKEN: ''");
    expect(workflow).toContain('settings: |-');
    expect(workflow).toContain('"core": [');
    expect(workflow).toContain('"read_file"');
    expect(workflow).toContain('"write_file"');
    expect(workflow).not.toContain('"shell"');
    expect(workflow).not.toContain('"web"');
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
