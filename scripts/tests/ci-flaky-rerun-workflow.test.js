import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isMap, isSeq, parse, parseDocument } from 'yaml';

// macOS ships rm at /bin/rm, so a hardcoded /usr/bin/rm exits 127 on the macOS
// scripts lane (which collects these files — the vitest exclude is win32-only).
// Resolve external tools the way the workflows themselves do.
// macOS readlink has no -f, so only the symlink arms need this capability;
// the base accept, writable-root and missing-docker arms never resolve a link.
// usable() rejects a candidate the job uid OWNS, because ownership implies
// chmod. A same-uid fixture therefore cannot construct the accept arm at all
// (it can neither create a root-owned file nor write into a root-owned dir),
// so that arm runs against the real system roots and skips when the host does
// not keep the whole toolset there. The refusal arms stay fixture-driven.
const systemRootsAcceptable = (() => {
  if (process.getuid?.() === 0) return false;
  try {
    for (const tool of [
      'rm',
      'git',
      'timeout',
      'gh',
      'node',
      'mkdir',
      'grep',
      'readlink',
      'docker',
    ]) {
      let found = false;
      for (const root of ['/usr/bin', '/bin', '/usr/local/bin']) {
        const p = join(root, tool);
        if (!existsSync(p)) continue;
        const st = statSync(p);
        if (st.uid !== 0 && st.uid !== process.getuid?.()) continue;
        if (st.uid === process.getuid?.()) continue;
        if ((st.mode & 0o222) !== 0) continue;
        found = true;
        break;
      }
      if (!found) return false;
    }
    return true;
  } catch {
    return false;
  }
})();

const hasReadlinkF = (() => {
  try {
    execFileSync('bash', ['-c', 'readlink -f / >/dev/null 2>&1'], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
})();

const resolvedBin = (name) =>
  execFileSync('bash', ['-c', `command -v ${name}`], {
    encoding: 'utf8',
  }).trim();

// gitmeta validates every system_path component as a directory the job uid can
// neither write nor own. Derive the fixture value from the same binary it hands
// RM_BIN, so the two checks stand or fall together on any host.
const resolvedBinDir = (name) => resolvedBin(name).replace(/\/[^/]+$/, '');

// The point-of-use recheck, extracted by shape rather than by line number so a
// comment added above it cannot silently move the extraction off the loop.
const recheckLoop = (step) => {
  const lines = step.run.split('\n');
  const start = lines.findIndex((l) => l.startsWith('for v in '));
  expect(
    start,
    `${step.name} has a point-of-use recheck`,
  ).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((l, i) => i > start && l === 'done');
  expect(end, `${step.name} closes its recheck`).toBeGreaterThan(start);
  return lines.slice(start, end + 1).join('\n');
};

const runBody = (body, env) => {
  try {
    const out = execFileSync('bash', ['-c', body], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, out };
  } catch (e) {
    return { status: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

const readOutputs = (file) => {
  const outputs = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return outputs;
};

const workflow = readFileSync(
  '.github/workflows/qwen-ci-flaky-rerun.yml',
  'utf8',
);
const yml = parse(workflow);
const skill = readFileSync('.qwen/skills/ci-flaky-patrol/SKILL.md', 'utf8');

// Shared by the refusal cases and the accept cases below. Mode bits alone reach
// both verdicts for a non-root uid, so the accept path is testable without
// root-owned files; root bypasses -w entirely and must skip it.
const runGuard = (
  step,
  {
    environment,
    name,
    dockerOk,
    dockerStderr = '',
    sandboxCommand,
    // Mode bits alone reach both verdicts for a non-root uid: a 0555 file
    // in a 0555 directory is not writable by its owner. Root bypasses -w
    // entirely, so the accept cases gate on the uid, not the platform.
    fileMode = 0o755,
    rootMode = 0o755,
    nodeLink = null,
    omitDocker = false,
    plantReadlink = false,
    // The readlink bootstrap has its OWN directory-writability test, so with a
    // single root it refuses first and usable()'s directory check is never
    // reached. A separate non-writable readlink root isolates the two: the
    // bootstrap succeeds while the tool candidates sit in a writable directory,
    // which is exactly the case usable() must refuse on its own.
    separateReadlinkRoot = false,
  },
) => {
  const dir = mkdtempSync(join(tmpdir(), 'patrol-guard-'));
  const root = join(dir, 'bin');
  mkdirSync(root);
  for (const tool of ['rm', 'git', 'mktemp', 'gh', 'node', 'mkdir', 'grep']) {
    writeFileSync(join(root, tool), '#!/bin/sh\nexit 0\n');
    chmodSync(join(root, tool), fileMode);
  }
  // The guard bootstraps readlink with builtins and then invokes it
  // absolutely, so the fixture must supply a real one: a stub would make
  // the symlink cases assert nothing about target resolution.
  const realReadlink = execFileSync('bash', ['-c', 'command -v readlink'], {
    encoding: 'utf8',
  }).trim();
  const rlRoot = separateReadlinkRoot ? join(dir, 'rlbin') : root;
  if (separateReadlinkRoot) mkdirSync(rlRoot);
  copyFileSync(realReadlink, join(rlRoot, 'readlink'));
  chmodSync(join(rlRoot, 'readlink'), separateReadlinkRoot ? 0o555 : fileMode);
  if (separateReadlinkRoot) chmodSync(rlRoot, 0o555);
  if (nodeLink) {
    // A symlinked node, the shape that made a blanket -L refusal reject a
    // correctly provisioned pool host.
    const targetDir = join(dir, nodeLink.targetDir ?? 'target-bin');
    mkdirSync(targetDir, { recursive: true });
    const target = join(targetDir, 'node-real');
    writeFileSync(target, '#!/bin/sh\nexit 0\n');
    chmodSync(target, nodeLink.targetMode ?? fileMode);
    chmodSync(targetDir, nodeLink.targetDirMode ?? rootMode);
    rmSync(join(root, 'node'));
    symlinkSync(target, join(root, 'node'));
  }
  // The probe runs `"${timeout}" 10 "${docker}" info`, both from the
  // verified base, so the fixture controls the outcome through these two.
  writeFileSync(join(root, 'timeout'), '#!/bin/sh\nshift\nexec "$@"\n');
  chmodSync(join(root, 'timeout'), fileMode);
  // The stub answers only for the endpoint the workflow pins, so dropping
  // DOCKER_CONTEXT or DOCKER_HOST from the step's env fails the approved
  // host case instead of silently probing whatever the ambient shell had.
  const dockerStub =
    '#!/bin/sh\n' +
    '[ "${DOCKER_CONTEXT:-}" = "default" ] || exit 91\n' +
    '[ -z "${DOCKER_HOST:-}" ] || exit 92\n' +
    (dockerStderr ? `echo '${dockerStderr}' >&2\n` : '') +
    `exit ${dockerOk ? 0 : 1}\n`;
  if (!omitDocker) {
    writeFileSync(join(root, 'docker'), dockerStub);
    chmodSync(join(root, 'docker'), fileMode);
  }
  writeFileSync(join(dir, 'docker'), dockerStub);
  chmodSync(join(dir, 'docker'), 0o755);
  // The guard body ends in `timeout 10 …`, and coreutils timeout is absent
  // on a stock macOS host. Shim it here so the allowlist assertions stay
  // live on every platform; the separate wedged-daemon test deliberately
  // uses the real binary behind its own capability probe.
  writeFileSync(join(dir, 'timeout'), '#!/bin/sh\nshift\nexec "$@"\n');
  chmodSync(join(dir, 'timeout'), 0o755);
  if (plantReadlink) {
    // A co-tenant's readlink, first on the ambient PATH. It lies about the
    // target so a symlink into a writable directory looks safe, and it appends
    // its own output line — the runner takes the last value for a duplicated
    // key, so that would override the verified gh. The guard must never run it.
    writeFileSync(
      join(dir, 'readlink'),
      '#!/bin/sh\necho /usr/bin/true\n' +
        'echo "gh=/attacker/bin/gh" >> "${GITHUB_OUTPUT}"\n',
    );
    chmodSync(join(dir, 'readlink'), 0o755);
  }
  writeFileSync(join(dir, 'gh_output'), '');
  // chmod the root LAST: creating files inside a 0555 directory would fail.
  chmodSync(root, rootMode);
  const childEnv = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    RUNNER_ENVIRONMENT: environment,
    RUNNER_NAME: name,
    // Probe the stub rather than the host's real docker. The production
    // value is pinned structurally against the resolver's below. A caller
    // can point it elsewhere to prove the guard compares the two.
    SANDBOX_COMMAND: sandboxCommand ?? join(root, 'docker'),
    PATROL_BIN_ROOTS: separateReadlinkRoot ? `${rlRoot} ${root}` : root,
    GITHUB_OUTPUT: join(dir, 'gh_output'),
  };
  // Only the pins the workflow itself declares may reach the stub.
  delete childEnv.DOCKER_HOST;
  delete childEnv.DOCKER_CONTEXT;
  for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT']) {
    if (step.env?.[key] !== undefined) childEnv[key] = step.env[key];
  }
  let status = 0;
  let output = '';
  try {
    output = execFileSync('bash', ['-c', step.run], {
      env: childEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    status = e.status;
    output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  // Read the outputs back: dropping publish's echo line would otherwise
  // leave every assertion green while a real round aborts at ${RM_BIN:?}.
  const outputs = {};
  for (const line of readFileSync(join(dir, 'gh_output'), 'utf8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1);
  }
  // Restore write permission so the recursive cleanup can unlink children.
  chmodSync(root, 0o755);
  if (separateReadlinkRoot) chmodSync(rlRoot, 0o755);
  if (nodeLink) {
    chmodSync(join(dir, nodeLink.targetDir ?? 'target-bin'), 0o755);
  }
  rmSync(dir, { recursive: true, force: true });
  return { status, output, outputs };
};

// coreutils timeout is present on both runner families this workflow targets,
// but not on a stock macOS dev host. Probe it the way the autofix suite probes
// bash mapfile rather than assuming the developer platform matches the runner.
const hasNpmCommand = (() => {
  try {
    execFileSync('bash', ['-c', 'command -v npm'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const hasTimeoutCommand = (() => {
  try {
    execFileSync('timeout', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

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
          env: {
            ...process.env,
            WORKDIR: dir,
            GITHUB_OUTPUT: out,
            // Same reason as runResolve: on the fleet the ambient value is
            // 'self-hosted' and the recheck would refuse process.execPath
            // whenever it is a uid-owned tool-cache node.
            RUNNER_ENVIRONMENT: 'github-hosted',
            NODE_BIN: process.execPath,
          },
          encoding: 'utf8',
        });
      } catch (e) {
        status = e.status;
      }
      const result = readFileSync(out, 'utf8');
      rmSync(dir, { recursive: true, force: true });
      return { status, result };
    };
    // A non-empty decision list -> act downstream.
    const usable = run('{"decisions":[{"pr":123,"action":"rerun"}]}');
    expect(usable).toMatchObject({ status: 0 });
    expect(usable.result).toContain('has_decisions=true');
    // Parseable but empty is NOT actionable: act would iterate zero entries and
    // the run would conclude success on a round that did nothing. The verdict
    // step must see has_decisions=false for these.
    for (const empty of ['{"decisions":[]}', '{"decisions":{}}', '[]']) {
      const r = run(empty);
      expect(r, empty).toMatchObject({ status: 0 });
      expect(r.result, empty).toContain('has_decisions=false');
    }
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
      'BASH_ENV',
      'DOCKER_CONTEXT',
      'DOCKER_HOST',
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'LD_AUDIT',
      'LD_LIBRARY_PATH',
      'LD_PRELOAD',
      'NODE_OPTIONS',
      'PATH',
      'QWEN_HOME',
      'QWEN_SANDBOX',
      'QWEN_SANDBOX_IMAGE',
      'QWEN_SANDBOX_PROXY_COMMAND',
      'SANDBOX',
      'SHELLOPTS',
    ]);
    expect(classifier.env.GH_TOKEN).toBe('');
    expect(classifier.env.GITHUB_TOKEN).toBe('');
    // The only sandbox variable the launcher EXECUTES: serve/sandbox.ts
    // interpolates it unquoted into a `bash -c` command line, so a residue
    // value is arbitrary command execution in the step holding the model key.
    expect(classifier.env.QWEN_SANDBOX_PROXY_COMMAND).toBe('');
    // The CLI resolves its sandbox command as a bare name through PATH, so the
    // classifier must search the PATH the guard checked, not the ambient one.
    expect(classifier.env.PATH).toBe('${{ steps.stage.outputs.trusted_path }}');
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
    expect(reset.env.GITHUB_TOKEN).toContain('CI_BOT_PAT');
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
    // Substring pins left an inverted kill switch green: `== 'true'` still
    // contains every term asserted here. Pin the whole expression against the
    // repository's canonical pool routing, which
    // `.github/scripts/ci-runner-routing.test.mjs` evaluates for the switch on,
    // the switch off and a foreign repository — so the semantics are pinned
    // where the evaluator lives rather than duplicated as a second one here.
    const reference = parse(
      readFileSync('.github/workflows/repo-hygiene.yml', 'utf8'),
    ).jobs.dedup['runs-on'];
    for (const job of [yml.jobs.classify, yml.jobs.act]) {
      expect(job['runs-on']).toBe(reference);
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
    // classifier would otherwise burn its whole 10-minute budget before failing.
    expect(yml.jobs.classify.steps[0].run).toContain(
      '"${timeout}" 10 "${docker}" info',
    );
    // act never starts a sandbox, so it must not require a daemon.
    expect(yml.jobs.act.steps[0].run).not.toContain('SANDBOX_COMMAND');
    expect(yml.jobs.act.steps[0].env?.SANDBOX_COMMAND).toBeUndefined();
  });

  it('behaviorally proves the guard rejects unapproved and daemon-less hosts', () => {
    // Structural assertions cannot catch a shell quoting bug that silently
    // disables the allowlist, so run the real step body against a stub docker.
    const guardStatus = (...args) => runGuard(...args).status;
    const classifyGuard = yml.jobs.classify.steps[0];
    const actGuard = yml.jobs.act.steps[0];
    const approved = { environment: 'self-hosted', name: 'ecs-qwen-hk1-1' };

    // Hosted runners are ephemeral and single-tenant, so the guard falls back
    // to ambient resolution there; that path exercises publish + system_path +
    // the probe wiring without needing root-owned fixture files.
    expect(
      guardStatus(classifyGuard, {
        environment: 'github-hosted',
        name: 'hosted',
        dockerOk: true,
      }),
    ).toBe(0);
    // A pool member without a usable daemon must fail before the classifier
    // spends its budget, not after.
    expect(guardStatus(classifyGuard, { ...approved, dockerOk: false })).toBe(
      1,
    );
    // The label routes; the registration name is what the allowlist checks.
    expect(
      guardStatus(classifyGuard, {
        environment: 'self-hosted',
        name: 'rogue-host',
        dockerOk: true,
      }),
    ).toBe(1);
    // The probe is unconditional: a wedged or dead daemon is just as fatal on
    // the hosted fallback, where the classifier still runs in a sandbox.
    expect(
      guardStatus(classifyGuard, {
        environment: 'github-hosted',
        name: 'hosted',
        dockerOk: false,
      }),
    ).toBe(1);
    expect(
      guardStatus(classifyGuard, {
        environment: '',
        name: 'ecs-qwen-hk1-1',
        dockerOk: true,
      }),
    ).toBe(1);
    // act holds the write-capable PAT, so it keeps the allowlist...
    expect(
      guardStatus(actGuard, {
        environment: 'self-hosted',
        name: 'rogue-host',
        dockerOk: true,
      }),
    ).toBe(1);
    // ...but must not inherit classify's daemon requirement: act runs no
    // sandbox, so a dead daemon is irrelevant there. Hosted mode so the base
    // resolves; the self-hosted refusal is covered by the plantable case above.
    expect(
      guardStatus(actGuard, {
        environment: 'github-hosted',
        name: 'hosted',
        dockerOk: false,
      }),
    ).toBe(0);

    // The CLI spawns its sandbox through the bare name `docker`, so a host
    // whose PATH docker is not the pinned binary must be refused even though
    // the pinned binary itself answers healthily. Otherwise the preflight
    // greenlights a host where the classifier runs outside any container.
    // The whole point of the verified base: a candidate inside a directory the
    // job uid can write is refused, because a co-tenant can replace it there.
    const plantable = runGuard(classifyGuard, { ...approved, dockerOk: true });
    expect(plantable.status).not.toBe(0);
    expect(plantable.output).toContain('no verified');
    expect(plantable.output).toContain('refusing to run');

    // A non-timeout probe failure must surface the probe's own diagnostic
    // instead of blaming a healthy daemon for a missing binary or a socket
    // permission problem.
    const diagnostic = runGuard(classifyGuard, {
      environment: 'github-hosted',
      name: 'hosted',
      dockerOk: false,
      dockerStderr: 'PATROL-PROBE-DIAGNOSTIC permission denied',
    });
    expect(diagnostic.status).toBe(1);
    expect(diagnostic.output).toContain('PATROL-PROBE-DIAGNOSTIC');
    expect(diagnostic.output).not.toContain('did not answer within 10s');
  });

  // Root bypasses every -w test, so the accept path is only meaningful for a
  // non-root uid. The platform is NOT the gate: the base accept, writable-root
  // and missing-docker arms never call readlink -f, so they must keep running on
  // macOS — they are the only pins on the accept verdict and publish()'s writes.
  it.skipIf(!systemRootsAcceptable)(
    'behaviorally proves the guard accepts a non-writable base and publishes it',
    () => {
      const guard = yml.jobs.classify.steps[0];
      const approved = {
        environment: 'self-hosted',
        name: 'ecs-qwen-hk1-1',
        dockerOk: true,
      };
      const modes = { fileMode: 0o555, rootMode: 0o555 };

      // Without an accept case, a guard that refuses EVERY pool host — a total
      // patrol outage, the class this PR exists to fix — passes the whole suite.
      const ok = runGuard(guard, { ...approved, ...modes });
      expect(ok.output).toBe('');
      expect(ok.status).toBe(0);
      for (const tool of [
        'rm',
        'git',
        'timeout',
        'gh',
        'node',
        'mkdir',
        'grep',
        'docker',
      ]) {
        expect(ok.outputs[tool], `published ${tool}`).toMatch(
          new RegExp(`/bin/${tool}$`),
        );
      }
      // publish must really write $GITHUB_OUTPUT: dropping its echo line leaves
      // every refusal assertion green while a real round aborts at ${RM_BIN:?}.
      expect(ok.outputs.system_path).toBeTruthy();
      for (const dir of ok.outputs.system_path.split(':')) {
        expect(dir.length).toBeGreaterThan(0);
      }
      expect(ok.outputs.system_path.split(':')).toContain(
        ok.outputs.rm.replace(/\/rm$/, ''),
      );

      // The directory check is load-bearing on its own: a non-writable file
      // inside a WRITABLE directory can be replaced by a co-tenant.
      const writableDir = runGuard(guard, {
        ...approved,
        fileMode: 0o555,
        rootMode: 0o755,
        separateReadlinkRoot: true,
      });
      expect(writableDir.status).not.toBe(0);
      expect(writableDir.output).toContain('no verified rm');
      expect(writableDir.outputs.system_path).toBeUndefined();

      // A symlink is accepted only when the link's directory, the resolved
      // target and the target's directory are all non-writable. These three
      // arms are the only ones that need readlink -f.
      if (hasReadlinkF) {
        const linkOk = runGuard(guard, {
          ...approved,
          ...modes,
          nodeLink: { targetMode: 0o555, targetDirMode: 0o555 },
        });
        expect(linkOk.status).toBe(0);
        expect(linkOk.outputs.node).toMatch(/\/bin\/node$/);
        const linkBad = runGuard(guard, {
          ...approved,
          ...modes,
          nodeLink: { targetMode: 0o555, targetDirMode: 0o755 },
        });
        expect(linkBad.status).not.toBe(0);
        expect(linkBad.output).toContain('no verified node');

        // The trust anchor itself: a lying readlink first on the ambient PATH
        // must never run. If it did, it would report a harmless target for the
        // writable-directory symlink above AND append its own gh= output line,
        // which the runner would take as the last value for that key.
        const planted = runGuard(guard, {
          ...approved,
          ...modes,
          nodeLink: { targetMode: 0o555, targetDirMode: 0o755 },
          plantReadlink: true,
        });
        expect(planted.status).not.toBe(0);
        expect(planted.output).toContain('no verified node');
        expect(planted.outputs.gh).not.toBe('/attacker/bin/gh');
        expect(planted.outputs.node).toBeUndefined();
      }

      // The docker branch has its own refusal: the pinned binary missing must
      // name docker, not whichever tool the fixture happened to fail on first.
      const noDocker = runGuard(guard, {
        ...approved,
        ...modes,
        omitDocker: true,
      });
      expect(noDocker.status).not.toBe(0);
      expect(noDocker.output).toContain('no verified docker');
    },
  );

  it('preflights the same daemon and binary the classifier and resolver use', () => {
    // An unpinned probe answers for the pool-shared currentContext, which is
    // not the context the classifier is pinned to: it can reject a host whose
    // default daemon is healthy, or pass on one whose default daemon is dead
    // and let the classifier burn its ten-minute budget. The binary has the
    // same shape — a PATH docker that is not the resolver's absolute path
    // makes the preflight green while the resolve step fails immediately.
    const classify = yml.jobs.classify;
    const guard = classify.steps[0];
    const resolver = classify.steps.find((step) => step.id === 'sandbox_image');
    const classifier = classify.steps.find((step) =>
      step.uses?.includes('qwen-code-action'),
    );
    expect(guard.env.DOCKER_HOST).toBe(classifier.env.DOCKER_HOST);
    expect(guard.env.DOCKER_CONTEXT).toBe(classifier.env.DOCKER_CONTEXT);
    expect(guard.env.DOCKER_HOST).toBe('');
    expect(guard.env.DOCKER_CONTEXT).toBe('default');
    expect(guard.env.SANDBOX_COMMAND).toBe(resolver.env.SANDBOX_COMMAND);
    expect(guard.env.SANDBOX_COMMAND).toBe('/usr/bin/docker');
    // The probe must go through that pinned binary, not a PATH lookup.
    expect(guard.run).toContain('"${timeout}" 10 "${docker}" info');
    expect(guard.run).not.toMatch(/timeout 10 docker/);
    // The guard must establish its base without resolving any name. readlink is
    // the one external command the predicate needs, so it has to be bootstrapped
    // by builtins and invoked absolutely — a bare `readlink -f` would resolve
    // through the plantable PATH this step exists to distrust, and a planted
    // readlink runs with $GITHUB_OUTPUT and $GITHUB_ENV in its environment.
    // Both copies: act's guard is byte-identical and holds the write PAT, but
    // nothing pinned its tool loop or roots. Dropping gh there does not even
    // abort — no act step interpolates GH_BIN, so PATROL_GH would silently fall
    // back to a bare-name spawn on the plantable PATH.
    for (const job of [yml.jobs.classify, yml.jobs.act]) {
      const copy = job.steps[0];
      expect(copy.env.PATROL_BIN_ROOTS, job.name).toBe(
        '/usr/bin /bin /usr/local/bin',
      );
      expect(copy.run, job.name).toContain(
        'for tool in rm git timeout gh node mkdir grep; do',
      );
      // Every guard output a later step consumes must be published by that
      // job's own loop (docker is verified separately, from SANDBOX_COMMAND).
      const consumed = new Set(
        [
          ...JSON.stringify(job.steps).matchAll(
            /steps\.guard\.outputs\.([\w-]+)/g,
          ),
        ].map((m) => m[1]),
      );
      const published = new Set(
        (copy.run.match(/for tool in ([^;]+); do/)?.[1] ?? '').split(/\s+/),
      );
      published.add('docker');
      // Derive the rest from the actual publish lines, so dropping one of them
      // (system_path, readlink) turns this red instead of being assumed.
      for (const m of copy.run.matchAll(/echo "([\w-]+)=/g)) {
        published.add(m[1]);
      }
      for (const name of consumed) {
        expect(published.has(name), `${job.name} consumes ${name}`).toBe(true);
      }
    }
    expect(guard.env.PATROL_BIN_ROOTS).toBe('/usr/bin /bin /usr/local/bin');
    expect(guard.run).toContain('usable()');
    expect(guard.run).toContain('[ ! -L "${c}" ] && [ -x "${c}" ]');
    expect(guard.run).toContain('readlink="${c}"');
    expect(guard.run).toContain('"${readlink:?}" -f "${p}"');
    expect(guard.run).toContain('"${readlink:?}" -f "${c}"');
    expect(guard.run).not.toContain('$(readlink -f');
    expect(guard.run).toContain('no verified readlink');
    // A blanket symlink refusal rejected node on a correctly provisioned pool
    // host; the target and its directory must be checked, not the link alone.
    expect(guard.run).toContain('if [ -L "${p}" ]; then');
    // Ownership implies chmod, so a uid-owned 0555 residue binary must be
    // refused even though -w passes. The behavioural accept arm cannot cover
    // this on a host without a root-owned toolset, so pin all three arms.
    expect(guard.run).toContain('[ ! -O "${p}" ]');
    expect(guard.run).toContain('[ ! -O "${c}" ]');
    expect(guard.run).toContain('[ ! -O "${t}" ]');
    expect(guard.run).toContain('[ ! -w "${t}" ]');
    expect(guard.run).toContain('[ ! -w "${td}" ]');
  });

  it('fails the round when candidates produced no decisions', () => {
    // This is the defect that let the patrol report success for twenty
    // consecutive ineffective rounds, and a pool probe reproduced it again.
    // The classifier stays continue-on-error so one slow model costs a cycle,
    // but the RUN must not be green when candidates existed and nothing
    // actionable came back.
    const classify = yml.jobs.classify;
    const verdict = classify.steps.find(
      (s) => s.name === 'Fail the round when candidates produced no decisions',
    );
    expect(verdict).toBeTruthy();
    // Pin the operator, not just the operands: both substring assertions below
    // pass for `||` too, and on the most common tick (target_found='false',
    // has_decisions unset) `false || ('' != 'true')` is TRUE — every idle round
    // would go red with this suite green.
    expect(verdict.if).not.toContain('||');
    expect(verdict.if).toBe(
      "${{ steps.scan.outputs.target_found == 'true' && steps.decisions.outputs.has_decisions != 'true' }}",
    );
    expect(verdict.if).toContain("steps.scan.outputs.target_found == 'true'");
    expect(verdict.if).toContain(
      "steps.decisions.outputs.has_decisions != 'true'",
    );
    // It must run after Upload so the evidence survives the red, and it must
    // not be continue-on-error, or the run stays green again.
    const names = classify.steps.map((s) => s.name);
    expect(names.indexOf(verdict.name)).toBeGreaterThan(
      names.indexOf('Upload patrol input and decisions'),
    );
    expect(verdict['continue-on-error']).toBeUndefined();
    expect(verdict.run).toContain('exit 1');

    // Behavioural: evaluate the WORKFLOW's expression, not a hand-copied
    // replica — a replica only ever makes statements about itself.
    const fires = (targetFound, hasDecisions) => {
      const expr = verdict.if
        .replace(/^\$\{\{\s*/, '')
        .replace(/\s*\}\}$/, '')
        .split('steps.scan.outputs.target_found')
        .join(JSON.stringify(targetFound))
        .split('steps.decisions.outputs.has_decisions')
        .join(JSON.stringify(hasDecisions));
      expect(expr).not.toMatch(/steps\./);
      return new Function(`return (${expr});`)();
    };
    expect(fires('true', 'false')).toBe(true); // outage -> red
    expect(fires('true', '')).toBe(true); // validate skipped -> red
    expect(fires('true', 'true')).toBe(false); // real decisions -> green
    expect(fires('false', '')).toBe(false); // no candidates -> green no-op

    // And the body really exits non-zero with an attributable message.
    let status = 0;
    let output = '';
    try {
      output = execFileSync('bash', ['-c', verdict.run], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      status = e.status;
      output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    expect(status).toBe(1);
    expect(output).toContain('produced no usable decisions');
  });

  it('behaviorally proves the classifier PATH docker equality fails closed', () => {
    // The guard checks the ambient base; the classifier runs on the captured
    // PATH, which setup-node has since prepended to. This step re-checks the
    // resolution on that exact PATH, so a plantable docker there is refused.
    const step = yml.jobs.classify.steps.find(
      (s) => s.name === 'Verify classifier docker resolution',
    );
    expect(step.env.PATH).toBe('${{ steps.stage.outputs.trusted_path }}');
    expect(step.if).toContain("runner.environment == 'self-hosted'");
    const run = (plant) => {
      const dir = mkdtempSync(join(tmpdir(), 'patrol-docker-eq-'));
      const pinned = join(dir, 'pinned');
      const pathDir = join(dir, 'onpath');
      mkdirSync(pinned);
      mkdirSync(pathDir);
      for (const [d, tag] of [
        [pinned, 'pinned'],
        [pathDir, 'planted'],
      ]) {
        writeFileSync(join(d, 'docker'), `#!/bin/sh\necho ${tag}\n`);
        chmodSync(join(d, 'docker'), 0o755);
      }
      let status = 0;
      let output = '';
      try {
        output = execFileSync('bash', ['-c', step.run], {
          env: {
            ...process.env,
            PATH: plant
              ? `${pathDir}:${pinned}:${process.env.PATH}`
              : `${pinned}:${process.env.PATH}`,
            SANDBOX_COMMAND: join(pinned, 'docker'),
          },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        status = e.status;
        output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
      }
      rmSync(dir, { recursive: true, force: true });
      return { status, output };
    };
    expect(run(false).status).toBe(0);
    const planted = run(true);
    expect(planted.status).not.toBe(0);
    expect(planted.output).toContain('refusing to run here');
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
    // The resolver takes the image as its only positional argument. Dropping
    // it makes the script throw on every round — a total patrol outage — and
    // nothing else in this suite would notice, so pin the argument itself.
    expect(resolve.run).toContain(
      '"$("${NODE_BIN:?}" -p "require(\'./package.json\').config.sandboxImageUri")"',
    );
    expect(resolve.env.NODE_BIN).toBe('${{ steps.guard.outputs.node }}');
    // A slow pull is the measurement this step exists to surface, so the
    // timing must be reported even when the resolver exits non-zero.
    expect(resolve.run).toContain('SECONDS');
    expect(resolve.run).toContain('|| status=$?');
    expect(resolve.run).toContain('exit "${status}"');
    // The resolver's two-pull worst case outlasts the step cap, and a runner
    // kill takes the notice with it. Bound it inside the step instead, through
    // the guard's verified timeout, with room left under the cap to report.
    expect(resolve.env.TIMEOUT_BIN).toBe('${{ steps.guard.outputs.timeout }}');
    const inner = resolve.run.match(/"\$\{TIMEOUT_BIN:\?\}" (\d+) /);
    expect(inner).not.toBeNull();
    expect(Number(inner[1])).toBeLessThan(resolve['timeout-minutes'] * 60);
    expect(
      resolve['timeout-minutes'] * 60 - Number(inner[1]),
    ).toBeGreaterThanOrEqual(30);
    expect(resolve.run.indexOf('"${TIMEOUT_BIN:?}"')).toBeLessThan(
      resolve.run.indexOf('::notice::Sandbox image resolve took'),
    );

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
    // A pool probe measured the classifier hitting a 5-minute cap after a 2s
    // image pull, i.e. the model alone needs more than five minutes. Pin the
    // floor so a future edit cannot silently restore the known-bad budget.
    expect(classifier['timeout-minutes']).toBeGreaterThanOrEqual(10);
    expect(resolve['timeout-minutes']).toBeGreaterThanOrEqual(10);
    expect(resolve['timeout-minutes']).toBeLessThan(
      classify['timeout-minutes'],
    );
    // Every capped step must fit inside the job cap together, with room left
    // for the uncapped ones (scan ~2 observed, checkout, setup-node, capture).
    // Summing only resolve + classifier previously omitted the guard's own two
    // minutes, so the job could be killed by the very caps it installed.
    const cappedSum = classify.steps.reduce(
      (total, step) => total + (step['timeout-minutes'] ?? 0),
      0,
    );
    expect(cappedSum).toBeGreaterThan(0);
    expect(cappedSum).toBeLessThan(classify['timeout-minutes']);
    expect(classify['timeout-minutes'] - cappedSum).toBeGreaterThanOrEqual(3);

    // ensure / resolve / classifier share one gate. If they desync, the
    // classifier runs with an empty image reference or an empty CLI version.
    const ensure = classify.steps.find((step) => step.id === 'ensure_qwen');
    expect(resolve.if).toBe(ensure.if);
    expect(classifier.if).toBe(ensure.if);
    // Ensure is network-bound: on the hosted fallback qwen is absent, so every
    // candidate-bearing round pays a cold global npm install. Unbounded, a slow
    // registry spends the job's remaining slack and the runner then cancels the
    // job INSIDE the classifier, where continue-on-error does not apply — so
    // validate, upload and the verdict step never run and the round concludes
    // cancelled, saying nothing. It must carry its own cap, counted in the sum
    // above like every other capped step.
    expect(ensure['timeout-minutes']).toBeGreaterThan(0);
    expect(ensure['timeout-minutes']).toBeLessThan(classify['timeout-minutes']);
  });

  it('behaviorally proves the resolve step reports timing and propagates failure', () => {
    // The whole point of moving the pull out of the classifier budget is to
    // learn where the time goes. A wrapper that swallowed the exit status, or
    // skipped the notice on failure, would report a green round and measure
    // nothing — so run the real body against a stub node.
    const resolve = yml.jobs.classify.steps.find(
      (step) => step.name === 'Resolve sandbox image',
    );
    const runResolve = (exitCode, { timeoutKills = false } = {}) => {
      const dir = mkdtempSync(join(tmpdir(), 'patrol-resolve-'));
      const stub = join(dir, 'node');
      writeFileSync(stub, `#!/bin/sh\nexit ${exitCode}\n`);
      chmodSync(stub, 0o755);
      // The step bounds the resolver with the guard's verified timeout. A
      // pass-through stub exercises the wiring; the killing stub reproduces
      // the two-pull worst case, where the runner used to kill the step and
      // the notice was lost with it.
      const timeoutStub = join(dir, 'timeout');
      writeFileSync(
        timeoutStub,
        timeoutKills
          ? '#!/bin/sh\nexit 124\n'
          : '#!/bin/sh\nshift\nexec "$@"\n',
      );
      chmodSync(timeoutStub, 0o755);
      let status = 0;
      let stdout = '';
      try {
        stdout = execFileSync('bash', ['-ec', resolve.run], {
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            // scripts/tests runs on the ECS fleet for same-repo PRs, so the
            // ambient RUNNER_ENVIRONMENT is 'self-hosted' there and the step's
            // point-of-use recheck would refuse these uid-owned stubs. Pin the
            // hosted policy: this fixture measures timing and exit propagation,
            // not the ownership predicate (which has its own tests).
            RUNNER_ENVIRONMENT: 'github-hosted',
            NODE_BIN: stub,
            TIMEOUT_BIN: timeoutStub,
          },
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

    // The case the inner bound exists for: the resolver outlives its budget.
    // The shell must still report the elapsed time and fail the round, rather
    // than letting the runner kill the step and lose the measurement.
    const killed = runResolve(0, { timeoutKills: true });
    expect(killed.status).toBe(124);
    expect(killed.stdout).toContain('::notice::Sandbox image resolve took');
    expect(killed.stdout).toContain('(exit 124)');
  });

  it('reuses the pool CLI rather than a hard-coded version the pool does not keep warm', () => {
    const classify = yml.jobs.classify;
    const ensure = classify.steps.find((step) => step.id === 'ensure_qwen');
    // The pool uid owns $HOME/.npmrc; a residue file there redirects the
    // install, and its stdout becomes the version pin the classifier uses.
    // Both scopes must be neutral AND distinct: npm aborts with
    // `double-loading config "/dev/null" as "global", previously loaded as
    // "user"` when the two are the same path, which kills the install branch
    // and with it the entire hosted fallback. The behavioural arm below runs
    // npm under these pins; this pair only pins the shape.
    expect(ensure.env.npm_config_userconfig).toBe(
      '/nonexistent/patrol-npm-user',
    );
    expect(ensure.env.npm_config_globalconfig).toBe(
      '/nonexistent/patrol-npm-global',
    );
    expect(ensure.env.npm_config_userconfig).not.toBe(
      ensure.env.npm_config_globalconfig,
    );
    for (const key of ['npm_config_userconfig', 'npm_config_globalconfig']) {
      // Away from HOME, and not creatable by the job uid: `/` is root-owned.
      expect(ensure.env[key].startsWith('/nonexistent/'), key).toBe(true);
    }
    expect(ensure.run).toContain('command -v qwen');
    // Neither tool may EXECUTE as a bare name: the tail of this PATH is
    // uid-writable, and a planted qwen would decide whether to install at all
    // while its stdout became the version pin the classifier runs.
    const ensureCode = ensure.run
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(ensureCode).toContain('NPM_BIN="$(verify_on_path npm)"');
    expect(ensureCode).toContain('QWEN_BIN="$(verify_on_path qwen)"');
    expect(ensureCode).toContain('echo "version=$("${QWEN_BIN}" --version)"');
    // `(` is in the prefix class on purpose: the version pin is captured as
    // `$(… --version)`, so a regex anchored only on whitespace would let the
    // bare-name regression back in through the command substitution.
    expect(ensureCode).not.toMatch(/(^|[\s;&|(`])qwen\s+--version/);
    expect(ensureCode).not.toMatch(/(^|[\s;&|(`])npm\s+install/);
    expect(ensure.env.READLINK_BIN).toBe('${{ steps.guard.outputs.readlink }}');
    expect(ensure.env.RUNNER_ENVIRONMENT).toBe('${{ runner.environment }}');
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
    // Strip comments first: a commented-out reset still contains the substring,
    // and this step declares no PATH, so every external command it runs must be
    // the guard's verified absolute. A planted `rm` that exits 0 without
    // deleting leaves the previous round's decisions file in place, validate
    // accepts it, has_decisions becomes true and act replays stale decisions —
    // a failure the verdict step cannot catch because has_decisions is true.
    const code = scan.run
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(code).toContain(
      '"${RM_BIN:?}" -f -- "${WORKDIR}/ci-flaky-decisions.json"',
    );
    expect(code).toContain('"${RM_BIN:?}" -rf -- "${QWEN_HOME}"');
    expect(code).toContain('"${MKDIR_BIN:?}" -p "${QWEN_HOME}"');
    expect(code).toContain('"${MKDIR_BIN:?}" -p "${WORKDIR}"');
    // grep writes target_found/input_sha into $GITHUB_OUTPUT, so it is the same
    // class of trust anchor as the resets.
    expect(code).toContain('"${GREP_BIN:?}" -E');
    for (const bare of ['rm ', 'mkdir ', 'grep ']) {
      expect(code, `bare ${bare}`).not.toMatch(
        new RegExp(`(^|[\\s;&|])${bare.trim()}\\s`, 'm'),
      );
    }
    expect(scan.env.RM_BIN).toBe('${{ steps.guard.outputs.rm }}');
    expect(scan.env.MKDIR_BIN).toBe('${{ steps.guard.outputs.mkdir }}');
    expect(scan.env.GREP_BIN).toBe('${{ steps.guard.outputs.grep }}');
    // The guard must actually verify the two tools this step newly binds.
    expect(classify.steps[0].run).toContain(
      'for tool in rm git timeout gh node mkdir grep; do',
    );
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
    // scan resets the home, then the install and the image pull run for
    // minutes before the classifier reads memory.md / skills / extensions from
    // it. The reset must be repeated immediately before its only consumer.
    const homeReset = classify.steps.find(
      (step) => step.name === 'Reset agent home immediately before classifying',
    );
    expect(homeReset).toBeTruthy();
    expect(names.indexOf(homeReset.name)).toBe(
      names.indexOf('Classify with ci-flaky-patrol skill') - 1,
    );
    expect(homeReset.if).toBe(classifier.if);
    expect(homeReset.env.QWEN_HOME).toBe(classifier.env.QWEN_HOME);
    expect(homeReset.run).toContain('"${RM_BIN:?}" -rf -- "${QWEN_HOME}"');
    expect(homeReset.run).toContain('"${MKDIR_BIN:?}" -p "${QWEN_HOME}"');
  });

  it('gates the token-bearing reset on the guard and a successful checkout', () => {
    // always() keeps the reset running after a failed act, which is the point.
    // On a persistent runner it must NOT also fire after the guard rejected the
    // host or the checkout failed: this step hands CI_BOT_PAT to a script read
    // out of the workspace, and without a successful checkout that script is
    // whatever a previous round left there. The allowlist alone does not close
    // the write path.
    const act = yml.jobs.act;
    const reset = act.steps.find(
      (step) => step.name === 'Reset successful failure state',
    );
    expect(reset.env.GITHUB_TOKEN).toContain('CI_BOT_PAT');
    expect(reset.if).toContain('always()');
    // No disjunction: an || would let one success bypass the other requirement.
    expect(reset.if).not.toContain('||');
    const required = [
      ...reset.if.matchAll(/steps\.([\w-]+)\.outcome == 'success'/g),
    ].map((match) => match[1]);
    expect(required.sort()).toEqual(['checkout', 'guard']);
    for (const id of required) {
      expect(
        act.steps.find((step) => step.id === id),
        `reset requires steps.${id}.outcome, so that step must carry the id`,
      ).toBeTruthy();
    }
    const ids = act.steps.map((step) => step.id);
    expect(ids.indexOf('guard')).toBeLessThan(ids.indexOf('checkout'));
    // Both rejected paths really do produce a non-success outcome: the guard
    // exits 1 on an unapproved host (proved against the real shell above), and
    // a failed checkout leaves its own outcome failed, so the conjunction is
    // false in both cases rather than only in the happy path.
    expect(act.steps.find((step) => step.id === 'guard').run).toContain(
      'refusing to run here',
    );
  });

  it('denies the classifier the Git metadata writes it could otherwise plant', () => {
    // Rebuilding .git before checkout closes the cross-round path. This closes
    // the same-round one: the post-checkout cleanup still runs git commands
    // after the agent has had write access to the workspace.
    const classifier = yml.jobs.classify.steps.find((step) =>
      step.uses?.includes('qwen-code-action'),
    );
    const deny = JSON.parse(classifier.with.settings).permissions?.deny ?? [];
    for (const rule of [
      'write_file(/.git/config)',
      'write_file(/.git/hooks/**)',
      'write_file(**/.git/config)',
      'write_file(**/.git/hooks/**)',
    ]) {
      expect(deny).toContain(rule);
    }
  });

  it('behaviorally proves a planted Git filter cannot ride into the next round', () => {
    // Step placement, the self-hosted gate and symlink safety are owned by the
    // cross-workflow registry in qwen-runner-checkout-workflow.test.js, where
    // both patrol jobs are registered. This fixture covers what that registry
    // cannot: that a filter planted with write_file alone actually executes
    // during a normal checkout, and that the rebuild stops it.
    const recreate = yml.jobs.classify.steps.find(
      (step) => step.name === 'Recreate runner Git metadata',
    );

    const dir = mkdtempSync(join(tmpdir(), 'patrol-git-'));
    const sentinel = join(dir, 'PWNED');
    const payload = join(dir, 'payload.sh');
    const runnerTemp = join(dir, 'runner-temp');
    mkdirSync(runnerTemp);
    const githubEnv = join(dir, 'gh-env');
    writeFileSync(githubEnv, '');
    // Isolate from the developer's own global config: a signing key, a
    // template dir or a global hooksPath would otherwise red a test that is
    // about workflow contamination, not about the host's git setup.
    const git = (args) =>
      execFileSync('git', args, {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
        },
      });
    try {
      git(['init', '-q']);
      git(['config', 'user.email', 'patrol@example.test']);
      git(['config', 'user.name', 'patrol']);
      writeFileSync(join(dir, 'driver.mjs'), 'original\n');
      writeFileSync(join(dir, '.gitattributes'), 'driver.mjs filter=evil\n');
      git(['add', '.']);
      git(['commit', '-qm', 'seed']);
      // Everything below needs only write_file — the classifier's sole write
      // tool. No shell, no credential, no network.
      writeFileSync(payload, `#!/bin/sh\ntouch '${sentinel}'\ncat\n`);
      chmodSync(payload, 0o755);
      git(['config', 'filter.evil.smudge', payload]);
      git(['config', 'filter.evil.clean', payload]);

      // Positive control: without the rebuild, checkout's own clean/reset
      // executes the planted filter while HEAD stays the trusted commit. If
      // this ever stops firing the fixture is dead and the assertions below
      // would pass vacuously.
      writeFileSync(join(dir, 'driver.mjs'), 'tampered\n');
      const trustedHead = git(['rev-parse', 'HEAD']).trim();
      git(['reset', '--hard', 'HEAD']);
      expect(existsSync(sentinel)).toBe(true);
      expect(git(['rev-parse', 'HEAD']).trim()).toBe(trustedHead);

      // The fix: discard the metadata, so checkout rebuilds it from nothing.
      rmSync(sentinel, { force: true });
      execFileSync('bash', ['-c', recreate.run], {
        env: {
          ...process.env,
          GITHUB_WORKSPACE: dir,
          RUNNER_TEMP: runnerTemp,
          GITHUB_ENV: githubEnv,
          GITHUB_OUTPUT: join(dir, 'gh_output'),
          RM_BIN: resolvedBin('rm'),
          SYSTEM_PATH: resolvedBinDir('rm'),
          MKTEMP_BIN: resolvedBin('mktemp'),
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(existsSync(join(dir, '.git'))).toBe(false);
      expect(existsSync(sentinel)).toBe(false);

      // Rebuilt metadata carries no filter, so the next reset is inert.
      git(['init', '-q']);
      let leaked = 'unset';
      try {
        leaked = git(['config', '--get', 'filter.evil.smudge']).trim();
      } catch {
        leaked = '';
      }
      expect(leaked).toBe('');
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasTimeoutCommand)(
    'behaviorally proves a wedged docker daemon cannot hang the preflight',
    () => {
      // A daemon that accepts the call and never answers is worse than an
      // absent one: the preflight runs before the scan, so neither the resolve
      // nor the classifier step cap applies, and even an empty-candidate round
      // would hold the serialized patrol for the whole job budget.
      const guard = yml.jobs.classify.steps[0];
      expect(guard.run).toContain('"${timeout}" 10 "${docker}" info');
      expect(guard['timeout-minutes']).toBeLessThanOrEqual(2);
      const dir = mkdtempSync(join(tmpdir(), 'patrol-wedged-'));
      const wroot = join(dir, 'bin');
      mkdirSync(wroot);
      for (const tool of ['rm', 'git', 'mktemp', 'gh', 'node']) {
        writeFileSync(join(wroot, tool), '#!/bin/sh\nexit 0\n');
        chmodSync(join(wroot, tool), 0o755);
      }
      // The real timeout must wrap the wedged docker, so give the guard a root
      // whose timeout is the genuine binary and whose docker never answers.
      writeFileSync(
        join(wroot, 'timeout'),
        '#!/bin/sh\nexec /usr/bin/timeout "$@"\n',
      );
      chmodSync(join(wroot, 'timeout'), 0o755);
      writeFileSync(join(wroot, 'docker'), '#!/bin/sh\nsleep 60\n');
      chmodSync(join(wroot, 'docker'), 0o755);
      writeFileSync(join(dir, 'gh_output'), '');
      const stub = join(dir, 'docker');
      writeFileSync(stub, '#!/bin/sh\nsleep 60\n');
      chmodSync(stub, 0o755);
      const started = Date.now();
      let status = 0;
      try {
        execFileSync('bash', ['-c', guard.run], {
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            RUNNER_ENVIRONMENT: 'github-hosted',
            RUNNER_NAME: 'hosted',
            // Point the probe at the wedged stub. Without this the guard would
            // fail instantly on an empty command name and the elapsed-time
            // assertion below would pass without any timeout ever firing.
            SANDBOX_COMMAND: join(wroot, 'docker'),
            PATROL_BIN_ROOTS: wroot,
            GITHUB_OUTPUT: join(dir, 'gh_output'),
            DOCKER_HOST: guard.env.DOCKER_HOST,
            DOCKER_CONTEXT: guard.env.DOCKER_CONTEXT,
          },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30000,
        });
      } catch (e) {
        status = e.status ?? -1;
      }
      const elapsed = Date.now() - started;
      rmSync(dir, { recursive: true, force: true });
      expect(status).not.toBe(0);
      // Both bounds matter: the upper one proves the probe is not unbounded,
      // the lower one proves it really waited for the ten-second timeout
      // instead of failing immediately for an unrelated reason.
      expect(elapsed).toBeGreaterThan(9000);
      expect(elapsed).toBeLessThan(25000);
    },
  );

  it('pins a captured PATH for every step that resolves a command with a token', () => {
    // This pool runs untrusted fork CI at the same uid and the workflow itself
    // writes a PATH directory, so a co-located job can plant `gh` or `node`.
    // The allowlist decides which host runs the job; it says nothing about
    // which binary a credential-bearing step then executes.
    // Only classify consumes a captured PATH (the docker recheck, Ensure Qwen
    // Code and the classifier). act's credential steps invoke absolute binaries
    // and read no PATH, so it has no capture step — requiring one there pinned a
    // no-op and, worse, a comment telling maintainers that act's PAT steps
    // resolve node by name when they do not.
    const classify = yml.jobs.classify;
    const names = classify.steps.map((step) => step.name);
    const stage = classify.steps.find((step) => step.id === 'stage');
    expect(stage).toBeTruthy();
    expect(names.indexOf('Capture trusted PATH')).toBeGreaterThan(
      names.indexOf('Set up Node.js'),
    );
    expect(yml.jobs.act.steps.some((step) => step.id === 'stage')).toBe(false);
    // Builtins only: the capture must resolve no command word itself. The pool
    // leads with the verified directories; hosted keeps the post-setup-node PATH
    // so the toolchain npm (writable prefix) still wins there — leading with the
    // root-owned system prefix would fail Ensure Qwen Code's global install.
    const stageLines = stage.run
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'));
    expect(stageLines).toEqual([
      'if [ ! -f "${GITHUB_OUTPUT}" ]; then',
      'echo "::error::step output file is not a regular file; refusing to append to it."',
      'exit 1',
      'fi',
      'if [ "${RUNNER_ENVIRONMENT}" = \'self-hosted\' ]; then',
      'echo "trusted_path=${SYSTEM_PATH}:${PATH}" >> "${GITHUB_OUTPUT}"',
      'else',
      'echo "trusted_path=${PATH}" >> "${GITHUB_OUTPUT}"',
      'fi',
    ]);
    // Both uncapped-before steps now carry a cap: a planted FIFO at
    // $GITHUB_OUTPUT would otherwise block them until the JOB cap and the round
    // would conclude cancelled, skipping the verdict step entirely.
    const identity = classify.steps.find((step) => step.id === 'identity');
    for (const step of [stage, identity]) {
      expect(step['timeout-minutes'], step.id).toBeGreaterThan(0);
      expect(step['timeout-minutes'], step.id).toBeLessThanOrEqual(2);
    }
    expect(stage.env.SYSTEM_PATH).toBe(
      '${{ steps.guard.outputs.system_path }}',
    );
    expect(stage.env.RUNNER_ENVIRONMENT).toBe('${{ runner.environment }}');
    for (const job of [yml.jobs.classify, yml.jobs.act]) {
      // Every step that runs a command AFTER the capture, whether or not it
      // holds a token: validate runs `node` with no credential, but a planted
      // node there could rewrite the driver that act then runs with the PAT.
      // Steps before the capture (guard, Git rebuild) cannot use it yet.
      // Credential-bearing steps must invoke the guard's verified absolute
      // binaries, not a bare name and not a PATH export: the directories ON the
      // captured PATH are themselves uid-writable on this pool, so pinning the
      // string does not pin the binary.
      const patSteps = job.steps.filter((step) =>
        /CI_BOT_PAT|github\.token/.test(JSON.stringify(step.env ?? {})),
      );
      expect(patSteps.length).toBeGreaterThan(0);
      for (const step of patSteps) {
        expect(step.env.GH_BIN).toBe('${{ steps.guard.outputs.gh }}');
        // Strip comments first, as the stage assertion above does: a
        // commented-out pin still contains the substring, so asserting against
        // the raw body would let someone disable the reroute channel and keep
        // this gate green.
        const code = step.run
          .split('\n')
          .filter((l) => !l.trim().startsWith('#'))
          .join('\n');
        // gh's own reroute channel, independent of PATH.
        expect(code).toContain('export GH_HOST=github.com');
        expect(code).toContain('unset GH_ENTERPRISE_TOKEN GH_TOKEN');
        // Not a minted dir: one under the uid-writable, listable $RUNNER_TEMP
        // can be refilled between the step's gh calls, and each call re-reads
        // config.yml. Pin the non-creatable path and forbid the mint.
        expect(code).toContain("GH_CONFIG_DIR='/nonexistent/patrol-gh-config'");
        expect(code).toContain('export GH_CONFIG_DIR');
        expect(code).not.toContain('mktemp');
        expect(code).not.toContain('RUNNER_TEMP');
        expect(step.env.MKTEMP_BIN).toBeUndefined();
        // Scoped to the steps that actually spawn the driver: GhClient falls
        // back to `process.env.PATROL_GH || 'gh'`, so dropping that pin makes
        // the spawn resolve a bare name on a PATH whose tail is plantable —
        // with CI_BOT_PAT in the environment. NODE_BIN decides which
        // interpreter runs the driver at all. The "no bare node" loop below
        // cannot see either, because it rewrites ${NODE_BIN:?} before matching.
        // identity also holds the PAT but spawns no driver and has neither key.
        if (/ci-flaky-rerun\.mjs/.test(code)) {
          expect(step.env.PATROL_GH, `${job.name}/${step.name}`).toBe(
            '${{ steps.guard.outputs.gh }}',
          );
          expect(step.env.NODE_BIN, `${job.name}/${step.name}`).toBe(
            '${{ steps.guard.outputs.node }}',
          );
        }
      }
      // Every node invocation in the job goes through the verified path.
      for (const step of job.steps) {
        if (typeof step.run !== 'string') continue;
        // Only steps that actually execute the driver or a node -e/-p payload.
        // The guard's own candidate loop names `node` as a tool label, which is
        // not an invocation.
        const code = step.run
          .split('\n')
          .filter((l) => !l.trim().startsWith('#'))
          .join('\n')
          .replace(/\$\{NODE_BIN:\?\}/g, 'VERIFIED_NODE');
        expect(
          /(^|[\s"'])node\s+(-e|-p|\.)/.test(code),
          `${job.name} / ${step.name} invokes a bare node`,
        ).toBe(false);
      }
    }
  });

  it('behaviorally proves a planted gh never receives the bot token', () => {
    const identity = yml.jobs.classify.steps.find(
      (step) => step.id === 'identity',
    );
    const root = mkdtempSync(join(tmpdir(), 'patrol-path-'));
    const planted = join(root, 'planted');
    const trusted = join(root, 'trusted');
    mkdirSync(planted);
    mkdirSync(trusted);
    const leaked = join(root, 'LEAKED');
    const invoked = join(root, 'TRUSTED-INVOKED');
    // Both stubs are named gh; only their directory differs. The planted one
    // exfiltrates whatever token it is handed, the trusted one just answers.
    writeFileSync(
      join(planted, 'gh'),
      `#!/bin/sh\nprintf '%s' "\${GH_TOKEN:-}" > '${leaked}'\necho planted-bot\n`,
    );
    writeFileSync(
      join(trusted, 'gh'),
      `#!/bin/sh\necho invoked > '${invoked}'\necho real-bot\n`,
    );
    for (const dir of [planted, trusted]) chmodSync(join(dir, 'gh'), 0o755);
    const outFile = join(root, 'gh_output');
    writeFileSync(outFile, '');
    // RUNNER_TEMP gets its own scratch dir so the step's footprint in it is
    // observable: a minted config dir would appear here, and a co-tenant could
    // refill it between the step's gh calls.
    const runnerTemp = join(root, 'runner-temp');
    mkdirSync(runnerTemp);
    let status = 0;
    let output = '';
    try {
      output = execFileSync('bash', ['-c', identity.run], {
        env: {
          ...process.env,
          // The planted directory wins an ambient PATH lookup.
          PATH: `${planted}:${trusted}:${process.env.PATH}`,
          // The ownership arms are pool policy; without this the step would
          // take the hosted exemption and actually invoke the fixture stub.
          RUNNER_ENVIRONMENT: 'self-hosted',
          GH_BIN: join(trusted, 'gh'),
          // Deliberately still supplied even though the step no longer reads
          // it: if the workflow regressed to minting a config dir, that mint
          // must be able to SUCCEED here, or the footprint assertion below
          // would pass for the wrong reason.
          MKTEMP_BIN: resolvedBin('mktemp'),
          GITHUB_TOKEN: 'SENTINEL-PAT-VALUE',
          GITHUB_OUTPUT: outFile,
          RUNNER_TEMP: runnerTemp,
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      status = e.status;
      output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    try {
      // The security property: the planted gh never receives the token. The
      // point-of-use recheck refuses even the "trusted" fixture stub, because
      // a same-uid fixture cannot produce a binary the job uid does not own —
      // so the step exits before ANY gh runs. That is a stronger outcome than
      // the old "trusted stub was invoked" control, and it is the one the
      // ownership rule actually guarantees.
      expect(existsSync(leaked)).toBe(false);
      expect(status).not.toBe(0);
      expect(output).toContain('point of use');
      // The step must leave nothing behind in the uid-writable temp dir: no
      // minted config dir means no pre-plant and no post-mint refill target.
      expect(readdirSync(runnerTemp)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('behaviorally refuses a forged guard output before the binary is invoked', () => {
    // Pin the MODEL, not the next channel: the published path arrives through
    // $GITHUB_OUTPUT, so a consumer must re-verify it where it is used. A
    // forged node= pointing at a uid-owned file must fail fast, before exec,
    // with the PAT still unspent.
    const scan = yml.jobs.classify.steps.find((step) => step.id === 'scan');
    const root = mkdtempSync(join(tmpdir(), 'patrol-forged-'));
    const evil = join(root, 'node');
    const ran = join(root, 'EVIL-RAN');
    writeFileSync(evil, `#!/bin/sh\ntouch '${ran}'\n`);
    chmodSync(evil, 0o755);
    try {
      let status = 0;
      let output = '';
      try {
        output = execFileSync('bash', ['-c', scan.run], {
          env: {
            ...process.env,
            // Every declared name is supplied, and the pool policy is on, so
            // the OWNERSHIP arm is what refuses. Leaving one blank would make
            // this pass on the empty-value check instead — a green that says
            // nothing about the forged path.
            RUNNER_ENVIRONMENT: 'self-hosted',
            NODE_BIN: evil,
            GH_BIN: evil,
            PATROL_GH: evil,
            RM_BIN: evil,
            MKDIR_BIN: evil,
            GREP_BIN: evil,
            GITHUB_TOKEN: 'SENTINEL-PAT-VALUE',
            GITHUB_OUTPUT: join(root, 'out'),
            RUNNER_TEMP: root,
            WORKDIR: root,
          },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        status = e.status;
        output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
      }
      expect(status).not.toBe(0);
      // Name the arm: "is not a verified binary" is the ownership/writability
      // refusal, "is not an executable" is the empty/missing one.
      expect(output).toContain('NODE_BIN is not a verified binary');
      // Refused BEFORE the exec: the forged binary never ran.
      expect(existsSync(ran)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('behaviorally proves a re-planted repository config cannot run during checkout', () => {
    // The reset deletes .git and actions/checkout re-creates it, so the
    // REPOSITORY scope is reachable even with both file scopes neutralised.
    // GIT_CONFIG_* env entries outrank it. Positive control first: with only
    // the file scopes pinned, the planted hook DOES fire — otherwise the
    // second arm would pass vacuously.
    const checkout = yml.jobs.classify.steps.find(
      (step) => step.id === 'checkout',
    );
    const root = mkdtempSync(join(tmpdir(), 'patrol-repocfg-'));
    const ws = join(root, 'workspace');
    const hooks = join(root, 'hooks');
    mkdirSync(ws);
    mkdirSync(hooks);
    const fired = join(root, 'HOOK-FIRED');
    writeFileSync(
      join(hooks, 'post-checkout'),
      `#!/bin/sh\ntouch '${fired}'\n`,
    );
    chmodSync(join(hooks, 'post-checkout'), 0o755);
    const git = (args, env) =>
      execFileSync('git', args, {
        cwd: ws,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
      });
    try {
      git(['init', '-q', '.']);
      git(['config', 'user.email', 't@e']);
      git(['config', 'user.name', 't']);
      writeFileSync(join(ws, 'a'), 'a\n');
      git(['add', 'a']);
      git(['commit', '-qm', 'init']);
      // Plant the repository-scope config the reset cannot reach.
      git(['config', 'core.hooksPath', hooks]);

      const fileScopesOnly = {
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_COUNT: '0',
        GIT_CONFIG_PARAMETERS: '',
      };
      git(['checkout', '--force', '-q', 'HEAD'], fileScopesOnly);
      expect(existsSync(fired)).toBe(true); // positive control

      rmSync(fired);
      // Now apply exactly what the checkout step pins.
      const pinned = {
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_PARAMETERS: '',
        GIT_CONFIG_COUNT: checkout.env.GIT_CONFIG_COUNT,
        GIT_CONFIG_KEY_0: checkout.env.GIT_CONFIG_KEY_0,
        GIT_CONFIG_VALUE_0: checkout.env.GIT_CONFIG_VALUE_0,
        GIT_CONFIG_KEY_1: checkout.env.GIT_CONFIG_KEY_1,
        GIT_CONFIG_VALUE_1: checkout.env.GIT_CONFIG_VALUE_1,
      };
      git(['checkout', '--force', '-q', 'HEAD'], pinned);
      expect(existsSync(fired)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('neutralises the global and system Git config, not just the repository', () => {
    // Deleting the repository's .git does not touch ~/.gitconfig, and a
    // core.hooksPath planted there fires during the very checkout this step
    // exists to make trustworthy — rewriting the driver before act runs it
    // with the PAT.
    for (const job of [yml.jobs.classify, yml.jobs.act]) {
      const rebuild = job.steps.find(
        (step) => step.name === 'Recreate runner Git metadata',
      );
      expect(rebuild.run).toContain(
        '"${RM_BIN:?}" -rf -- "$GITHUB_WORKSPACE/.git"',
      );
      expect(rebuild.env.RM_BIN).toBe('${{ steps.guard.outputs.rm }}');
      // /dev/null, not a minted file. An unguessable name does not protect a
      // LISTABLE one: $RUNNER_TEMP is enumerable and same-uid writable, so a
      // co-tenant can list it, match the minted name and refill the config
      // before git reads it (0600 does not stop the same uid). /dev/null is
      // root-owned, reads as empty and offers nothing to race.
      expect(rebuild.env.MKTEMP_BIN).toBeUndefined();
      expect(rebuild.run).not.toContain('patrol-empty-gitconfig');
      expect(rebuild.run).not.toContain('mktemp');
      expect(rebuild.run).toContain('echo "gitconfig=/dev/null"');
      for (const scope of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
        expect(rebuild.run).toContain(
          `echo "${scope}=/dev/null" >> "\${GITHUB_ENV}"`,
        );
      }
      const checkout = job.steps.find((step) => step.id === 'checkout');
      // Step env too: it outranks the appendable $GITHUB_ENV copy, and this is
      // the step whose own git invocation the planted config would reach.
      expect(checkout.env.GIT_CONFIG_GLOBAL).toBe(
        '${{ steps.gitmeta.outputs.gitconfig }}',
      );
      expect(checkout.env.GIT_CONFIG_SYSTEM).toBe(
        '${{ steps.gitmeta.outputs.gitconfig }}',
      );
      // git layers env-provided config ABOVE both file scopes, so neutralising
      // the files alone leaves core.hooksPath reachable through $GITHUB_ENV.
      // Step env, not $GITHUB_ENV: the runner takes the last duplicated key.
      // Env config outranks the repository scope, which the reset cannot
      // reach: it deletes .git and actions/checkout re-creates it, so a
      // re-planted .git/config would otherwise run fsmonitor / post-checkout.
      expect(checkout.env.GIT_CONFIG_COUNT).toBe('2');
      expect(checkout.env.GIT_CONFIG_KEY_0).toBe('core.hooksPath');
      expect(checkout.env.GIT_CONFIG_VALUE_0).toBe('/dev/null');
      expect(checkout.env.GIT_CONFIG_KEY_1).toBe('core.fsmonitor');
      expect(checkout.env.GIT_CONFIG_VALUE_1).toBe('false');
      expect(checkout.env.GIT_CONFIG_PARAMETERS).toBe('');
      expect(checkout.env.GIT_EXEC_PATH).toBe('');
      expect(checkout.env.GIT_TEMPLATE_DIR).toBe('/dev/null');
      expect(checkout.env.GIT_DIR).toBe('${{ github.workspace }}/.git');
      expect(checkout.env.GIT_WORK_TREE).toBe('${{ github.workspace }}');
      // checkout spawns git by name, so it gets only verified directories.
      expect(checkout.env.PATH).toBe('${{ steps.guard.outputs.system_path }}');
    }
  });

  it('behaviorally proves a planted global hooksPath cannot fire during checkout', () => {
    const rebuild = yml.jobs.classify.steps.find(
      (step) => step.name === 'Recreate runner Git metadata',
    );
    const root = mkdtempSync(join(tmpdir(), 'patrol-hooks-'));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    const runnerTemp = join(root, 'runner-temp');
    const hooks = join(root, 'hooks');
    for (const dir of [home, workspace, runnerTemp, hooks]) mkdirSync(dir);
    const sentinel = join(root, 'HOOK-FIRED');
    const envFile = join(root, 'gh_env');
    writeFileSync(sentinel, '');
    rmSync(sentinel);
    writeFileSync(envFile, '');
    writeFileSync(
      join(hooks, 'post-checkout'),
      `#!/bin/sh\ntouch '${sentinel}'\n`,
    );
    chmodSync(join(hooks, 'post-checkout'), 0o755);
    writeFileSync(
      join(home, '.gitconfig'),
      `[core]\n\thooksPath = ${hooks}\n[user]\n\tname = t\n\temail = t@e\n`,
    );
    // The release runner appends GIT_CONFIG_GLOBAL=<empty file> to
    // $GITHUB_ENV before `npm run test:scripts`, and that outranks
    // $HOME/.gitconfig. Reproduce the ambient on every lane so the pin below
    // is load-bearing here too, not only on a release run.
    const releaseGitConfig = join(root, 'release-gitconfig');
    writeFileSync(releaseGitConfig, '');
    const releaseAmbient = {
      GIT_CONFIG_GLOBAL: releaseGitConfig,
      GIT_CONFIG_COUNT: '0',
      GIT_CONFIG_PARAMETERS: '',
    };
    // Pin the global file back to the planted config so the positive control
    // still exercises the hooksPath the fixture wrote.
    const fixtureGitConfig = {
      GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    };
    const git = (args, env) =>
      execFileSync('git', args, {
        cwd: workspace,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...releaseAmbient,
          HOME: home,
          ...fixtureGitConfig,
          ...env,
        },
      });
    const seed = () => {
      git(['init', '-q']);
      writeFileSync(join(workspace, 'driver.mjs'), 'trusted driver\n');
      git(['add', '.']);
      // Identity via -c, not the planted config: removing the pin must fail
      // the positive control below, not this commit.
      git([
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@e',
        'commit',
        '-qm',
        'seed',
      ]);
    };
    try {
      seed();
      // Positive control: with the planted global config in force, an ordinary
      // force-checkout fires the hook. If this stops firing the fixture is
      // dead and the assertion below would pass vacuously.
      git(['checkout', '--force', 'HEAD']);
      expect(existsSync(sentinel)).toBe(true);

      rmSync(sentinel);
      const stepEnv = {
        ...process.env,
        HOME: home,
        GITHUB_WORKSPACE: workspace,
        RUNNER_TEMP: runnerTemp,
        GITHUB_ENV: envFile,
        GITHUB_OUTPUT: join(root, 'gh_output'),
        RM_BIN: resolvedBin('rm'),
        SYSTEM_PATH: resolvedBinDir('rm'),
      };
      execFileSync('bash', ['-c', rebuild.run], {
        env: stepEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // Apply exactly what the step exported, as the runner would.
      const exported = {};
      for (const line of readFileSync(envFile, 'utf8').split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) exported[line.slice(0, eq)] = line.slice(eq + 1);
      }
      // /dev/null exactly: a minted file in enumerable, same-uid-writable
      // $RUNNER_TEMP can be listed and refilled before git reads it, which is
      // the attack the positive control above demonstrates.
      expect(exported.GIT_CONFIG_GLOBAL).toBe('/dev/null');
      expect(exported.GIT_CONFIG_SYSTEM).toBe('/dev/null');
      expect(existsSync(join(workspace, '.git'))).toBe(false);

      seed();
      git(['checkout', '--force', 'HEAD'], exported);
      expect(existsSync(sentinel)).toBe(false);
      expect(readFileSync(join(workspace, 'driver.mjs'), 'utf8')).toBe(
        'trusted driver\n',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('pins the interpreter absolutely, because the guard cannot verify it', () => {
    // The runner chooses the interpreter BEFORE the guard's first line, so a
    // `bash` an earlier job left in a writable PATH directory would run with
    // CI_BOT_PAT already in its environment and enforce the guard's published
    // absolutes itself. Probed on ecs-qwen-hk3-26: /usr/bin/bash is root 755,
    // not a symlink, in a root-owned non-writable directory.
    expect(yml.defaults.run.shell).toBe(
      '/usr/bin/bash --noprofile --norc -e -o pipefail {0}',
    );
    const interpreter = yml.defaults.run.shell.split(' ')[0];
    expect(interpreter.startsWith('/')).toBe(true);
    expect(
      yml.jobs.classify.steps[0].env.PATROL_BIN_ROOTS.split(' '),
    ).toContain(interpreter.replace(/\/[^/]+$/, ''));
    // A per-step `shell:` would reopen the same entrance.
    for (const job of Object.values(yml.jobs)) {
      for (const step of job.steps ?? []) {
        if (step.run)
          expect(step.shell, `${job.name}/${step.name}`).toBeUndefined();
      }
    }
  });

  it('behaviorally keeps the hosted fallback alive while the pool arms stay closed', () => {
    // R8-1: the guard's hosted branch exists for exactly one shape — a host
    // whose only node is the uid-owned tool-cache copy — and the point-of-use
    // recheck used to refuse that copy unconditionally, aborting every hosted
    // round at Scan and turning MAINTAINER_ECS_RUNNER_DISABLED into an outage.
    // Feed the REAL guard's published paths into the REAL recheck and require
    // both verdicts: hosted accepts, self-hosted still refuses.
    const guard = yml.jobs.classify.steps[0];
    const scan = yml.jobs.classify.steps.find((step) => step.id === 'scan');
    const root = mkdtempSync(join(tmpdir(), 'patrol-hosted-'));
    const toolchain = join(root, 'toolchain');
    const noSystemTools = join(root, 'no-system-tools');
    mkdirSync(toolchain);
    mkdirSync(noSystemTools);
    try {
      // Stubs, not copies: the guard only stats these (and execs timeout and
      // docker), so the fixture needs no root-owned toolset and no gh on the
      // developer host. readlink must be real — the guard invokes it.
      for (const tool of ['rm', 'git', 'gh', 'node', 'mkdir', 'grep']) {
        writeFileSync(join(toolchain, tool), '#!/bin/sh\nexit 0\n');
        chmodSync(join(toolchain, tool), 0o755);
      }
      copyFileSync(resolvedBin('readlink'), join(toolchain, 'readlink'));
      chmodSync(join(toolchain, 'readlink'), 0o755);
      writeFileSync(
        join(toolchain, 'timeout'),
        '#!/bin/sh\nshift\nexec "$@"\n',
      );
      chmodSync(join(toolchain, 'timeout'), 0o755);
      writeFileSync(join(toolchain, 'docker'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(toolchain, 'docker'), 0o755);
      const outFile = join(root, 'out');
      writeFileSync(outFile, '');
      const guardEnv = {
        ...process.env,
        PATH: `${toolchain}:${process.env.PATH}`,
        PATROL_BIN_ROOTS: noSystemTools,
        SANDBOX_COMMAND: join(toolchain, 'docker'),
        GITHUB_OUTPUT: outFile,
        RUNNER_ENVIRONMENT: 'github-hosted',
        RUNNER_NAME: 'hosted-probe',
        DOCKER_HOST: guard.env.DOCKER_HOST,
        DOCKER_CONTEXT: guard.env.DOCKER_CONTEXT,
      };
      const guarded = runBody(guard.run, guardEnv);
      expect(guarded.status, guarded.out).toBe(0);
      const published = readOutputs(outFile);
      // The hosted branch really did publish the ambient, uid-owned copy.
      expect(published.node).toBe(join(toolchain, 'node'));
      expect(published.gh).toBe(join(toolchain, 'gh'));
      const loop = recheckLoop(scan);
      const bins = {
        NODE_BIN: published.node,
        GH_BIN: published.gh,
        PATROL_GH: published.gh,
        RM_BIN: published.rm,
        MKDIR_BIN: published.mkdir,
        GREP_BIN: published.grep,
      };
      const hosted = runBody(loop, {
        ...bins,
        RUNNER_ENVIRONMENT: 'github-hosted',
      });
      expect(hosted.status, hosted.out).toBe(0);
      const pool = runBody(loop, {
        ...bins,
        RUNNER_ENVIRONMENT: 'self-hosted',
      });
      expect(pool.status).toBe(1);
      expect(pool.out).toContain('NODE_BIN is not a verified binary');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('behaviorally refuses a blank guard output instead of skipping it', () => {
    // PATROL_GH='' turns the driver back into `process.env.PATROL_GH || 'gh'`,
    // a bare-name spawn on the plantable PATH — the exact thing this PR removes.
    // The old loop opened with `[ -n "${p}" ] || continue`, so a forged blank
    // walked straight through. Hosted here on purpose: the ownership arms must
    // not be able to supply the refusal for the wrong reason.
    const scan = yml.jobs.classify.steps.find((step) => step.id === 'scan');
    const loop = recheckLoop(scan);
    const node = resolvedBin('node');
    const bins = {
      RUNNER_ENVIRONMENT: 'github-hosted',
      NODE_BIN: node,
      GH_BIN: node,
      RM_BIN: node,
      MKDIR_BIN: node,
      GREP_BIN: node,
    };
    const blank = runBody(loop, { ...bins, PATROL_GH: '' });
    expect(blank.status).toBe(1);
    expect(blank.out).toContain('PATROL_GH is not an executable');
    // Positive control: the same fixture with the name populated passes, so the
    // refusal above is about the blank and not about the fixture.
    const populated = runBody(loop, { ...bins, PATROL_GH: node });
    expect(populated.status, populated.out).toBe(0);
  });

  it('rechecks exactly the guard-published binaries each step declares', () => {
    // The loops used to list five names in every step, including steps that
    // declare only one — so the `[ -n ] || continue` skip was load-bearing and
    // a blank in a name the step DOES use went unchecked. Bind the list to the
    // step's own env so the two cannot drift apart again.
    let checked = 0;
    for (const job of Object.values(yml.jobs)) {
      for (const step of job.steps ?? []) {
        if (
          !step.run ||
          !step.run.split('\n').some((l) => l.startsWith('for v in '))
        ) {
          continue;
        }
        checked += 1;
        const listed = recheckLoop(step)
          .split('\n')[0]
          .replace(/^for v in /, '')
          .replace(/; do$/, '')
          .split(/\s+/)
          .sort();
        const declared = Object.keys(step.env ?? {})
          .filter((k) => k.endsWith('_BIN') || k === 'PATROL_GH')
          .sort();
        expect(listed, `${job.name}/${step.name}`).toEqual(declared);
        expect(declared.length, `${job.name}/${step.name}`).toBeGreaterThan(0);
        // The exemption must come from expression context, not $GITHUB_ENV.
        expect(step.env.RUNNER_ENVIRONMENT, `${job.name}/${step.name}`).toBe(
          '${{ runner.environment }}',
        );
      }
    }
    // Exact, not a floor: a floor one below the real count lets a whole loop
    // be deleted without this noticing.
    expect(checked).toBe(8);
  });

  it('behaviorally refuses a forged system_path component before checkout uses it', () => {
    // checkout consumes system_path as its entire PATH, and the string arrives
    // through the same appendable $GITHUB_OUTPUT as the binaries. One forged
    // component would hand actions/checkout's bare `git` to a plant.
    const gitmeta = yml.jobs.classify.steps.find(
      (step) => step.id === 'gitmeta',
    );
    const root = mkdtempSync(join(tmpdir(), 'patrol-syspath-'));
    const plant = join(root, 'plant');
    const workspace = join(root, 'workspace');
    mkdirSync(plant);
    mkdirSync(workspace);
    const outFile = join(root, 'out');
    const envFile = join(root, 'env');
    const base = {
      GITHUB_WORKSPACE: workspace,
      GITHUB_OUTPUT: outFile,
      GITHUB_ENV: envFile,
      RM_BIN: resolvedBin('rm'),
    };
    const seedGitDir = () => {
      mkdirSync(join(workspace, '.git'), { recursive: true });
      writeFileSync(join(workspace, '.git', 'config'), 'planted\n');
    };
    try {
      // Positive control: a verified component passes and the reset happens.
      seedGitDir();
      writeFileSync(outFile, '');
      writeFileSync(envFile, '');
      const ok = runBody(gitmeta.run, {
        ...base,
        SYSTEM_PATH: resolvedBinDir('rm'),
      });
      expect(ok.status, ok.out).toBe(0);
      expect(existsSync(join(workspace, '.git'))).toBe(false);

      // Forged: a uid-writable directory ahead of the verified one. The refusal
      // must land BEFORE the destructive reset, not after it.
      seedGitDir();
      const forged = runBody(gitmeta.run, {
        ...base,
        SYSTEM_PATH: `${plant}:${resolvedBinDir('rm')}`,
      });
      expect(forged.status).toBe(1);
      expect(forged.out).toContain('is not a verified directory');
      expect(existsSync(join(workspace, '.git'))).toBe(true);

      const empty = runBody(gitmeta.run, { ...base, SYSTEM_PATH: '' });
      expect(empty.status).toBe(1);
      expect(empty.out).toContain('system_path is empty');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('behaviorally refuses a planted qwen instead of publishing its version', () => {
    // R7-1: `command -v qwen` decided whether to install and `qwen --version`
    // became the pin the classifier installs and runs with the model's keys.
    // The predicate must see the resolved absolute, not the bare name.
    const ensure = yml.jobs.classify.steps.find(
      (step) => step.id === 'ensure_qwen',
    );
    const root = mkdtempSync(join(tmpdir(), 'patrol-qwen-'));
    const plant = join(root, 'plant');
    const toolchain = join(root, 'toolchain');
    mkdirSync(plant);
    mkdirSync(toolchain);
    const outFile = join(root, 'out');
    try {
      writeFileSync(join(plant, 'qwen'), '#!/bin/sh\necho 6.6.6\n');
      chmodSync(join(plant, 'qwen'), 0o755);
      writeFileSync(join(toolchain, 'npm'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(toolchain, 'npm'), 0o755);
      const base = {
        TRUSTED_PATH: `${plant}:${toolchain}`,
        READLINK_BIN: resolvedBin('readlink'),
        GITHUB_OUTPUT: outFile,
      };
      writeFileSync(outFile, '');
      const pool = runBody(ensure.run, {
        ...base,
        RUNNER_ENVIRONMENT: 'self-hosted',
      });
      expect(pool.status).not.toBe(0);
      // Name the tool. The whole-step run refuses at `npm` first (the stub is
      // uid-owned too), so a generic "can write or own" assertion would pass
      // without the qwen predicate ever being reached.
      expect(pool.out).toContain('npm resolves to');
      // The planted version never became the classifier's pin.
      expect(readOutputs(outFile).version).toBeUndefined();

      // Drive the REAL predicate on qwen alone, so the refusal under test is
      // about qwen and not about whichever tool the step happens to hit first.
      const fnStart = ensure.run.indexOf('verify_on_path() {');
      // The YAML block scalar strips the step's indentation, so the closing
      // brace sits at column 0 of the parsed body.
      const fnEnd = ensure.run.indexOf('\n}', fnStart);
      expect(fnStart).toBeGreaterThanOrEqual(0);
      expect(fnEnd).toBeGreaterThan(fnStart);
      const predicate = ensure.run.slice(fnStart, fnEnd + '\n}'.length);
      const qwenOnly = runBody(`${predicate}\nverify_on_path qwen >/dev/null`, {
        PATH: `${plant}:${toolchain}:${process.env.PATH}`,
        READLINK_BIN: resolvedBin('readlink'),
        RUNNER_ENVIRONMENT: 'self-hosted',
      });
      expect(qwenOnly.status).not.toBe(0);
      expect(qwenOnly.out).toContain('qwen resolves to');
      expect(qwenOnly.out).toContain('which the job uid can write or own');
      // Positive control for the isolated predicate: hosted accepts the same
      // plant and returns its path.
      const qwenHosted = runBody(`${predicate}\nverify_on_path qwen`, {
        PATH: `${plant}:${toolchain}:${process.env.PATH}`,
        READLINK_BIN: resolvedBin('readlink'),
        RUNNER_ENVIRONMENT: 'github-hosted',
      });
      expect(qwenHosted.status, qwenHosted.out).toBe(0);
      expect(qwenHosted.out.trim()).toBe(join(plant, 'qwen'));

      // Positive control: hosted is exempt by policy, so the same fixture runs
      // the planted copy and publishes its version. That proves the refusal
      // above came from the predicate and not from a broken fixture.
      writeFileSync(outFile, '');
      const hosted = runBody(ensure.run, {
        ...base,
        RUNNER_ENVIRONMENT: 'github-hosted',
      });
      expect(hosted.status, hosted.out).toBe(0);
      expect(readOutputs(outFile).version).toBe('6.6.6');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('pins the pre-body loader and egress channels on every node/gh consumer', () => {
    // These take effect before the step body's first line, so a check inside
    // the body cannot see them. scan and Resolve sandbox image used to carry
    // none of them while exec'ing node.
    const classify = yml.jobs.classify;
    const act = yml.jobs.act;
    const nodeConsumers = [
      classify.steps.find((s) => s.id === 'identity'),
      classify.steps.find((s) => s.id === 'scan'),
      classify.steps.find((s) => s.id === 'sandbox_image'),
      classify.steps.find((s) => s.id === 'decisions'),
      act.steps.find((s) => s.name === 'Act on patrol decisions'),
      act.steps.find((s) => s.name === 'Reset successful failure state'),
    ];
    for (const step of nodeConsumers) {
      for (const key of [
        'BASH_ENV',
        'SHELLOPTS',
        'LD_PRELOAD',
        'LD_AUDIT',
        'LD_LIBRARY_PATH',
        'NODE_OPTIONS',
      ]) {
        expect(step.env[key], `${step.name}.${key}`).toBe('');
      }
    }
    // gh's egress and trust store are independent of PATH and GH_CONFIG_DIR: a
    // residue proxy receives the Authorization header and a residue CA file
    // makes its certificate trusted. Probed unset on the pool, so pinning them
    // empty costs no egress.
    for (const step of nodeConsumers.filter(
      (s) => s.env.PATROL_GH || s.env.GH_BIN,
    )) {
      for (const key of [
        'HTTPS_PROXY',
        'HTTP_PROXY',
        'SSL_CERT_FILE',
        'SSL_CERT_DIR',
        'NODE_EXTRA_CA_CERTS',
      ]) {
        expect(step.env[key], `${step.name}.${key}`).toBe('');
      }
      // GitHub env keys are case-INSENSITIVE, so the lowercase variants cannot
      // sit beside the uppercase ones — actionlint rejects the file outright
      // ("key https_proxy is duplicated in env section"). They are read by gh
      // at exec time rather than by bash at startup, so the body closes them.
      expect(step.env.https_proxy, `${step.name}.https_proxy`).toBeUndefined();
      expect(step.env.http_proxy, `${step.name}.http_proxy`).toBeUndefined();
      expect(step.run, `${step.name} unsets lowercase proxies`).toContain(
        'unset https_proxy http_proxy',
      );
    }
  });

  it.skipIf(!hasNpmCommand)(
    'behaviorally loads npm config under the ensure-step pins and ignores a residue npmrc',
    () => {
      // R9-25: pinning BOTH npm scopes to /dev/null makes npm abort with
      // `double-loading config "/dev/null" as "global", previously loaded as
      // "user"` — even `npm --version` exits 1. The install branch is the whole
      // hosted fallback, so the structural pin alone certified a dead path.
      // This runs the real npm under the step's own env values.
      const ensure = yml.jobs.classify.steps.find(
        (s) => s.id === 'ensure_qwen',
      );
      // Capability-gated by it.skipIf above, so a host without npm reports a
      // SKIP rather than a green that never ran the assertion.
      const npmBin = resolvedBin('npm');
      const root = mkdtempSync(join(tmpdir(), 'patrol-npm-'));
      const home = join(root, 'home');
      mkdirSync(home);
      writeFileSync(
        join(home, '.npmrc'),
        'registry=https://attacker.invalid/\n',
      );
      // `npx vitest` runs under npm, which injects 13 npm_config_* variables into
      // this process — including registry, userconfig and globalconfig. Spreading
      // them overrides HOME-based resolution and makes the positive control pass
      // vacuously. The runner injects none of them, so scrub them all and apply
      // only what the step itself declares.
      const base = Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !/^npm_config/i.test(k)),
      );
      const npmRun = (extra) => {
        try {
          const out = execFileSync(
            'bash',
            ['-c', `"${npmBin}" config get registry`],
            {
              // Neutral cwd on purpose: this repository ships its own .npmrc
              // pinning registry.npmjs.org, and npm layers PROJECT config above
              // USER config — running from the repo would mask the residue and
              // make the positive control pass for the wrong reason.
              cwd: root,
              env: { ...base, HOME: home, ...extra },
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          );
          return { status: 0, out };
        } catch (e) {
          return {
            status: e.status,
            out: `${e.stdout ?? ''}${e.stderr ?? ''}`,
          };
        }
      };
      try {
        // Positive control: without the pins the residue file IS honoured, so
        // the threat this step pins against is real and the fixture reaches it.
        const unpinned = npmRun({});
        expect(unpinned.status, unpinned.out).toBe(0);
        expect(unpinned.out).toContain('https://attacker.invalid/');

        const pinned = npmRun({
          npm_config_userconfig: ensure.env.npm_config_userconfig,
          npm_config_globalconfig: ensure.env.npm_config_globalconfig,
        });
        // Exit 0 is the load-bearing half: the old pins abort here.
        expect(pinned.status, pinned.out).toBe(0);
        expect(pinned.out).not.toContain('attacker.invalid');
        expect(pinned.out).not.toContain('double-loading config');
        expect(pinned.out.trim()).toMatch(/^https:\/\/\S+$/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('has no case-insensitive duplicate keys in any env section', () => {
    // GitHub treats env keys case-insensitively, so `HTTPS_PROXY` and
    // `https_proxy` in one block are a duplicate that actionlint rejects and
    // the whole Lint & Static lane reds on. A plain YAML parse does NOT see it
    // (the keys differ as strings), which is how it reached CI. Walk the AST so
    // this is caught locally without depending on actionlint being installed.
    const doc = parseDocument(workflow);
    expect(doc.errors).toEqual([]);
    const offenders = [];
    let envBlocks = 0;
    // yaml 2.x nodes are class instances (YAMLMap/YAMLSeq/Pair) with no `type`
    // field — a `node.type === 'MAP'` test is silently always false and makes
    // this whole check vacuous. Use the library's own guards.
    const visit = (node, parentKey) => {
      if (isMap(node)) {
        if (parentKey === 'env') {
          envBlocks += 1;
          const seen = new Map();
          for (const pair of node.items) {
            const key = String(pair.key?.value ?? '');
            const lower = key.toLowerCase();
            if (seen.has(lower)) {
              offenders.push(`${key} duplicates ${seen.get(lower)}`);
            }
            seen.set(lower, key);
          }
        }
        for (const pair of node.items) {
          visit(pair.value, String(pair.key?.value ?? ''));
        }
      } else if (isSeq(node)) {
        for (const item of node.items) visit(item, parentKey);
      }
    };
    visit(doc.contents, null);
    // Non-vacuity: the walk must actually reach the env blocks it judges.
    expect(envBlocks).toBeGreaterThanOrEqual(15);
    expect(offenders).toEqual([]);
  });
});
