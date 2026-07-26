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

const { loadSandboxConfig } = await import('./sandboxConfig.js');

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

/** Route probe results per command so a test can mix healthy and broken. */
function probes(byCommand: Record<string, Partial<SpawnSyncReturns<string>>>) {
  spawnSync.mockImplementation((cmd: string) => {
    const result = byCommand[cmd];
    if (!result) throw new Error(`unexpected probe of '${cmd}'`);
    return result;
  });
}

function installed(...commands: string[]) {
  commandExistsSync.mockImplementation((cmd: string) => commands.includes(cmd));
}

describe('loadSandboxConfig sandbox command selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
