/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('e2e workflow', () => {
  const workflow = readFileSync('.github/workflows/e2e.yml', 'utf8');
  const yml = parse(workflow);

  it('never cancels in-progress runs on main', () => {
    // A full run takes ~40min while merges land every ~18min, so cancelling on
    // every merge starved the suite — over 100 push runs, 67 were cancelled and
    // only 25 ever reported. Runs on main must finish; dev branches still cancel
    // superseded runs. A future simplification back to `event_name == 'push'`
    // would silently reintroduce the starvation, so the guard is asserted.
    const cancel = yml.concurrency['cancel-in-progress'];
    expect(cancel).toContain(
      "github.event_name == 'push' && github.ref_name != 'main'",
    );
  });

  it('scopes the concurrency group by event and ref', () => {
    // Scoping by event keeps main pushes coalescing with each other without
    // touching the nightly schedule or a manual dispatch on the same ref.
    const group = yml.concurrency.group;
    expect(group).toContain('github.workflow');
    expect(group).toContain('github.event_name');
    expect(group).toContain('github.head_ref || github.ref_name');
  });

  describe('sandbox image build retry', () => {
    // Run 33139344576 (issue #10355) died at 'Build the sandbox image' on one
    // pool runner while the identical build passed on two sibling runners of
    // the same run, and the re-run passed on another runner. The bounded retry
    // keeps one transient environment failure from exiting the shard red.
    const steps = yml.jobs['e2e-test-linux'].steps;
    const buildStep = steps.find(
      (step) => step.name === 'Build the sandbox image',
    );
    const retryStep = steps.find(
      (step) => step.name === 'Build the sandbox image (retry)',
    );

    it('keeps a failed first attempt from pre-failing the job', () => {
      // Without continue-on-error a successful retry would leave the shard red
      // (GitHub computes the job conclusion from every step conclusion).
      expect(buildStep['continue-on-error']).toBe(true);
    });

    it('pins the first build step id the retry gate references', () => {
      // steps.build-sandbox.outcome only resolves when this exact id exists;
      // renaming the step would silently disable the retry.
      expect(buildStep.id).toBe('build-sandbox');
    });

    it('gates the retry on the first attempt outcome only', () => {
      expect(retryStep.if).toContain(
        "steps.build-sandbox.outcome == 'failure'",
      );
      // failure() would be false once continue-on-error absorbs the first
      // attempt, silently skipping the retry.
      expect(retryStep.if).not.toContain('failure()');
    });

    it('lets a failed retry fail the job', () => {
      // continue-on-error on the retry would absorb a genuine build failure
      // and hand the test step a sandbox image that was never built.
      expect(retryStep['continue-on-error']).toBeUndefined();
    });

    it('rebuilds with the same script and the same skip flag', () => {
      expect(buildStep.run).toContain('npm run build:sandbox -- -s');
      expect(retryStep.run).toContain('npm run build:sandbox -- -s');
    });

    it('keeps the docker leg env on the retry', () => {
      // Without QWEN_SANDBOX, build_sandbox.js cannot resolve the container
      // command on Linux; without VERBOSE the retry's build log goes to
      // /dev/null and a second failure is undiagnosable.
      expect(retryStep.env.QWEN_SANDBOX).toBe('docker');
      expect(retryStep.env.VERBOSE).toBe('true');
    });
  });

  it('routes Linux E2E scratch files away from /tmp', () => {
    const runStep = yml.jobs['e2e-test-linux'].steps.find(
      (step) => step.name === 'Run E2E tests',
    );
    expect(runStep.run).toContain('mktemp -d /var/tmp/qwen-ci-XXXXXX');
    expect(runStep.run).toContain('trap \'rm -rf "$TMPDIR"');
  });

  describe('job timeout lane contract', () => {
    // Run 33345905817 (issue #10591) expired at the old flat 60-minute
    // ceiling on a contended shared ECS host before its log reported any
    // test result. The extended ceiling is
    // scoped to the pool routing — the same condition `runs-on` uses:
    // hosted fallbacks (forks and MAINTAINER_ECS_RUNNER_DISABLED=true)
    // keep the pre-contention bound, so a genuine hang there does not
    // burn the extra 30 minutes. Evaluate the real timeout expression for
    // both routings instead of pinning a bare number — the same
    // substitute-then-evaluate technique ci-platform-lanes.test.js uses —
    // so a regression to an unconditional ceiling fails here instead of
    // reading as a passing constant.
    const timeoutMinutesOn = ({ repository, ecsDisabled }) => {
      const expr = String(yml.jobs['e2e-test-linux']['timeout-minutes'])
        .replace(/^\$\{\{\s*/, '')
        .replace(/\s*\}\}$/, '')
        .replace(/github\.repository/g, JSON.stringify(repository))
        .replace(
          /vars\.MAINTAINER_ECS_RUNNER_DISABLED/g,
          JSON.stringify(ecsDisabled),
        )
        .replace(/fromJSON\(/g, '(');
      if (/github\.|vars\.|needs\.|steps\.|fromJSON\(/.test(expr)) {
        throw new Error(
          `e2e-test-linux timeout carries a term this guard does not model: ${expr}`,
        );
      }
      return Number(new Function(`return (${expr});`)());
    };

    it('keeps a contended ECS shard above the install/build/test budget', () => {
      expect(
        timeoutMinutesOn({ repository: 'QwenLM/qwen-code', ecsDisabled: '' }),
      ).toBe(90);
    });

    it('keeps the hosted fallback on the pre-contention ceiling', () => {
      expect(
        timeoutMinutesOn({
          repository: 'some-fork/qwen-code',
          ecsDisabled: '',
        }),
      ).toBe(60);
      expect(
        timeoutMinutesOn({
          repository: 'QwenLM/qwen-code',
          ecsDisabled: 'true',
        }),
      ).toBe(60);
    });
  });
});
