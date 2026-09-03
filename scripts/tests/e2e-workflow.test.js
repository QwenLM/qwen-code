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
        'exec 7>"${HOME}/.cache/qwen-code-ci/docker-sandbox-build.lock"',
      );
      expect(runStep.run).toContain('flock --wait 1800 7');
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

    it('never waits on a lock another run holds through its tests', () => {
      // Run 33637097713 lost two Docker shards to the #10605 protocol on one
      // host: shard 1/3 held the per-commit coordinator lock and polled 30
      // minutes for an exclusive daemon lock that a shard of run 33638984513
      // kept shared through its whole test phase, then shard 2/3 timed out
      // behind the coordinator lock shard 1/3 was still holding. Image
      // preparation may only ever wait on locks bounded by a build.
      const sharedIndex = runStep.run.indexOf('flock --shared --wait 1800 9');
      const buildLockIndex = runStep.run.indexOf('flock --wait 1800 7');
      const releaseIndex = runStep.run.indexOf('flock --unlock 7');
      const testIndex = runStep.run.indexOf('vitest run');
      expect(sharedIndex).toBeGreaterThanOrEqual(0);
      expect(buildLockIndex).toBeGreaterThan(sharedIndex);
      expect(releaseIndex).toBeGreaterThan(buildLockIndex);
      expect(testIndex).toBeGreaterThan(releaseIndex);
      expect(runStep.run).not.toContain('acquire_daemon_write_lock');
      expect(runStep.run).not.toContain('flock --unlock 9');
      expect(runStep.run).not.toContain('flock --nonblock 9');
      expect(
        yml.jobs['e2e-test-linux'].strategy['max-parallel'],
      ).toBeUndefined();
    });

    it('closes the lock descriptors in every child process', () => {
      // A flock lives on the open file description, so a descendant that
      // inherits the descriptor and outlives its job keeps holding the lock
      // on the host. This shell keeps its own copy of the descriptor, so
      // closing it in children costs nothing.
      expect(runStep.run).toContain('-i "$sandbox_image" 7>&- 8>&- 9>&-');
      expect(runStep.run).toContain("--shard='${{ matrix.shard }}' 9>&-");
      expect(runStep.run).toContain('exec 7>&-');
      expect(runStep.run).toContain('exec 8>&-');
      const cleanupStep = steps.find(
        (step) => step.name === 'Prune dangling docker images',
      );
      expect(cleanupStep.run).toContain("--filter 'until=24h' 9>&-");
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
      // An `if:` here would skip the record on one leg, where the gate's
      // ${E2E_JOB_START_EPOCH:-0} fallback then always takes the ::error::
      // branch and the retry never fires on the leg it exists for.
      expect(epochStep.if).toBeUndefined();
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

    it('pins the job timeout the budget-gate arithmetic is built on', () => {
      // The 2100s threshold is 3600s minus a 25-minute reserve; the 3600s
      // comes from this timeout. Editing one without the other mis-budgets
      // the retry in both directions with every other witness green.
      expect(yml.jobs['e2e-test-linux']['timeout-minutes']).toBe(60);
    });

    it('keeps the run step red when the shard stays red', () => {
      // continue-on-error sits above the script exit code that every other
      // witness observes: with it, two failing attempts still report green.
      // Pin both levels — a job-level key computes the job conclusion green
      // whatever the run step exits. The sandbox-image build step's
      // deliberate step-level key and isolated-nightly's deliberate job-level
      // key stay untouched — this pins the run step and e2e-test-linux only.
      expect(runStep['continue-on-error']).toBeUndefined();
      expect(yml.jobs['e2e-test-linux']['continue-on-error']).toBeUndefined();
    });

    it('keeps the default step shell the execution harness assumes', () => {
      // e2e-shard-retry.test.js executes this step's script under `bash -e`,
      // GitHub's default Linux step shell only while the step carries no
      // `shell:` override and neither the workflow nor the job a `defaults:`
      // block. Any of those switches the lane's shell semantics — explicit
      // `bash` expands to `bash --noprofile --norc -e -o pipefail {0}` —
      // while the harness keeps executing the old shell, so every execution
      // witness stays green for a contract the lane no longer runs. Absence
      // only: this pins e2e.yml, not workflows that deliberately set a shell.
      expect(runStep.shell).toBeUndefined();
      expect(yml.defaults).toBeUndefined();
      expect(yml.jobs['e2e-test-linux'].defaults).toBeUndefined();
    });

    it('does not retry the docker leg', () => {
      // Two ~30min docker attempts would outrun the job's timeout-minutes.
      expect(runStep.run.match(/QWEN_SANDBOX=docker vitest run/g)).toHaveLength(
        1,
      );
      // Structure, not just count: wrapping the docker command in a
      // function and calling it twice keeps the literal count at one. The
      // docker leg defines its own helper functions, so match by brace
      // depth rather than any earlier definition: every `${...}` brace in
      // the script is balanced, leaving the command at depth zero unless
      // something wraps it.
      const commandIndex = runStep.run.indexOf(
        'QWEN_SANDBOX=docker vitest run',
      );
      let depth = 0;
      for (const ch of runStep.run.slice(0, commandIndex)) {
        if (ch === '{') depth += 1;
        if (ch === '}') depth -= 1;
      }
      expect(depth).toBe(0);
    });
  });

  describe('one build for every leg', () => {
    // Each leg used to build and bundle on its own runner — 4–8 minutes on a
    // hosted VM, 10–17 on a busy pool host, eleven times per run. The `build`
    // job does it once on a hosted VM and the legs unpack its archive; these
    // pins keep a leg from quietly growing its own build back.
    const build = yml.jobs.build;
    const legs = [
      'e2e-test-linux',
      'e2e-test-macos',
      'e2e-interactive-opentui',
      'isolated-nightly',
    ];

    it('builds once, on a hosted runner, off the shared pool', () => {
      expect(build.needs).toBeUndefined();
      expect(build['runs-on']).toBe('ubuntu-latest');
      const names = build.steps.map((step) => step.name);
      expect(names).toContain('Build project');
      expect(names).toContain('Bundle CLI for E2E tests');
      const pack = build.steps.find(
        (step) => step.name === 'Pack build outputs',
      );
      expect(pack.run).toContain('.github/scripts/e2e-build-pack.sh');
      // The same "the install must not build" premise as on the legs: without
      // it npm ci runs prepare (a full build and bundle) and the explicit
      // build steps below then do it a second time on the critical path.
      const install = build.steps.find(
        (step) => step.name === 'Install dependencies',
      );
      expect(install.env.QWEN_SKIP_PREPARE).toBe('1');
      const upload = build.steps.find(
        (step) => step.name === 'Upload build artifact',
      );
      expect(upload.uses).toMatch(/^actions\/upload-artifact@/);
      expect(upload.with.name).toBe('e2e-build');
      expect(upload.with['retention-days']).toBe(1);
    });

    it('gates the build like the legs, so a skipped build skips them', () => {
      // The three fork-gated legs carry the build's exact gate; the nightly
      // legs are narrower (schedule/dispatch only), which is a subset.
      for (const job of [
        'e2e-test-linux',
        'e2e-test-macos',
        'e2e-interactive-opentui',
      ]) {
        expect(yml.jobs[job].if, job).toBe(build.if);
      }
      expect(build.if).toContain(
        'github.event.pull_request.head.repo.full_name == github.repository',
      );
    });

    it.each(legs)('%s unpacks the shared build instead of building', (job) => {
      const { needs, steps } = yml.jobs[job];
      expect(needs).toEqual(['build']);
      const names = steps.map((step) => step.name);
      expect(names).not.toContain('Build project');
      expect(names).not.toContain('Bundle CLI for E2E tests');
      const download = steps.find(
        (step) => step.name === 'Download build artifact',
      );
      expect(download.with.name).toBe('e2e-build');
      const unpack = steps.find(
        (step) => step.name === 'Unpack build artifact',
      );
      expect(unpack.run).toContain('.github/scripts/e2e-build-unpack.sh');
      // Unpack before anything runs the CLI, after node_modules exist.
      expect(names.indexOf('Install dependencies')).toBeLessThan(
        names.indexOf('Unpack build artifact'),
      );
      expect(names.indexOf('Unpack build artifact')).toBeLessThan(
        names.findIndex((name) => name.startsWith('Run ')),
      );
      const install = steps.find(
        (step) => step.name === 'Install dependencies',
      );
      expect(install.env.QWEN_SKIP_PREPARE).toBe('1');
    });

    it('keeps the docker sandbox image build on the leg', () => {
      // The image builds inside Docker from the checkout, so it is not part
      // of the archive; the leg still prepares it under the host locks.
      const runStep = yml.jobs['e2e-test-linux'].steps.find(
        (step) => step.name === 'Run E2E tests',
      );
      expect(runStep.run).toContain('npm run build:sandbox');
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
