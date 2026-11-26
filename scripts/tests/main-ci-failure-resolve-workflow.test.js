/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '../..');
const workflow = readFileSync(
  join(root, '.github/workflows/main-ci-failure-resolve.yml'),
  'utf8',
);
const yml = parse(workflow);
const reporter = parse(
  readFileSync(
    join(root, '.github/workflows/main-ci-failure-issue.yml'),
    'utf8',
  ),
);
const job = yml.jobs.resolve;
const script = job.steps.find(
  (step) => step.name === 'Close the issues this green run covers',
).run;

describe('main CI failure resolver', () => {
  it('watches the same workflows as the reporter', () => {
    // The reporter files by workflow; a resolver that misses one leaves that
    // family open forever, and a resolver that watches an unfiled workflow
    // would close issues nobody created.
    expect([...yml.on.workflow_run.workflows].sort()).toEqual(
      [...reporter.on.workflow_run.workflows].sort(),
    );
    expect(Object.keys(yml.on.workflow_run).sort()).toEqual([
      'types',
      'workflows',
    ]);
    expect(yml.on.workflow_run.types).toEqual(['completed']);
  });

  it('runs only for a green main-side run', () => {
    // Pin the whole expression: an appended arm could admit pull-request
    // runs, which say nothing about main.
    expect(job.if).toBe(
      "${{ github.repository == 'QwenLM/qwen-code' && " +
        "github.event.workflow_run.conclusion == 'success' && " +
        "github.event.workflow_run.head_branch == 'main' && " +
        "(github.event.workflow_run.event == 'push' || " +
        "(github.event.workflow_run.event == 'schedule' && " +
        'contains(fromJSON(\'["E2E Tests","Qwen Code CI","SDK Java","Desktop Checks","tui-parity","Managed Agent loop verification"]\'), github.event.workflow.name))) }}',
    );
    expect(yml.permissions).toEqual({ contents: 'read', issues: 'write' });
  });

  it('closes only issues this run proves are resolved', () => {
    // Age guard: an issue a newer failing run just touched is not covered by
    // this green run.
    expect(script).toContain('.updatedAt < $run_started');
    // Per-signature issues are not closed by a green run that skipped the leg
    // they name, so every failing job in the body must be a successful job of
    // this run.
    expect(script).toContain('grep -Fxq -- "${job_name}" "${green_jobs}"');
    expect(script).toContain('--reason completed');
    // Closing the whole family on a run with no successful jobs would retire
    // issues a skipped lane never disproved.
    expect(script).toContain('recorded no successful jobs; closing nothing');
    // The reporter owns the PAT fallback; the resolver only needs to read its
    // own run and write issues, so it must not add a second copy of that
    // secret path.
    expect(script).not.toContain('CI_DEV_BOT_PAT');
  });

  it('matches the reporter’s title families', () => {
    expect(script).toContain('(.title == $family)');
    expect(script).toContain('startswith($family + " — ")');
    expect(script).toContain('startswith($family + " on ")');
  });
});
