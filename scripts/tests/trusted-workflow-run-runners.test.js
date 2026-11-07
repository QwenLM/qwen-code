/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = (name) =>
  parse(readFileSync(`.github/workflows/${name}.yml`, 'utf8'));

// Evaluated, never substring-matched: an inverted or reordered expression must
// flip a routing case instead of slipping past a pinned fragment.
const evaluateRunsOn = (
  expression,
  { repository = 'QwenLM/qwen-code', ecsDisabled } = {},
) =>
  Function(
    'github',
    'vars',
    'fromJSON',
    `return (${expression.slice(3, -2)})`,
  )(
    { repository },
    { MAINTAINER_ECS_RUNNER_DISABLED: ecsDisabled },
    JSON.parse,
  );

describe('trusted workflow_run publish lane', () => {
  const publish = () => workflow('web-shell-visuals-publish').jobs.publish;

  it('opts in to the persistent pool with a hosted fallback', () => {
    const runsOn = publish()['runs-on'];
    expect(runsOn).not.toBe('ubuntu-latest');
    expect(evaluateRunsOn(runsOn)).toEqual([
      'self-hosted',
      'linux',
      'x64',
      'ecs-qwen',
    ]);
    expect(evaluateRunsOn(runsOn, { ecsDisabled: 'true' })).toEqual([
      'ubuntu-latest',
    ]);
    expect(evaluateRunsOn(runsOn, { repository: 'someone/fork' })).toEqual([
      'ubuntu-latest',
    ]);
  });

  it('repairs a reused slot and drops its Git metadata before checkout', () => {
    const steps = publish().steps;
    expect(steps[0].name).toBe('Restore workspace ownership');
    expect(steps[0].if).toContain('self-hosted');
    expect(steps[1].name).toBe('Recreate runner Git metadata');
    expect(steps[1].run).toContain('rm -rf -- "$GITHUB_WORKSPACE/.git"');
    expect(steps[2].name).toBe('Checkout the publish scripts');
  });
});

describe('main CI failure report channel', () => {
  // The job that files the issue must never share a pool with the CI it
  // reports: when the pool is why main went red, an ECS-hosted reporter would
  // queue the report behind the very failure it documents.
  it('keeps the issue-write job on hosted runners', () => {
    expect(workflow('main-ci-failure-issue').jobs.file_issue['runs-on']).toBe(
      'ubuntu-latest',
    );
  });
});
