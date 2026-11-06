import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = readFileSync(
  '.github/workflows/qwen-ci-flaky-rerun.yml',
  'utf8',
);
const yml = parse(workflow);
const skill = readFileSync('.qwen/skills/ci-flaky-patrol/SKILL.md', 'utf8');

describe('ci failure patrol workflow', () => {
  it('runs every ten minutes with serialized configurable batches', () => {
    expect(yml.on.schedule[0].cron).toBe('*/10 * * * *');
    expect(yml.concurrency).toEqual({
      group: 'qwen-ci-flaky-rerun',
      'cancel-in-progress': false,
    });
    expect(yml.env.ACTIVE_DAYS).toBe('7');
    expect(yml.env.MAX_CANDIDATES_PER_RUN).toBe('5');
    expect(workflow).toContain('--active-days "${ACTIVE_DAYS}"');
    expect(workflow).toContain('--max-candidates "${MAX_CANDIDATES_PER_RUN}"');
  });

  it('bounds the classifier step below the job so a slow model cannot kill the patrol', () => {
    // Observed: across a busy 9-hour window EVERY scheduled patrol spent ~9m40s
    // in the classifier and was killed by the 10-minute job timeout, so
    // Validate and Upload never ran, `act` was skipped, and nothing was ever
    // re-run - 28 of 30 runs cancelled. The two that passed took ~2 minutes,
    // at 00:0x, when the model was idle.
    const classify = yml.jobs.classify;
    const step = classify.steps.find(
      (s) => s.name === 'Classify with ci-flaky-patrol skill',
    );
    expect(step).toBeTruthy();
    expect(step['timeout-minutes']).toBeLessThan(classify['timeout-minutes']);
    // A slow model must cost one cycle, not the whole job.
    expect(step['continue-on-error']).toBe(true);

    // An empty classifier result is a no-op cycle, not a patrol failure.
    const validate = classify.steps.find(
      (s) => s.name === 'Validate patrol decisions',
    );
    expect(validate.id).toBe('decisions');
    expect(validate.run).not.toContain('test -s');
    // A timeout kill can leave a non-empty but unparseable file; the validate
    // step must reject it so the act job never receives corrupt JSON.
    expect(validate.run).toContain('JSON.parse');

    // Downstream work is gated on decisions EXISTING, not merely on the job
    // having survived - otherwise a no-decision cycle looks actionable.
    expect(classify.outputs.has_decisions).toBe(
      '${{ steps.decisions.outputs.has_decisions }}',
    );
    const upload = classify.steps.find(
      (s) => s.name === 'Upload patrol input and decisions',
    );
    expect(upload.if).toContain(
      "steps.decisions.outputs.has_decisions == 'true'",
    );
    expect(yml.jobs.act.if).toContain(
      "needs.classify.outputs.has_decisions == 'true'",
    );
  });

  it('reports an empty or corrupt classifier result instead of failing the patrol', () => {
    const validate = yml.jobs.classify.steps.find(
      (s) => s.name === 'Validate patrol decisions',
    );
    const run = (content) => {
      const dir = mkdtempSync(join(tmpdir(), 'patrol-'));
      const out = join(dir, 'gh_output');
      writeFileSync(out, '');
      if (content !== null) {
        writeFileSync(join(dir, 'ci-flaky-decisions.json'), content);
      }
      let status = 0;
      try {
        execFileSync('bash', ['-c', `set -eo pipefail\n${validate.run}`], {
          env: { ...process.env, WORKDIR: dir, GITHUB_OUTPUT: out },
          encoding: 'utf8',
        });
      } catch (e) {
        status = e.status;
      }
      const result = readFileSync(out, 'utf8');
      rmSync(dir, { recursive: true, force: true });
      return { status, result };
    };
    // Decisions present -> act downstream.
    expect(run('{"decisions":[]}')).toMatchObject({ status: 0 });
    expect(run('{"decisions":[]}').result).toContain('has_decisions=true');
    // Classifier timed out and wrote nothing -> still exit 0, just no work.
    expect(run(null)).toMatchObject({ status: 0 });
    expect(run(null).result).toContain('has_decisions=false');
    // Classifier killed mid-write -> partial JSON is not actionable.
    const partial = run('{"decisions": [{"pr": 123, "action": "rer');
    expect(partial).toMatchObject({ status: 0 });
    expect(partial.result).toContain('has_decisions=false');
  });

  it('keeps classifier credentials isolated and PAT writes explicit', () => {
    const classifier = yml.jobs.classify.steps.find((step) =>
      step.uses?.includes('qwen-code-action'),
    );
    // The classifier reads untrusted CI logs, so it gets no GitHub credential.
    // Non-secret sandbox plumbing shares this env block now that the job runs
    // on the shared ECS pool; the key set stays an exact pin so nothing that
    // could authenticate can be added without updating this allowlist.
    expect(Object.keys(classifier.env).sort()).toEqual([
      'DOCKER_CONTEXT',
      'DOCKER_HOST',
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'QWEN_HOME',
      'QWEN_SANDBOX_IMAGE',
    ]);
    expect(classifier.env.GH_TOKEN).toBe('');
    expect(classifier.env.GITHUB_TOKEN).toBe('');
    expect(JSON.stringify(classifier)).not.toContain('CI_BOT_PAT');
    expect(yml.jobs.act.permissions).toEqual({
      actions: 'read',
      contents: 'read',
      'pull-requests': 'read',
    });
    expect(JSON.stringify(yml.jobs.act)).toContain('CI_BOT_PAT');
  });

  it('passes `settings:` pinning the sandbox and the two-tool allowlist', () => {
    // Unknown `with:` keys (like the old `settings_json`) are dropped by the
    // action without error, which would silently strip the patrol agent's
    // sandbox and two-tool allowlist.
    const classifier = yml.jobs.classify.steps.find((step) =>
      step.uses?.includes('qwen-code-action'),
    );
    expect(typeof classifier.with.settings).toBe('string');
    expect(classifier.with.settings_json).toBeUndefined();
    const settings = JSON.parse(classifier.with.settings);
    for (const key of ['coreTools', 'maxSessionTurns', 'sandbox']) {
      expect(settings[key]).toBeUndefined();
    }
    expect(settings.tools?.sandbox).toBe(true);
    expect(settings.tools?.core).toEqual(['read_file', 'write_file']);
  });

  it('passes a decision batch through a trusted act job and always resets', () => {
    expect(yml.jobs.classify.outputs).toHaveProperty('bot_login');
    expect(workflow).toContain('ci-flaky-decisions.json');
    expect(workflow).toContain('--input-sha');
    expect(workflow).toContain('--trusted-marker-login');
    const reset = yml.jobs.act.steps.find(
      (step) => step.name === 'Reset successful failure state',
    );
    expect(reset.if).toContain('always()');
    expect(reset['continue-on-error']).toBe(true);
    expect(reset.env.GH_TOKEN).toContain('CI_BOT_PAT');
  });

  it('runs scan and act with the same trusted event commit', () => {
    for (const job of [yml.jobs.classify, yml.jobs.act]) {
      const checkout = job.steps.find((step) =>
        step.uses?.includes('actions/checkout'),
      );
      expect(checkout.with.ref).toBe('${{ github.sha }}');
      expect(checkout.with['persist-credentials']).toBe(false);
    }
  });

  it('keeps judgment in the skill and GitHub writes in the driver', () => {
    for (const action of ['rerun', 'comment', 'no_action']) {
      expect(skill).toContain(action);
    }
    expect(skill).toContain('maximum of 3 actions');
    expect(skill).toContain('main-branch failures');
    expect(skill).toContain('changedFiles');
    expect(skill).toContain('ci-flaky-decisions.json');
  });

  it('routes both jobs to the ECS pool, keeping the kill switch and hosted fallback', () => {
    // Observed 2026-11-06 on ubuntu-latest: one round waited 2h09m for a
    // runner, and 17 of 20 recent ticks were cancelled with zero jobs — they
    // never received one. The ECS pool had 199 idle hosts at the same time.
    for (const job of [yml.jobs.classify, yml.jobs.act]) {
      const runsOn = job['runs-on'];
      expect(runsOn).toContain("vars.MAINTAINER_ECS_RUNNER_DISABLED != 'true'");
      expect(runsOn).toContain('"ecs-qwen"');
      expect(runsOn).toContain('"ubuntu-latest"');
    }
  });

  it('enforces the pool allowlist before any step is handed a secret', () => {
    for (const job of [yml.jobs.classify, yml.jobs.act]) {
      const guard = job.steps[0];
      expect(guard.name).toBe('Check runner environment');
      expect(guard.run).toContain('ecs-qwen-*');
      expect(guard.run).toContain('refusing to run here');
      // The guard itself must not need a credential to run.
      expect(JSON.stringify(guard)).not.toContain('secrets.');
    }
    // classify additionally preflights docker: without a daemon the sandboxed
    // classifier would otherwise burn its whole 5-minute budget before failing.
    expect(yml.jobs.classify.steps[0].run).toContain('docker info');
    // act never starts a sandbox, so it must not require a daemon.
    expect(yml.jobs.act.steps[0].run).not.toContain('docker info');
  });

  it('behaviorally proves the guard rejects unapproved and daemon-less hosts', () => {
    // Structural assertions cannot catch a shell quoting bug that silently
    // disables the allowlist, so run the real step body against a stub docker.
    const runGuard = (step, { environment, name, dockerOk }) => {
      const dir = mkdtempSync(join(tmpdir(), 'patrol-guard-'));
      writeFileSync(
        join(dir, 'docker'),
        `#!/bin/sh\nexit ${dockerOk ? 0 : 1}\n`,
      );
      chmodSync(join(dir, 'docker'), 0o755);
      let status = 0;
      try {
        execFileSync('bash', ['-c', step.run], {
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            RUNNER_ENVIRONMENT: environment,
            RUNNER_NAME: name,
          },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        status = e.status;
      }
      rmSync(dir, { recursive: true, force: true });
      return status;
    };
    const classifyGuard = yml.jobs.classify.steps[0];
    const actGuard = yml.jobs.act.steps[0];
    const approved = { environment: 'self-hosted', name: 'ecs-qwen-hk1-1' };

    expect(runGuard(classifyGuard, { ...approved, dockerOk: true })).toBe(0);
    // A pool member without a usable daemon must fail before the classifier
    // spends its budget, not after.
    expect(runGuard(classifyGuard, { ...approved, dockerOk: false })).toBe(1);
    // The label routes; the registration name is what the allowlist checks.
    expect(
      runGuard(classifyGuard, {
        environment: 'self-hosted',
        name: 'rogue-host',
        dockerOk: true,
      }),
    ).toBe(1);
    // Hosted fallback needs no daemon at all.
    expect(
      runGuard(classifyGuard, {
        environment: 'github-hosted',
        name: 'hosted',
        dockerOk: false,
      }),
    ).toBe(0);
    expect(
      runGuard(classifyGuard, {
        environment: '',
        name: 'ecs-qwen-hk1-1',
        dockerOk: true,
      }),
    ).toBe(1);
    // act holds the write-capable PAT, so it keeps the allowlist...
    expect(
      runGuard(actGuard, {
        environment: 'self-hosted',
        name: 'rogue-host',
        dockerOk: true,
      }),
    ).toBe(1);
    // ...but must not inherit classify's daemon requirement.
    expect(runGuard(actGuard, { ...approved, dockerOk: false })).toBe(0);
  });

  it('pulls the sandbox image outside the classifier budget and times it', () => {
    const classify = yml.jobs.classify;
    const names = classify.steps.map((step) => step.name);
    const resolve = classify.steps.find(
      (step) => step.name === 'Resolve sandbox image',
    );
    expect(names.indexOf(resolve.name)).toBeLessThan(
      names.indexOf('Classify with ci-flaky-patrol skill'),
    );
    expect(resolve.run).toContain('resolve-sandbox-image.mjs');
    expect(resolve.env.SANDBOX_COMMAND).toBe('/usr/bin/docker');
    // A slow pull is the measurement this step exists to surface, so the
    // timing must be reported even when the resolver exits non-zero.
    expect(resolve.run).toContain('SECONDS');
    expect(resolve.run).toContain('|| status=$?');
    expect(resolve.run).toContain('exit "${status}"');

    // Bind the digest-pinned step output, not the appendable $GITHUB_ENV copy,
    // and pin the daemon endpoint the sandbox will spawn against.
    const classifier = classify.steps.find((step) =>
      step.uses?.includes('qwen-code-action'),
    );
    expect(classifier.env.QWEN_SANDBOX_IMAGE).toBe(
      '${{ steps.sandbox_image.outputs.image }}',
    );
    expect(classifier.env.DOCKER_HOST).toBe('');
    expect(classifier.env.DOCKER_CONTEXT).toBe('default');

    // The resolver can attempt TWO sequential 10-minute pulls — the requested
    // image, then a fallback to the latest GHCR semver — so its step must be
    // capped below the job exactly like the classifier. Without that cap a cold
    // host eats the whole job and the model never runs at all.
    expect(resolve['timeout-minutes']).toBeGreaterThanOrEqual(10);
    expect(resolve['timeout-minutes']).toBeLessThan(
      classify['timeout-minutes'],
    );
    // Both bounded steps, plus room for scan (~2 observed) and job setup, must
    // fit inside the job cap.
    expect(
      resolve['timeout-minutes'] + classifier['timeout-minutes'],
    ).toBeLessThan(classify['timeout-minutes']);

    // ensure / resolve / classifier share one gate. If they desync, the
    // classifier runs with an empty image reference or an empty CLI version.
    const ensure = classify.steps.find((step) => step.id === 'ensure_qwen');
    expect(resolve.if).toBe(ensure.if);
    expect(classifier.if).toBe(ensure.if);
  });

  it('behaviorally proves the resolve step reports timing and propagates failure', () => {
    // The whole point of moving the pull out of the classifier budget is to
    // learn where the time goes. A wrapper that swallowed the exit status, or
    // skipped the notice on failure, would report a green round and measure
    // nothing — so run the real body against a stub node.
    const resolve = yml.jobs.classify.steps.find(
      (step) => step.name === 'Resolve sandbox image',
    );
    const runResolve = (exitCode) => {
      const dir = mkdtempSync(join(tmpdir(), 'patrol-resolve-'));
      writeFileSync(join(dir, 'node'), `#!/bin/sh\nexit ${exitCode}\n`);
      chmodSync(join(dir, 'node'), 0o755);
      let status = 0;
      let stdout = '';
      try {
        stdout = execFileSync('bash', ['-ec', resolve.run], {
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        status = e.status;
        stdout = `${e.stdout ?? ''}`;
      }
      rmSync(dir, { recursive: true, force: true });
      return { status, stdout };
    };

    const ok = runResolve(0);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('::notice::Sandbox image resolve took');
    expect(ok.stdout).toContain('(exit 0)');

    // A failed pull must still surface its duration AND fail the step, so the
    // round is not recorded as a clean no-op.
    const failed = runResolve(7);
    expect(failed.status).toBe(7);
    expect(failed.stdout).toContain('::notice::Sandbox image resolve took');
    expect(failed.stdout).toContain('(exit 7)');
  });

  it('reuses the pool CLI rather than a hard-coded version the pool does not keep warm', () => {
    const classify = yml.jobs.classify;
    const ensure = classify.steps.find((step) => step.id === 'ensure_qwen');
    expect(ensure.run).toContain('command -v qwen');
    expect(ensure.run).toContain('version=$(qwen --version)');
    const classifier = classify.steps.find((step) =>
      step.uses?.includes('qwen-code-action'),
    );
    expect(classifier.with.qwen_cli_version).toBe(
      '${{ steps.ensure_qwen.outputs.version }}',
    );
    // Most ticks find no candidate. Resolving the CLI before the scan, or
    // ungated, makes the hosted fallback pay a global npm install every round.
    expect(ensure.if).toContain("steps.scan.outputs.target_found == 'true'");
    const names = classify.steps.map((step) => step.name);
    expect(names.indexOf('Scan stale PR failures')).toBeLessThan(
      names.indexOf('Ensure Qwen Code'),
    );
    expect(names.indexOf('Ensure Qwen Code')).toBeLessThan(
      names.indexOf('Classify with ci-flaky-patrol skill'),
    );
  });

  it("clears the previous round's state before classifying on a persistent workspace", () => {
    // The ECS workspace survives across jobs. A decisions file left by an
    // earlier round would pass Validate and be acted on even when this round's
    // classifier timed out without writing anything — acting on stale reruns.
    const classify = yml.jobs.classify;
    const scan = classify.steps.find((step) => step.id === 'scan');
    expect(scan.run).toContain('rm -f "${WORKDIR}/ci-flaky-decisions.json"');
    expect(scan.run).toContain('rm -rf "${QWEN_HOME}"');
    // The rm -rf target is pinned in the step's own env rather than inherited
    // from a job-level value: on the shared pool $GITHUB_ENV is writable by
    // anything running at the runner's uid. Both ends must name one directory.
    const classifier = classify.steps.find((step) =>
      step.uses?.includes('qwen-code-action'),
    );
    expect(scan.env.QWEN_HOME).toContain('runner.temp');
    expect(scan.env.QWEN_HOME).toBe(classifier.env.QWEN_HOME);
    expect(classify.env?.QWEN_HOME).toBeUndefined();
    const names = classify.steps.map((step) => step.name);
    expect(names.indexOf('Scan stale PR failures')).toBeLessThan(
      names.indexOf('Classify with ci-flaky-patrol skill'),
    );
  });
});
