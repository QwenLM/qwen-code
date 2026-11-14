/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The host identity is read once per process and cached in a module-level
// binding, so every case needs its own module instance: without the reset, the
// first case that derives an identity would answer for all the rest and the
// refusal cases below would never reach the read at all.
const loadBootstrap = async () => {
  vi.resetModules();
  return import('./managed-runtime-bootstrap.js');
};

const setPlatform = (platform: NodeJS.Platform) => {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
};

describe('SSH storage host identity', () => {
  const realPlatform = process.platform;
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'qwen-host-identity-'));
    // The storage root must be canonical, and macOS's temporary directory may
    // itself be a symlink.
    root = await (await import('node:fs/promises')).realpath(root);
  });

  afterEach(async () => {
    setPlatform(realPlatform);
    vi.doUnmock('node:fs');
    vi.doUnmock('node:child_process');
    vi.resetModules();
    await rm(root, { recursive: true, force: true });
  });

  // Read through the real filesystem except for the one host file, so the
  // canonical-root, directory and access checks in front of the read still run
  // against a real directory rather than a stub that would answer all of them.
  const mockMachineId = (
    result: { text: string } | { error: NodeJS.ErrnoException },
  ) => {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        promises: {
          ...actual.promises,
          readFile: ((file: unknown, ...rest: unknown[]) =>
            file === '/etc/machine-id'
              ? 'error' in result
                ? Promise.reject(result.error)
                : Promise.resolve(result.text)
              : (actual.promises.readFile as (...a: unknown[]) => unknown)(
                  file,
                  ...rest,
                )) as typeof actual.promises.readFile,
        },
      };
    });
  };

  const mockIoreg = (result: { text: string } | { error: Error }) => {
    vi.doMock('node:child_process', async () => {
      const actual =
        await vi.importActual<typeof import('node:child_process')>(
          'node:child_process',
        );
      return {
        ...actual,
        execFileSync: ((file: unknown, ...rest: unknown[]) => {
          if (file !== '/usr/sbin/ioreg')
            return (actual.execFileSync as (...a: unknown[]) => unknown)(
              file,
              ...rest,
            );
          if ('error' in result) throw result.error;
          return result.text;
        }) as typeof actual.execFileSync,
      };
    });
  };

  const enoent = () =>
    Object.assign(
      new Error("ENOENT: no such file or directory, open '/etc/machine-id'"),
      {
        code: 'ENOENT',
      },
    );

  // The defect this file exists for: a minimal container image ships no
  // /etc/machine-id, because systemd writes it at first boot and a container
  // never boots systemd. The read used to throw a raw ENOENT past the module's
  // own refusal, so the protocol boundary reported `ssh_runtime_state_unavailable`
  // — "state is unavailable" for a host that simply cannot prove a stable
  // identity. Eight jobs across four unrelated PRs failed this way (#16975).
  it('refuses an absent machine-id as an identity conflict, not a raw ENOENT', async () => {
    setPlatform('linux');
    mockMachineId({ error: enoent() });
    const { inspectSshStorage, SshBootstrapError } = await loadBootstrap();

    const failure = await inspectSshStorage(root).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SshBootstrapError);
    expect(failure).toMatchObject({
      code: 'ssh_runtime_identity_conflict',
      message: 'Stable host identity is unavailable.',
      retryable: false,
    });
    // The reported cause must be the refusal, not the filesystem's own text:
    // this is what the old code leaked to the caller.
    expect((failure as Error).message).not.toContain('ENOENT');
  });

  it('refuses an unreadable machine-id the same way', async () => {
    setPlatform('linux');
    mockMachineId({
      error: Object.assign(new Error('EACCES: permission denied'), {
        code: 'EACCES',
      }),
    });
    const { inspectSshStorage } = await loadBootstrap();

    await expect(inspectSshStorage(root)).rejects.toMatchObject({
      code: 'ssh_runtime_identity_conflict',
      message: 'Stable host identity is unavailable.',
    });
  });

  // A present but empty file is not an identity. systemd's documented
  // "uninitialized" state is an empty /etc/machine-id, so this is a real host
  // condition rather than a synthetic one, and it must refuse rather than HMAC
  // the empty string into a host id every such host would share.
  it('refuses an empty machine-id instead of hashing it', async () => {
    setPlatform('linux');
    mockMachineId({ text: '   \n' });
    const { inspectSshStorage } = await loadBootstrap();

    await expect(inspectSshStorage(root)).rejects.toMatchObject({
      code: 'ssh_runtime_identity_conflict',
      message: 'Stable host identity is unavailable.',
    });
  });

  // The negative control. Without it, a change that refused every read would
  // pass all three cases above while breaking every real host.
  it('derives the host id from a readable machine-id', async () => {
    setPlatform('linux');
    mockMachineId({ text: 'a'.repeat(32) + '\n' });
    const { inspectSshStorage } = await loadBootstrap();

    const identity = await inspectSshStorage(root);
    expect(identity.hostId).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.root).toBe(root);
    // Trailing whitespace is not part of the identity: the same host must
    // derive the same id whether or not the file ends in a newline.
    vi.resetModules();
    mockMachineId({ text: 'a'.repeat(32) });
    const reloaded = await loadBootstrap();
    expect((await reloaded.inspectSshStorage(root)).hostId).toBe(
      identity.hostId,
    );
  });

  // macOS reads the identity through ioreg, which can be absent, refuse to run
  // or time out. That path had the same hole and no coverage at all.
  it('refuses a failing ioreg instead of leaking its error', async () => {
    setPlatform('darwin');
    mockIoreg({
      error: Object.assign(new Error('spawnSync /usr/sbin/ioreg ENOENT'), {
        code: 'ENOENT',
      }),
    });
    const { inspectSshStorage } = await loadBootstrap();

    await expect(inspectSshStorage(root)).rejects.toMatchObject({
      code: 'ssh_runtime_identity_conflict',
      message: 'Stable host identity is unavailable.',
    });
  });

  it('refuses ioreg output that carries no platform UUID', async () => {
    setPlatform('darwin');
    mockIoreg({ text: '+-o root  <class IOPlatformExpertDevice>\n' });
    const { inspectSshStorage } = await loadBootstrap();

    await expect(inspectSshStorage(root)).rejects.toMatchObject({
      code: 'ssh_runtime_identity_conflict',
      message: 'Stable host identity is unavailable.',
    });
  });

  it('derives the host id from the platform UUID on macOS', async () => {
    setPlatform('darwin');
    mockIoreg({
      text: '    "IOPlatformUUID" = "12345678-90AB-CDEF-1234-567890ABCDEF"\n',
    });
    const { inspectSshStorage } = await loadBootstrap();

    expect((await inspectSshStorage(root)).hostId).toMatch(/^[0-9a-f]{64}$/);
  });

  // The refusal must not weaken the platform gate in front of it: an
  // unsupported platform is a different, non-retryable error, and swallowing
  // every read error must not turn it into an identity conflict.
  it('still refuses an unsupported platform with its own code', async () => {
    setPlatform('win32');
    const { inspectSshStorage } = await loadBootstrap();

    await expect(inspectSshStorage(root)).rejects.toMatchObject({
      code: 'ssh_runtime_platform_unsupported',
    });
  });
});
