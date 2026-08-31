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
  const buildSandboxScript = readFileSync('scripts/build_sandbox.js', 'utf8');
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

  describe('sandbox image preparation', () => {
    const steps = yml.jobs['e2e-test-linux'].steps;
    const setupStep = steps.find((step) => step.name === 'Set up Docker');
    const runStep = steps.find((step) => step.name === 'Run E2E tests');

    it('does not create one Buildx builder per self-hosted shard', () => {
      expect(setupStep.if).toContain("runner.environment == 'github-hosted'");
    });

    it('serializes image preparation on the shared Docker host', () => {
      expect(runStep.run).toContain(
        'docker-sandbox-build-e2e-${GITHUB_SHA}.lock',
      );
      expect(runStep.run).toContain('flock --wait 1800 8');
      expect(runStep.run).toContain(
        'exec 9>"${HOME}/.cache/qwen-code-ci/docker-sandbox-daemon.lock"',
      );
      expect(runStep.run).toContain('flock --shared --wait 1800 9');
      expect(runStep.run).toContain(
        'if [ "$RUNNER_ENVIRONMENT" = \'self-hosted\' ]',
      );
    });

    it('reuses a commit-qualified image', () => {
      expect(runStep.env.BUILD_SANDBOX_FLAGS).toContain(
        'org.qwen-code.ci.sandbox=true',
      );
      expect(runStep.run).toContain('sandboxImageUri")-e2e-${GITHUB_SHA}"');
      expect(runStep.run).toContain('docker image inspect "$sandbox_image"');
    });

    it('pins each shard to the prepared image ID', () => {
      expect(runStep.run).toContain("docker image inspect --format '{{.Id}}'");
      expect(runStep.run).toContain(
        'export QWEN_SANDBOX_IMAGE="$sandbox_image_id"',
      );
    });

    it('keeps one bounded retry without pruning the shared daemon', () => {
      expect(runStep.run.match(/build_image/g)).toHaveLength(3);
      expect(runStep.run).toContain(
        'npm run build:sandbox -- -s --no-prune -i "$sandbox_image"',
      );
      expect(buildSandboxScript).toContain(".option('prune'");
      expect(buildSandboxScript).toContain('if (argv.prune)');
    });

    it('keeps the Docker build environment', () => {
      expect(runStep.env.QWEN_SANDBOX).toContain("'docker'");
      expect(runStep.env.VERBOSE).toBe('true');
    });

    it('keeps the shared lock continuously through concurrent tests', () => {
      const imageIdIndex = runStep.run.indexOf('sandbox_image_id=');
      const downgradeIndex = runStep.run.indexOf('flock --shared 9');
      const testIndex = runStep.run.indexOf('vitest run');
      expect(imageIdIndex).toBeGreaterThanOrEqual(0);
      expect(downgradeIndex).toBeGreaterThan(imageIdIndex);
      expect(testIndex).toBeGreaterThan(downgradeIndex);
      expect(runStep.run).toContain('until flock --nonblock 9');
      expect(
        yml.jobs['e2e-test-linux'].strategy['max-parallel'],
      ).toBeUndefined();
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
