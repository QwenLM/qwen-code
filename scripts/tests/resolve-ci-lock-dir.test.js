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

  function runResolver(world) {
    // stderr carries the ::warning:: fallback notice; keep it separate from
    // the stdout payload the callers capture with $(...).
    const result = spawnSync(
      'bash',
      ['.github/scripts/resolve-ci-lock-dir.sh'],
      {
        env: {
          PATH: process.env.PATH,
          HOME: world.home,
          RUNNER_TEMP: world.runnerTemp,
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
        const result = runResolver(world);
        const fallback = join(world.runnerTemp, 'qwen-code-ci-locks');
        expect(result.stdout.trim()).toBe(fallback);
        expect(result.stderr).toContain('::warning::');
        expect(result.stderr).toContain('job-private');
        expect(existsSync(fallback)).toBe(true);
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

  function runDockerLeg(world) {
    const dockerStub = join(world.bin, 'docker');
    writeFileSync(
      dockerStub,
      [
        '#!/usr/bin/env bash',
        'case "$*" in',
        '  *"image inspect --format"*) echo "sha256:fake"; exit 0;;',
        '  "image inspect "*) exit 0;;',
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
    const scriptFile = join(world.dir, 'run-e2e-tests.sh');
    writeFileSync(scriptFile, runnerScript);
    const result = spawnSync('bash', [scriptFile, 'sandbox:docker', '1/1'], {
      env: {
        PATH: `${world.bin}:${process.env.PATH}`,
        HOME: world.home,
        RUNNER_TEMP: world.runnerTemp,
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
});
