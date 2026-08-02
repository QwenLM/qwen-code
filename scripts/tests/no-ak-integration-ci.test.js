/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
const NO_AK_SCRIPT = 'test:integration:no-ak:sandbox:none';

function getWorkflowJob(workflow, jobName) {
  const marker = `  ${jobName}:`;
  const start = workflow.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);

  const afterMarker = workflow.slice(start + marker.length);
  const nextJob = afterMarker.match(/\n {2}[a-zA-Z0-9_-]+:\n/);

  return workflow.slice(
    start,
    nextJob ? start + marker.length + nextJob.index : undefined,
  );
}

describe('no-AK integration CI wiring', () => {
  it('defines a focused no-AK integration script', () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
    );

    expect(packageJson.scripts[NO_AK_SCRIPT]).toBe(
      [
        'cross-env QWEN_SANDBOX=false vitest run --root ./integration-tests --maxWorkers 2',
        './fake-openai-server.test.ts',
        './cli/daemon-invocation-context.test.ts',
        './cli/list_directory.test.ts',
        './cli/qwen-serve-routes.test.ts',
        './cli/qwen-serve-streaming.test.ts',
        './sdk-typescript/abort-and-lifecycle.test.ts',
        './sdk-typescript/permission-control.test.ts',
        './sdk-typescript/sdk-mcp-server.test.ts',
        './sdk-typescript/subagents.test.ts',
        './sdk-typescript/system-control.test.ts',
        './sdk-typescript/tool-control.test.ts',
      ].join(' '),
    );
  });

  it('runs the no-AK integration script in the required Linux gate only', () => {
    const workflow = readFileSync(
      path.join(ROOT, '.github/workflows/ci.yml'),
      'utf8',
    );
    const ubuntuJob = getWorkflowJob(workflow, 'test');
    const macosJob = getWorkflowJob(workflow, 'test_macos');
    const windowsJob = getWorkflowJob(workflow, 'test_windows');
    const permissionsIndex = workflow.indexOf('\npermissions:');
    expect(permissionsIndex).toBeGreaterThan(0);
    const workflowTriggers = workflow.slice(0, permissionsIndex);
    const gateStepMarker =
      "      - name: 'Run required no-AK integration gate'";
    const gateStepStart = ubuntuJob.indexOf(gateStepMarker);
    expect(gateStepStart).toBeGreaterThanOrEqual(0);
    const nextStepIndex = ubuntuJob.indexOf(
      '\n      - name:',
      gateStepStart + gateStepMarker.length,
    );
    expect(nextStepIndex).toBeGreaterThan(0);
    const gateStep = ubuntuJob.slice(gateStepStart, nextStepIndex);

    expect(workflow).not.toContain('  integration_no_ak:');
    expect(workflow.split(`npm run ${NO_AK_SCRIPT}`).length - 1).toBe(1);
    expect(workflowTriggers).toContain('\n  pull_request:\n');
    expect(workflowTriggers).toContain('\n  merge_group:\n');

    expect(gateStep).toContain(
      "(github.event_name == 'pull_request' || github.event_name == 'merge_group')",
    );
    expect(gateStep).toContain(`npm run ${NO_AK_SCRIPT}`);
    expect(gateStep).toContain(
      "QWEN_HOME: '${{ runner.temp }}/qwen-no-ak-home/.qwen'",
    );
    expect(gateStep).toContain('timeout-minutes: 20');
    expect(gateStep).toContain(
      "\n          HOME: '${{ runner.temp }}/qwen-no-ak-home'",
    );
    expect(gateStep).toContain(
      "\n          USERPROFILE: '${{ runner.temp }}/qwen-no-ak-home'",
    );
    for (const key of [
      'API_KEY',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_MODEL',
      'BAILIAN_CODING_PLAN_API_KEY',
      'BAILIAN_TOKEN_PLAN_API_KEY',
      'DASHSCOPE_API_KEY',
      'DEEPSEEK_API_KEY',
      'GEMINI_API_KEY',
      'GEMINI_MODEL',
      'GOOGLE_API_KEY',
      'GOOGLE_MODEL',
      'IDEALAB_API_KEY',
      'MINIMAX_API_KEY',
      'MODELSCOPE_API_KEY',
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
      'OPENAI_MODEL',
      'OPENROUTER_API_KEY',
      'QWEN_API_KEY',
      'QWEN_DEFAULT_AUTH_TYPE',
      'QWEN_MODEL',
      'REQUESTY_API_KEY',
      'XAI_API_KEY',
      'ZAI_API_KEY',
    ]) {
      expect(gateStep).toContain(`\n          ${key}: ''`);
    }
    expect(ubuntuJob).not.toContain('secrets.OPENAI_API_KEY');
    expect(ubuntuJob).not.toContain('secrets.OPENAI_BASE_URL');
    expect(ubuntuJob).not.toContain('secrets.OPENAI_MODEL');

    expect(macosJob).not.toContain(NO_AK_SCRIPT);
    expect(windowsJob).not.toContain(NO_AK_SCRIPT);
  });

  it('checks out the immutable PR head ref instead of the lagging merge ref', () => {
    const workflow = readFileSync(
      path.join(ROOT, '.github/workflows/ci.yml'),
      'utf8',
    );
    const ubuntuJob = getWorkflowJob(workflow, 'test');
    const webShellJob = getWorkflowJob(workflow, 'web_shell_e2e_smoke');
    const macosJob = getWorkflowJob(workflow, 'test_macos');
    const windowsJob = getWorkflowJob(workflow, 'test_windows');

    // On PRs every gate checks out refs/pull/N/head, which is published the
    // instant the branch is pushed, instead of the merge ref that GitHub
    // rebuilds asynchronously and can serve stale for minutes.
    for (const job of [ubuntuJob, macosJob, windowsJob]) {
      expect(job).toContain(
        "format('refs/pull/{0}/head', github.event.pull_request.number)",
      );
    }

    // The brittle merge-ref retry/refresh machinery is gone: in particular the
    // direct GitHub fetch (the self-hosted proxy times it out) and the forced
    // merge-ref checkout no longer exist.
    expect(ubuntuJob).not.toContain(
      "name: 'Fetch current PR merge ref from GitHub'",
    );
    expect(ubuntuJob).not.toContain('https://x-access-token:${GITHUB_TOKEN}');
    expect(ubuntuJob).not.toContain('git checkout --force "${merge_ref}"');
    expect(ubuntuJob).not.toContain(
      "name: 'Back off for stale merge ref to refresh'",
    );

    // The cheap sanity guard stays: fail loud if HEAD lacks the expected head
    // (PR head, or the merge-queue head once this job also runs on merge_group).
    expect(ubuntuJob).toContain(
      "name: 'Verify checkout includes expected head commit'",
    );
    expect(ubuntuJob).toContain('git merge-base --is-ancestor');
    expect(ubuntuJob).toContain('github.event.pull_request.head.sha');
    expect(webShellJob).toContain(
      "name: 'Verify checkout includes expected head commit'",
    );
    expect(webShellJob).toContain('git merge-base --is-ancestor');
    expect(webShellJob).toContain('github.event.pull_request.head.sha');
  });

  it('keeps the lightweight coverage comment job on the hosted runner', () => {
    const workflow = readFileSync(
      path.join(ROOT, '.github/workflows/ci.yml'),
      'utf8',
    );
    const coverageJob = getWorkflowJob(workflow, 'post_coverage_comment');

    expect(coverageJob).toContain("runs-on: 'ubuntu-latest'");
    expect(coverageJob).not.toContain('ubuntu_runner');
  });

  it('does not install Linux packages on self-hosted Playwright runners', () => {
    const workflow = readFileSync(
      path.join(ROOT, '.github/workflows/ci.yml'),
      'utf8',
    );
    const webShellJob = getWorkflowJob(workflow, 'web_shell_e2e_smoke');

    expect(webShellJob).toContain('ubuntu_runner');
    expect(webShellJob).toContain("run: 'npx playwright install chromium'");
    expect(webShellJob).toContain('--with-deps chromium');
  });
});
