/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpawnSyncReturns } from 'node:child_process';

const { commandExistsSync, spawnSync, platform } = vi.hoisted(() => ({
  commandExistsSync: vi.fn<(cmd: string) => boolean>(),
  spawnSync: vi.fn(),
  platform: vi.fn<() => string>(),
}));

vi.mock('command-exists', () => ({
  default: { sync: commandExistsSync },
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  // `default` has to carry the stub too: Node builtins are CJS, so Vite's
  // interop can resolve a named import through the default export.
  return { ...actual, default: { ...actual, spawnSync }, spawnSync };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, platform };
});

vi.mock('../utils/package.js', () => ({
  getPackageJson: vi.fn(async () => ({
    config: { sandboxImageUri: 'test-image' },
  })),
}));

const { loadSandboxConfig, resetSandboxProbeCacheForTest } = await import(
  './sandboxConfig.js'
);

/** A `spawnSync` result standing in for a runtime that answers `version`. */
function healthy(): Partial<SpawnSyncReturns<string>> {
  return { status: 0, stdout: 'Version: 99.0.0\n', stderr: '' };
}

/**
 * A runtime whose CLI is installed but cannot reach its daemon — Docker
 * Desktop stopped, or the user not in the `docker` group.
 */
function daemonDown(): Partial<SpawnSyncReturns<string>> {
  return {
    status: 1,
    stdout: '',
    stderr:
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n',
  };
}

/**
 * A runtime that exits non-zero but prints nothing — a wrapper that swallows
 * output, or a silent permission failure. The empty output is the point: it is
 * what makes the `?? synthesized message` fallback in `probeSandboxCommand`
 * load-bearing. Without that fallback the probe would return `undefined` here
 * and the broken runtime would be declared usable.
 */
function brokenSilently(): Partial<SpawnSyncReturns<string>> {
  return { status: 1, stdout: '', stderr: '' };
}

/**
 * A wedged daemon killed at the timeout: `spawnSync` reports an `error` and a
 * null status. This is the path `SANDBOX_PROBE_TIMEOUT_MS` exists for.
 */
function timedOut(): Partial<SpawnSyncReturns<string>> {
  return {
    error: new Error('spawnSync docker ETIMEDOUT'),
    status: null,
    stdout: '',
    stderr: '',
  };
}

/**
 * Route probe results per command so a test can mix healthy and broken.
 *
 * The stub validates argv and the timeout, not just the command name. Both are
 * load-bearing and neither is observable from the selection result: `version`
 * contacts the daemon while `--version` only prints the client build, so a
 * probe that drifted to `--version` would call every broken runtime healthy and
 * silently restore the original bug with the selection assertions still green.
 * The timeout is the only bound on a wedged daemon that accepts connections and
 * never answers.
 */
function probes(byCommand: Record<string, Partial<SpawnSyncReturns<string>>>) {
  spawnSync.mockImplementation(
    (cmd: string, args: string[], options: { timeout?: number }) => {
      const result = byCommand[cmd];
      if (!result) throw new Error(`unexpected probe of '${cmd}'`);
      expect(args).toEqual(['version']);
      expect(options?.timeout).toBeGreaterThan(0);
      return result;
    },
  );
}

function installed(...commands: string[]) {
  commandExistsSync.mockImplementation((cmd: string) => commands.includes(cmd));
}

describe('loadSandboxConfig sandbox command selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSandboxProbeCacheForTest();
    platform.mockReturnValue('linux');
    delete process.env['SANDBOX'];
    delete process.env['QWEN_SANDBOX'];
  });

  afterEach(() => {
    delete process.env['SANDBOX'];
    delete process.env['QWEN_SANDBOX'];
  });

  it('falls back to podman when docker is installed but its daemon is unreachable', async () => {
    installed('docker', 'podman');
    probes({ docker: daemonDown(), podman: healthy() });

    const config = await loadSandboxConfig({}, { sandbox: true });

    expect(config?.command).toBe('podman');
    // Pin the probe argument at the call site as well: `docker version` is what
    // reaches the daemon, and it is the reason the fallback fires at all.
    expect(spawnSync).toHaveBeenCalledWith(
      'docker',
      ['version'],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it('treats a non-zero exit with no output as broken and falls through', async () => {
    // Pins the `?? synthesized message` fallback: with empty output the probe
    // must still report a failure so selection moves on. Drop the fallback and
    // probeSandboxCommand returns undefined here, docker is called usable, and
    // the original bug returns with every selection assertion still green.
    installed('docker', 'podman');
    probes({ docker: brokenSilently(), podman: healthy() });

    const config = await loadSandboxConfig({}, { sandbox: true });

    expect(config?.command).toBe('podman');
  });

  it('probes each runtime once and reuses the result across calls', async () => {
    // Selection runs more than once per startup (the sandbox hop, then again
    // inside loadCliConfig), so without the cache a wedged runtime pays the
    // timeout on every pass. Two selections must probe docker only once.
    installed('docker', 'podman');
    probes({ docker: healthy() });

    await loadSandboxConfig({}, { sandbox: true });
    await loadSandboxConfig({}, { sandbox: true });

    const dockerProbes = spawnSync.mock.calls.filter(
      ([cmd]) => cmd === 'docker',
    ).length;
    expect(dockerProbes).toBe(1);
  });

  it('still prefers docker when it is usable', async () => {
    installed('docker', 'podman');
    probes({ docker: healthy(), podman: healthy() });

    const config = await loadSandboxConfig({}, { sandbox: true });

    expect(config?.command).toBe('docker');
  });

  it('names the runtime that broke when no installed runtime can run', async () => {
    installed('docker');
    probes({ docker: daemonDown() });

    await expect(loadSandboxConfig({}, { sandbox: true })).rejects.toThrow(
      /docker.*cannot run.*Cannot connect to the Docker daemon/s,
    );
  });

  it('names the first broken runtime when every installed runtime fails', async () => {
    // Pins that the error reports docker (tried first), not podman (tried
    // last). Flip `firstFailure ??=` to `=` and it would name podman with the
    // suite otherwise green, sending the user to debug the wrong daemon.
    installed('docker', 'podman');
    probes({ docker: daemonDown(), podman: daemonDown() });

    const error = await loadSandboxConfig({}, { sandbox: true }).catch(
      (e: Error) => e,
    );
    const message = (error as Error).message;

    expect(message).toContain("'docker'");
    expect(message).not.toContain("'podman'");
  });

  it('treats a failure of only control characters as broken, not usable', async () => {
    // The runtime exits non-zero but its output is nothing but escape/control
    // bytes, which strip to ''. That empty string must not read as "no
    // failure" — otherwise the broken runtime is selected, reintroducing the
    // presence-vs-liveness bug through the sanitizer.
    installed('docker', 'podman');
    probes({
      docker: { status: 1, stdout: '', stderr: '\x1b[0m\x07\n' },
      podman: healthy(),
    });

    const config = await loadSandboxConfig({}, { sandbox: true });

    expect(config?.command).toBe('podman');
  });

  it('strips ANSI and control characters from the runtime failure', async () => {
    // The runtime's stderr is interpolated into a FatalSandboxError that
    // reaches the terminal, so its escape and control bytes must not survive.
    process.env['QWEN_SANDBOX'] = 'docker';
    installed('docker');
    probes({
      docker: {
        status: 1,
        stdout: '',
        stderr: '\x1b[31mCannot connect to the daemon\x1b[0m\x07\n',
      },
    });

    const error = await loadSandboxConfig({}, {}).catch((e: Error) => e);
    const message = (error as Error).message;

    expect(message).toContain('Cannot connect to the daemon');
    expect(message).not.toContain('\x1b');
    expect(message).not.toContain('\x07');
  });

  it('surfaces the timeout error when a probe is killed at the cap', async () => {
    // Pins the `result.error` branch — the wedged-daemon path the timeout
    // exists for. Delete that branch and the throw degrades from the ETIMEDOUT
    // text to "exited with null" with the suite still green.
    process.env['QWEN_SANDBOX'] = 'docker';
    installed('docker');
    probes({ docker: timedOut() });

    await expect(loadSandboxConfig({}, {})).rejects.toThrow(/ETIMEDOUT/);
  });

  it('does not blame QWEN_SANDBOX when --sandbox enabled the auto-detect path', async () => {
    installed('docker');
    probes({ docker: daemonDown() });

    const failure = await loadSandboxConfig({}, { sandbox: true }).catch(
      (error: Error) => error,
    );

    expect((failure as Error).message).toContain("'docker' is installed");
    expect((failure as Error).message).toContain('--sandbox');
    expect((failure as Error).message).not.toContain('QWEN_SANDBOX is true');
  });

  it('says QWEN_SANDBOX is true when the env var enabled the sandbox', async () => {
    process.env['QWEN_SANDBOX'] = 'true';
    installed('docker');
    probes({ docker: daemonDown() });

    await expect(loadSandboxConfig({}, {})).rejects.toThrow(
      /QWEN_SANDBOX is true and 'docker' is installed but cannot run/,
    );
  });

  it('keeps the generic message when nothing is installed at all', async () => {
    installed();
    probes({});

    await expect(loadSandboxConfig({}, { sandbox: true })).rejects.toThrow(
      /failed to determine command for sandbox/,
    );
  });

  it('does not silently override an explicit QWEN_SANDBOX choice', async () => {
    process.env['QWEN_SANDBOX'] = 'docker';
    installed('docker', 'podman');
    probes({ docker: daemonDown(), podman: healthy() });

    await expect(loadSandboxConfig({}, {})).rejects.toThrow(
      /'docker' \(from QWEN_SANDBOX\) is installed but cannot run/,
    );
  });

  it('does not blame QWEN_SANDBOX for a command that came from --sandbox', async () => {
    installed('docker', 'podman');
    probes({ docker: daemonDown(), podman: healthy() });

    // `--sandbox docker` / `tools.sandbox` reach the same code path, so the
    // error must not point at an env var the user never set.
    const failure = await loadSandboxConfig({}, { sandbox: 'docker' }).catch(
      (error: Error) => error,
    );

    expect((failure as Error).message).toContain("'docker' is installed");
    expect((failure as Error).message).not.toContain('QWEN_SANDBOX');
  });

  it('names QWEN_SANDBOX when a missing command really did come from it', async () => {
    process.env['QWEN_SANDBOX'] = 'podman';
    installed('docker');
    probes({});

    await expect(loadSandboxConfig({}, {})).rejects.toThrow(
      /Missing sandbox command 'podman' \(from QWEN_SANDBOX\)/,
    );
  });

  it('accepts an explicit choice that is usable', async () => {
    process.env['QWEN_SANDBOX'] = 'podman';
    installed('podman');
    probes({ podman: healthy() });

    const config = await loadSandboxConfig({}, {});

    expect(config?.command).toBe('podman');
  });

  it('selects seatbelt on darwin without probing a daemon', async () => {
    platform.mockReturnValue('darwin');
    installed('sandbox-exec', 'docker');
    probes({});

    const config = await loadSandboxConfig({}, { sandbox: true });

    expect(config?.command).toBe('sandbox-exec');
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('returns undefined when the sandbox is disabled', async () => {
    installed('docker');
    probes({});

    const config = await loadSandboxConfig({}, { sandbox: false });

    expect(config).toBeUndefined();
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
