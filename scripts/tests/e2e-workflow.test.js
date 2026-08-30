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

  describe('sandbox:none shard retry', () => {
    // Runs 33293739505, 33302550436 and 33317457036 each failed the
    // sandbox:none leg at the 'Run E2E tests' step with zero vitest FAIL
    // lines — an all-green shard exiting red under shared-host pressure,
    // with sibling shards of the same runs green and the shard green on
    // re-run. The bounded retry absorbs one such transient death; a
    // deterministic test failure fails both attempts and keeps the job red.
    const steps = yml.jobs['e2e-test-linux'].steps;
    const runStep = steps.find((step) => step.name === 'Run E2E tests');
    const epochStep = steps.find(
      (step) => step.name === 'Record job start epoch',
    );

    it('records the job start epoch before the expensive setup steps', () => {
      // The retry gate budgets against the whole 60-minute job; an epoch
      // recorded at the test step would hide ~30 minutes of setup spend.
      expect(epochStep.run).toContain(
        'echo "E2E_JOB_START_EPOCH=$(date +%s)" >> "${GITHUB_ENV}"',
      );
      expect(steps.indexOf(epochStep)).toBeLessThan(
        steps.indexOf(
          steps.find((step) => step.name === 'Install dependencies'),
        ),
      );
    });

    it('wraps the sandbox:none shard command in a retryable function', () => {
      expect(runStep.run).toContain('run_shard() {');
    });

    it('retries the full shard command, shard and excludes included', () => {
      // Everything after `--` is forwarded to vitest by the npm script, so
      // shard and exclude coverage lives only in this argument list. The
      // excludes are shared verbatim with the docker leg above.
      expect(runStep.run).toContain(
        "npm run test:integration:sandbox:none -- --exclude '**/interactive/cron-interactive.test.ts' --exclude '**/channel-plugin.test.ts' --shard='${{ matrix.shard }}'",
      );
    });

    it('retries the sandbox:none shard exactly once', () => {
      expect(runStep.run).toContain('run_shard || {');
      // Definition + first attempt + one retry: the second attempt's exit
      // status is the step's, and a third attempt would burn pool time for
      // nothing.
      expect(runStep.run.match(/run_shard/g)).toHaveLength(3);
      // End-anchored scope: the retry is the group's last command and the
      // group is the script's last statement. A retry moved outside the
      // `|| { ... }` would run unconditionally, re-running green shards too.
      expect(runStep.run).toMatch(/run_shard\s*\n\s*\}\s*\n\s*fi\s*$/);
    });

    it('gates the retry on the remaining job budget', () => {
      // The retried run_shard is reachable only behind an elapsed-time check
      // that exits the step when the job cannot fit another shard. Shape
      // only — bash itself witnesses the execution semantics in
      // e2e-shard-retry.test.js.
      const group = runStep.run.slice(runStep.run.indexOf('run_shard || {'));
      expect(group).toMatch(/elapsed[\s\S]*exit 1[\s\S]*run_shard\s*\n\s*\}/);
    });

    it('keeps the run step red when the shard stays red', () => {
      // continue-on-error sits above the script exit code that every other
      // witness observes: with it, two failing attempts still report green.
      // The sandbox-image build step's deliberate continue-on-error stays
      // untouched — this pins the run step only.
      expect(runStep['continue-on-error']).toBeUndefined();
    });

    it('does not retry the docker leg', () => {
      // Two ~30min docker attempts would outrun the job's timeout-minutes.
      expect(runStep.run.match(/QWEN_SANDBOX=docker vitest run/g)).toHaveLength(
        1,
      );
      // Structure, not just count: wrapping the docker command in a
      // function and calling it twice keeps the literal count at one.
      expect(runStep.run).not.toMatch(
        /[A-Za-z_]+\(\)\s*\{[^}]*QWEN_SANDBOX=docker/s,
      );
    });
  });

  it('routes Linux E2E scratch files away from /tmp', () => {
    const runStep = yml.jobs['e2e-test-linux'].steps.find(
      (step) => step.name === 'Run E2E tests',
    );
    expect(runStep.run).toContain('mktemp -d /var/tmp/qwen-ci-XXXXXX');
    expect(runStep.run).toContain('trap \'rm -rf "$TMPDIR"');
  });
});
