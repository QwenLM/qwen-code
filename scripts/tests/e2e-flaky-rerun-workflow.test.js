/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('e2e flaky rerun workflow', () => {
  const workflow = readFileSync(
    '.github/workflows/e2e-flaky-rerun.yml',
    'utf8',
  );
  const yml = parse(workflow);
  const job = yml.jobs['rerun-failed-lanes'];

  it('watches completed E2E Tests runs on main only', () => {
    expect(workflow).toContain('workflow_run:');
    expect(yml.on.workflow_run.workflows).toEqual(['E2E Tests']);
    expect(yml.on.workflow_run.types).toEqual(['completed']);
    expect(yml.on.workflow_run.branches).toEqual(['main']);
  });

  it('retries only first-attempt failed push runs, exactly once', () => {
    // The attempt-2 completion event carries run_attempt == 2: without that
    // guard the re-run could re-trigger itself forever, and with it a failure
    // that survives both attempts reaches the issue bot untouched. Scheduled
    // and dispatched runs exist to surface flakiness, not to gate main, so
    // push is the only event that earns a retry. Pin the whole clause so a
    // connective mutation fails here.
    expect(job.if).toContain("github.repository == 'QwenLM/qwen-code'");
    expect(job.if).toContain(
      "github.event.workflow_run.conclusion == 'failure'",
    );
    expect(job.if).toContain("github.event.workflow_run.event == 'push'");
    expect(job.if).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(job.if).toContain('github.event.workflow_run.run_attempt == 1');
  });

  it('re-runs only the failed jobs with the bot PAT, not repository code', () => {
    // The job holding the PAT must stay a pure Actions-API call: no checkout,
    // no repository code. `--failed` keeps the green lanes' results so the
    // re-run covers exactly the lanes that flaked.
    expect(workflow).not.toContain('actions/checkout');
    expect(workflow).toContain("GH_TOKEN: '${{ secrets.CI_BOT_PAT }}'");
    expect(workflow).toContain(
      'gh run rerun --failed "${RUN_ID}" --repo "${REPO}"',
    );
    expect(workflow).toContain("RUN_ID: '${{ github.event.workflow_run.id }}'");
  });
});
