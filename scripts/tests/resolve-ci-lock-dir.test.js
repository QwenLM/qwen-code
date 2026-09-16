/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// Executes the CI lock-dir resolver and the docker branch of the E2E runner
// against a poisoned ${HOME}/.cache/qwen-code-ci, so the #12006 fallback is
// witnessed by bash rather than by shape assertions alone. Bash-driven, so it
// is excluded from the Windows lanes in vitest.config.ts.
//
// Run 35069321648 failed the docker leg's 'Run E2E tests' and 'Prune dangling
// docker images' steps in under a second each: a root-owned leftover lock
// file fails `exec 9>` with EACCES, and the heal step's chown chain needs a
// passwordless sudo the pool runner does not have. The permission probes only
// bite for a non-root user (root bypasses file mode bits), so those cases
// skip under uid 0.
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('CI docker lock dir resolution', () => {
  const runnerScript = readFileSync('.github/scripts/run-e2e-tests.sh', 'utf8');

  function makeWorld() {
    const dir = mkdtempSync(join(tmpdir(), 'qwen-ci-lock-'));
    const home = join(dir, 'home');
    const runnerTemp = join(dir, 'rt');
    const bin = join(dir, 'bin');
    mkdirSync(home, { recursive: true });
    mkdirSync(runnerTemp, { recursive: true });
    mkdirSync(bin, { recursive: true });
    return { dir, home, runnerTemp, bin };
  }

  function runResolver(world, lockNames = [], extraEnv = {}) {
    // stderr carries the ::warning:: fallback notice; keep it separate from
    // the stdout payload the callers capture with $(...).
    const result = spawnSync(
      'bash',
      ['.github/scripts/resolve-ci-lock-dir.sh', ...lockNames],
      {
        env: {
          PATH: process.env.PATH,
          HOME: world.home,
          RUNNER_TEMP: world.runnerTemp,
          ...extraEnv,
        },
        encoding: 'utf8',
      },
    );
    expect(result.status, result.stderr).toBe(0);
    return result;
  }

  it('prefers the shared host dir when it is writable', () => {
    const world = makeWorld();
    try {
      const result = runResolver(world);
      expect(result.stdout.trim()).toBe(
        join(world.home, '.cache', 'qwen-code-ci'),
      );
      expect(result.stderr).toBe('');
      expect(existsSync(result.stdout.trim())).toBe(true);
    } finally {
      rmSync(world.dir, { recursive: true, force: true });
    }
  });

  it.skipIf(isRoot)(
    'falls back to a job-private dir when a lock file is not writable',
    () => {
      const world = makeWorld();
      try {
        const shared = join(world.home, '.cache', 'qwen-code-ci');
        mkdirSync(shared, { recursive: true });
        const daemonLock = join(shared, 'docker-sandbox-daemon.lock');
        writeFileSync(daemonLock, '');
        chmodSync(daemonLock, 0o400);
        const result = runResolver(world, ['docker-sandbox-daemon.lock']);
        const fallback = join(world.runnerTemp, 'qwen-code-ci-locks');
        expect(result.stdout.trim()).toBe(fallback);
        expect(result.stderr).toContain('::warning::');
        expect(result.stderr).toContain('job-private');
        // The warning must name the offending file: a hardcoded cause (an
        // unhealed root-owned leftover) sends the next debugger at the heal
        // step when the poison can be a lock of any family, of any owner.
        expect(result.stderr).toContain('docker-sandbox-daemon.lock');
        expect(existsSync(fallback)).toBe(true);
      } finally {
        rmSync(world.dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(isRoot)('ignores an unwritable lock the caller never opens', () => {
    const world = makeWorld();
    try {
      const shared = join(world.home, '.cache', 'qwen-code-ci');
      mkdirSync(shared, { recursive: true });
      // sdk-java.yml writes its lock into this same directory from a
      // plain runner-side step, so it is runner-owned and nothing heals
      // it away — but the docker leg never opens it, so it must not veto
      // a shared dir that is usable for the leg's own files.
      const foreignLock = join(shared, 'sdk-java-tests.lock');
      writeFileSync(foreignLock, '');
      chmodSync(foreignLock, 0o400);
      const result = runResolver(world, [
        'docker-sandbox-daemon.lock',
        'docker-sandbox-build.lock',
        'docker-sandbox-build-e2e-testsha12006.lock',
      ]);
      expect(result.stdout.trim()).toBe(shared);
      expect(result.stderr).toBe('');
    } finally {
      rmSync(world.dir, { recursive: true, force: true });
    }
  });

  // The `cannot create` cause is the only probe message that distinguishes
  // an unwritable $HOME, a .cache that is a regular file, ENOSPC and EROFS
  // from the unwritable-dir and unwritable-lock causes pinned above — and
  // it is the only signal an operator gets on a pool host, so the message
  // itself is pinned, not just the branch.
  it('names the cause when the shared dir cannot be created', () => {
    const world = makeWorld();
    try {
      // HOME under a regular file fails `mkdir -p` with ENOTDIR for root
      // too, so this case needs no isRoot skip.
      const notADir = join(world.dir, 'not-a-dir');
      writeFileSync(notADir, '');
      const result = runResolver({ ...world, home: join(notADir, 'home') });
      expect(result.stdout.trim()).toBe(
        join(world.runnerTemp, 'qwen-code-ci-locks'),
      );
      expect(result.stderr).toContain('cannot create');
    } finally {
      rmSync(world.dir, { recursive: true, force: true });
    }
  });

  // The prune step, the host cleanup timer and the release lane all
  // coordinate on the shared daemon-lock path, so a poisoned BUILD-family
  // lock must not move the daemon lock off it.
  it.skipIf(isRoot)(
    'resolves the daemon lock to the shared dir when only a build lock is poisoned',
    () => {
      const world = makeWorld();
      try {
        const shared = join(world.home, '.cache', 'qwen-code-ci');
        mkdirSync(shared, { recursive: true });
        const buildLock = join(shared, 'docker-sandbox-build.lock');
        writeFileSync(buildLock, '');
        chmodSync(buildLock, 0o400);
        const result = runResolver(world, ['docker-sandbox-daemon.lock']);
        expect(result.stdout.trim()).toBe(shared);
        expect(result.stderr).toBe('');
      } finally {
        rmSync(world.dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(isRoot)(
    'falls back when the shared dir itself is not writable',
    () => {
      const world = makeWorld();
      try {
        const shared = join(world.home, '.cache', 'qwen-code-ci');
        mkdirSync(shared, { recursive: true });
        chmodSync(shared, 0o555);
        const result = runResolver(world);
        expect(result.stdout.trim()).toBe(
          join(world.runnerTemp, 'qwen-code-ci-locks'),
        );
      } finally {
        rmSync(world.dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(isRoot)(
    'reports the fallback on the step summary when one is set',
    () => {
      const world = makeWorld();
      try {
        const shared = join(world.home, '.cache', 'qwen-code-ci');
        mkdirSync(shared, { recursive: true });
        chmodSync(shared, 0o555);
        const summary = join(world.dir, 'summary.md');
        writeFileSync(summary, '');
        const result = runResolver(world, [], {
          GITHUB_STEP_SUMMARY: summary,
        });
        expect(result.stdout.trim()).toBe(
          join(world.runnerTemp, 'qwen-code-ci-locks'),
        );
        // The ::warning:: lands in a step log nobody opens on a pool host;
        // the degraded coordination must also land on the run page.
        const content = readFileSync(summary, 'utf8');
        expect(content).toContain('lock-dir fallback');
        expect(content).toContain(shared);
        expect(content).toContain(join(world.runnerTemp, 'qwen-code-ci-locks'));
      } finally {
        rmSync(world.dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(isRoot)(
    'fails loudly when the job-private fallback cannot be created',
    () => {
      const world = makeWorld();
      try {
        const shared = join(world.home, '.cache', 'qwen-code-ci');
        mkdirSync(shared, { recursive: true });
        chmodSync(shared, 0o555);
        // RUNNER_TEMP under a regular file: `mkdir -p` can never create it
        // (an ENOSPC pool host reads the same way to the script).
        const notADir = join(world.dir, 'not-a-dir');
        writeFileSync(notADir, '');
        const result = spawnSync(
          'bash',
          ['.github/scripts/resolve-ci-lock-dir.sh'],
          {
            env: {
              PATH: process.env.PATH,
              HOME: world.home,
              RUNNER_TEMP: join(notADir, 'rt'),
            },
            encoding: 'utf8',
          },
        );
        expect(result.status).toBe(1);
        // Both callers capture stdout with $(...), so the failure must
        // print nothing there: a half-written path on stdout is the #12006
        // silent death again, now on a directory that does not exist.
        expect(result.stdout.trim()).toBe('');
        expect(result.stderr).toContain('::error::');
      } finally {
        rmSync(world.dir, { recursive: true, force: true });
      }
    },
  );

  function runDockerLeg(world, { imagePresent = true, home, runnerTemp } = {}) {
    const dockerStub = join(world.bin, 'docker');
    writeFileSync(
      dockerStub,
      [
        '#!/usr/bin/env bash',
        'case "$*" in',
        '  *"image inspect --format"*) echo "sha256:fake"; exit 0;;',
        `  "image inspect "*) exit ${imagePresent ? 0 : 1};;`,
        '  "ps -aq"*) exit 0;;',
        'esac',
        'exit 0',
      ].join('\n'),
    );
    chmodSync(dockerStub, 0o755);
    const npxStub = join(world.bin, 'npx');
    writeFileSync(
      npxStub,
      ['#!/usr/bin/env bash', 'echo "STUB npx $*"', 'exit 0'].join('\n'),
    );
    chmodSync(npxStub, 0o755);
    // flock(1) is util-linux and absent on macOS; these cases witness
    // lock-DIR resolution, not lock semantics, so a pass-through stub keeps
    // them portable.
    const flockStub = join(world.bin, 'flock');
    writeFileSync(flockStub, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(flockStub, 0o755);
    // npm runs only on the image-build path; stub it so a case exercising
    // that path stays hermetic.
    const npmStub = join(world.bin, 'npm');
    writeFileSync(npmStub, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(npmStub, 0o755);
    const scriptFile = join(world.dir, 'run-e2e-tests.sh');
    writeFileSync(scriptFile, runnerScript);
    const result = spawnSync('bash', [scriptFile, 'sandbox:docker', '1/1'], {
      env: {
        PATH: `${world.bin}:${process.env.PATH}`,
        HOME: home ?? world.home,
        RUNNER_TEMP: runnerTemp ?? world.runnerTemp,
        RUNNER_ENVIRONMENT: 'self-hosted',
        GITHUB_SHA: 'testsha12006',
        E2E_CONTAINER_OWNER: 'test-owner',
      },
      encoding: 'utf8',
    });
    return {
      exitCode: result.status ?? 1,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    };
  }

  it('runs the docker leg on the shared lock dir when it is writable', () => {
    const world = makeWorld();
    try {
      const { exitCode, output } = runDockerLeg(world);
      expect(exitCode).toBe(0);
      expect(output).not.toContain('job-private');
      expect(
        existsSync(
          join(
            world.home,
            '.cache',
            'qwen-code-ci',
            'docker-sandbox-daemon.lock',
          ),
        ),
      ).toBe(true);
    } finally {
      rmSync(world.dir, { recursive: true, force: true });
    }
  });

  // The #12006 reproduction: with a lock file the runner cannot open, the
  // pre-fix script died at `exec 9>` before a test ran (exit 1, EACCES);
  // the resolver must route the leg to the job-private dir instead.
  it.skipIf(isRoot)(
    'keeps the docker leg green when the shared lock file is not writable',
    () => {
      const world = makeWorld();
      try {
        const shared = join(world.home, '.cache', 'qwen-code-ci');
        mkdirSync(shared, { recursive: true });
        const daemonLock = join(shared, 'docker-sandbox-daemon.lock');
        writeFileSync(daemonLock, '');
        chmodSync(daemonLock, 0o400);
        const { exitCode, output } = runDockerLeg(world);
        expect(exitCode).toBe(0);
        expect(output).toContain('job-private');
        expect(
          existsSync(
            join(
              world.runnerTemp,
              'qwen-code-ci-locks',
              'docker-sandbox-daemon.lock',
            ),
          ),
        ).toBe(true);
      } finally {
        rmSync(world.dir, { recursive: true, force: true });
      }
    },
  );

  // The shared-DIRECTORY form of #12006: with the dir itself unwritable,
  // all three locks — daemon, per-commit coordinator, and build mutex —
  // must open under the job-private dir. The build mutex only opens on the
  // image-build path, so the docker stub reports the image absent.
  it.skipIf(isRoot)(
    'keeps the docker leg green when the shared directory is not writable',
    () => {
      const world = makeWorld();
      try {
        const shared = join(world.home, '.cache', 'qwen-code-ci');
        mkdirSync(shared, { recursive: true });
        chmodSync(shared, 0o555);
        const { exitCode, output } = runDockerLeg(world, {
          imagePresent: false,
        });
        expect(exitCode).toBe(0);
        expect(output).toContain('job-private');
        const fallback = join(world.runnerTemp, 'qwen-code-ci-locks');
        for (const name of [
          'docker-sandbox-daemon.lock',
          'docker-sandbox-build.lock',
          'docker-sandbox-build-e2e-testsha12006.lock',
        ]) {
          expect(existsSync(join(fallback, name)), name).toBe(true);
        }
      } finally {
        rmSync(world.dir, { recursive: true, force: true });
      }
    },
  );

  // The leg resolves the daemon lock independently of the build-family
  // locks: with only docker-sandbox-build.lock poisoned, the daemon lock
  // must stay on the shared dir (the prune step, the host cleanup timer
  // and the release lane all hardcode that path) while the build locks
  // fall back. The build mutex only opens on the image-build path, so the
  // docker stub reports the image absent.
  it.skipIf(isRoot)(
    'keeps the daemon lock shared when only a build lock is poisoned',
    () => {
      const world = makeWorld();
      try {
        const shared = join(world.home, '.cache', 'qwen-code-ci');
        mkdirSync(shared, { recursive: true });
        const buildLock = join(shared, 'docker-sandbox-build.lock');
        writeFileSync(buildLock, '');
        chmodSync(buildLock, 0o400);
        const { exitCode } = runDockerLeg(world, { imagePresent: false });
        expect(exitCode).toBe(0);
        expect(existsSync(join(shared, 'docker-sandbox-daemon.lock'))).toBe(
          true,
        );
        const fallback = join(world.runnerTemp, 'qwen-code-ci-locks');
        expect(existsSync(join(fallback, 'docker-sandbox-daemon.lock'))).toBe(
          false,
        );
        for (const name of [
          'docker-sandbox-build.lock',
          'docker-sandbox-build-e2e-testsha12006.lock',
        ]) {
          expect(existsSync(join(fallback, name)), name).toBe(true);
        }
      } finally {
        rmSync(world.dir, { recursive: true, force: true });
      }
    },
  );

  // The 127 softening belongs to the prune step only: when NO lock
  // directory can be created the leg genuinely cannot run, and it must die
  // loudly. A silent `|| ci_lock_dir=''` fallthrough would instead route
  // `exec 9>` to a daemon lock at the filesystem root — a path nothing else
  // on the host coordinates on.
  it('fails loudly when no lock directory can be created', () => {
    const world = makeWorld();
    try {
      // ENOTDIR poisoning (a regular file in the path), not a mode bit:
      // `mkdir -p` fails it for root too, so this case needs no isRoot skip.
      const notADir = join(world.dir, 'not-a-dir');
      writeFileSync(notADir, '');
      const { exitCode, output } = runDockerLeg(world, {
        home: join(notADir, 'home'),
        runnerTemp: join(notADir, 'rt'),
      });
      expect(exitCode).not.toBe(0);
      expect(output).toContain('::error::');
      // The failure must come from the resolver, before any lock opens.
      expect(output).not.toContain('/docker-sandbox-daemon.lock');
    } finally {
      rmSync(world.dir, { recursive: true, force: true });
    }
  });

  describe('prune step daemon lock discipline', () => {
    // Drives the real 'Prune dangling docker images' step body from e2e.yml
    // under `bash -e` (GitHub's default shell for run steps) with stubbed
    // docker and flock. The step resolves the resolver by repo-relative
    // path, so the cwd decides whether the resolver is on disk.
    const e2eYml = parse(readFileSync('.github/workflows/e2e.yml', 'utf8'));
    const pruneRun = e2eYml.jobs['e2e-test-linux'].steps.find(
      (step) => step.name === 'Prune dangling docker images',
    ).run;

    function runPruneStep(world, { withResolver }) {
      writeFileSync(
        join(world.bin, 'docker'),
        [
          '#!/usr/bin/env bash',
          'printf "%s\\n" "$*" >> "${DOCKER_LOG}"',
          'exit 0',
        ].join('\n'),
      );
      chmodSync(join(world.bin, 'docker'), 0o755);
      // flock(1) is util-linux and absent on macOS. The witness here is
      // WHERE the step locks — asserted through the file `exec 9>` creates,
      // which a flock stub cannot see portably — not lock semantics.
      writeFileSync(join(world.bin, 'flock'), '#!/usr/bin/env bash\nexit 0\n');
      chmodSync(join(world.bin, 'flock'), 0o755);
      const cwd = join(world.dir, 'cwd');
      mkdirSync(cwd, { recursive: true });
      if (withResolver) {
        const scriptsDir = join(cwd, '.github', 'scripts');
        mkdirSync(scriptsDir, { recursive: true });
        writeFileSync(
          join(scriptsDir, 'resolve-ci-lock-dir.sh'),
          readFileSync('.github/scripts/resolve-ci-lock-dir.sh', 'utf8'),
        );
      }
      const dockerLog = join(world.dir, 'docker.log');
      const stepFile = join(world.dir, 'prune-step.sh');
      writeFileSync(stepFile, pruneRun);
      const result = spawnSync('bash', ['-e', stepFile], {
        cwd,
        env: {
          PATH: `${world.bin}:${process.env.PATH}`,
          HOME: world.home,
          RUNNER_TEMP: world.runnerTemp,
          DOCKER_LOG: dockerLog,
        },
        encoding: 'utf8',
      });
      return {
        exitCode: result.status ?? 1,
        output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
        dockerArgv: existsSync(dockerLog)
          ? readFileSync(dockerLog, 'utf8')
          : '',
      };
    }

    it('locks the shared dir and prunes when the resolver itself cannot run', () => {
      const world = makeWorld();
      try {
        const { exitCode, dockerArgv } = runPruneStep(world, {
          withResolver: false,
        });
        expect(exitCode).toBe(0);
        const shared = join(world.home, '.cache', 'qwen-code-ci');
        expect(existsSync(join(shared, 'docker-sandbox-daemon.lock'))).toBe(
          true,
        );
        expect(dockerArgv).toContain('image prune --all');
      } finally {
        rmSync(world.dir, { recursive: true, force: true });
      }
    });

    it.skipIf(isRoot)(
      'skips the labelled prune when the shared dir is poisoned',
      () => {
        const world = makeWorld();
        try {
          const shared = join(world.home, '.cache', 'qwen-code-ci');
          mkdirSync(shared, { recursive: true });
          chmodSync(shared, 0o555);
          const { exitCode, output, dockerArgv } = runPruneStep(world, {
            withResolver: true,
          });
          expect(exitCode).toBe(0);
          expect(output).toContain('Docker cleanup skipped');
          // The resolver returns the job-private fallback here; only the
          // dangling prune (which needs no exclusion) may still run.
          expect(dockerArgv).not.toContain('image prune --all');
          expect(dockerArgv).toContain('image prune --force');
        } finally {
          rmSync(world.dir, { recursive: true, force: true });
        }
      },
    );
  });
});
