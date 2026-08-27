/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getLiveDiscoveryPath,
  handoffLiveDiscoveryOwner,
  LiveDiscoveryOwnerActiveError,
  LiveDiscoveryStateError,
  removeLiveDiscoveryFile,
  writeLiveDiscoveryFile,
  type LiveDiscoveryRecord,
} from './discovery.js';
import { LIVE_HOST_PROTOCOL_VERSION } from './types.js';

const temporaryDirectories: string[] = [];

async function temporaryRuntime(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-live-'));
  temporaryDirectories.push(directory);
  return directory;
}

function record(instanceNonce: string, pid = process.pid): LiveDiscoveryRecord {
  return {
    url: 'http://127.0.0.1:3210',
    token: 'not-a-real-token',
    protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
    pid,
    instanceNonce,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('Live discovery file', () => {
  it('publishes an atomic mode-0600 record below the runtime directory', async () => {
    const runtime = await temporaryRuntime();
    const expected = record('daemon_instance_nonce_0001');

    const writtenPath = await writeLiveDiscoveryFile(runtime, expected);

    expect(writtenPath).toBe(getLiveDiscoveryPath(runtime));
    expect(JSON.parse(await fs.readFile(writtenPath, 'utf8'))).toEqual(
      expected,
    );
    expect((await fs.stat(writtenPath)).mode & 0o777).toBe(0o600);
    expect(
      (await fs.readdir(path.dirname(writtenPath))).filter((name) =>
        name.endsWith('.tmp'),
      ),
    ).toEqual([]);
  });

  it('safely creates a missing nested runtime directory tree', async () => {
    const parent = await temporaryRuntime();
    const runtime = path.join(parent, 'nested', 'runtime', 'base');
    const expected = record('daemon_instance_nonce_nested_01');

    await expect(writeLiveDiscoveryFile(runtime, expected)).resolves.toBe(
      getLiveDiscoveryPath(runtime),
    );
    await expect(
      fs.readFile(getLiveDiscoveryPath(runtime), 'utf8'),
    ).resolves.toContain(expected.instanceNonce);
    if (process.platform !== 'win32') {
      expect(
        (await fs.stat(path.dirname(getLiveDiscoveryPath(runtime)))).mode &
          0o777,
      ).toBe(0o700);
    }
  });

  it('rejects a symlinked runtime base without publishing through it', async () => {
    if (process.platform === 'win32') return;
    const parent = await temporaryRuntime();
    const target = path.join(parent, 'target');
    const runtimeBaseDir = path.join(parent, 'runtime-link');
    await fs.mkdir(target, { mode: 0o700 });
    await fs.symlink(target, runtimeBaseDir);

    await expect(
      writeLiveDiscoveryFile(
        runtimeBaseDir,
        record('daemon_instance_nonce_symlink_01'),
      ),
    ).rejects.toBeInstanceOf(LiveDiscoveryStateError);
    await expect(fs.readdir(target)).resolves.toEqual([]);
  });

  it('rejects an unsafe discovery lock shape without replacing it', async () => {
    const runtime = await temporaryRuntime();
    const discoveryDirectory = path.dirname(getLiveDiscoveryPath(runtime));
    const lockPath = path.join(discoveryDirectory, '.daemon.lock');
    await fs.mkdir(discoveryDirectory, { mode: 0o700 });
    await fs.writeFile(lockPath, 'unsafe', { mode: 0o600 });

    await expect(
      writeLiveDiscoveryFile(
        runtime,
        record('daemon_instance_nonce_unsafe_lock_01'),
      ),
    ).rejects.toBeInstanceOf(LiveDiscoveryStateError);

    await expect(fs.readFile(lockPath, 'utf8')).resolves.toBe('unsafe');
    await expect(fs.stat(getLiveDiscoveryPath(runtime))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('only removes a record owned by the matching daemon pid and nonce', async () => {
    const runtime = await temporaryRuntime();
    const current = record('daemon_instance_nonce_0002');
    await writeLiveDiscoveryFile(runtime, current);

    await expect(
      removeLiveDiscoveryFile(runtime, {
        pid: current.pid,
        instanceNonce: 'daemon_instance_nonce_old0',
      }),
    ).rejects.toBeInstanceOf(LiveDiscoveryStateError);
    await expect(
      removeLiveDiscoveryFile(runtime, {
        pid: current.pid + 1,
        instanceNonce: current.instanceNonce,
      }),
    ).rejects.toBeInstanceOf(LiveDiscoveryStateError);
    await expect(
      fs.readFile(getLiveDiscoveryPath(runtime), 'utf8'),
    ).resolves.toContain(current.instanceNonce);

    expect(await removeLiveDiscoveryFile(runtime, current)).toBe(true);
    await expect(fs.stat(getLiveDiscoveryPath(runtime))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('allows only one concurrent healthy owner', async () => {
    const runtime = await temporaryRuntime();
    const first = record('daemon_instance_nonce_0003');
    const second = record('daemon_instance_nonce_0004');

    const results = await Promise.allSettled([
      writeLiveDiscoveryFile(runtime, first),
      writeLiveDiscoveryFile(runtime, second),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.any(LiveDiscoveryOwnerActiveError),
    });
    const published = JSON.parse(
      await fs.readFile(getLiveDiscoveryPath(runtime), 'utf8'),
    ) as LiveDiscoveryRecord;
    expect([first.instanceNonce, second.instanceNonce]).toContain(
      published.instanceNonce,
    );
  });

  it('does not publish over a stale foreign owner without a handoff', async () => {
    const runtime = await temporaryRuntime();
    const previous = record('daemon_instance_nonce_0005', 999_999);
    const replacement = record('daemon_instance_nonce_0006');
    await writeLiveDiscoveryFile(runtime, previous);

    await expect(
      writeLiveDiscoveryFile(runtime, replacement, {
        isProcessAlive: (pid) => {
          expect(pid).toBe(previous.pid);
          return false;
        },
      }),
    ).rejects.toBeInstanceOf(LiveDiscoveryStateError);
    expect(
      JSON.parse(await fs.readFile(getLiveDiscoveryPath(runtime), 'utf8')),
    ).toEqual(previous);
  });

  it('does not publish over a stale legacy-protocol owner without a handoff', async () => {
    const runtime = await temporaryRuntime();
    const discoveryPath = getLiveDiscoveryPath(runtime);
    const previous = {
      ...record('daemon_instance_nonce_legacy_01', 999_998),
      protocolVersion: 2,
    };
    const replacement = record('daemon_instance_nonce_current_01');
    await fs.mkdir(path.dirname(discoveryPath), {
      recursive: true,
      mode: 0o700,
    });
    await fs.writeFile(discoveryPath, `${JSON.stringify(previous)}\n`, {
      mode: 0o600,
    });

    await expect(
      writeLiveDiscoveryFile(runtime, replacement, {
        isProcessAlive: (pid) => {
          expect(pid).toBe(previous.pid);
          return false;
        },
      }),
    ).rejects.toBeInstanceOf(LiveDiscoveryStateError);
    expect(JSON.parse(await fs.readFile(discoveryPath, 'utf8'))).toEqual(
      previous,
    );
    expect((await fs.stat(discoveryPath)).mode & 0o777).toBe(0o600);
  });

  it.each([
    ['current', LIVE_HOST_PROTOCOL_VERSION, 999_996],
    ['legacy', 2, 999_995],
  ])(
    'reclaims a valid stale %s-protocol owner during handoff',
    async (_label, protocolVersion, pid) => {
      const runtime = await temporaryRuntime();
      const discoveryPath = getLiveDiscoveryPath(runtime);
      const previous = {
        ...record('daemon_instance_nonce_handoff_old', pid),
        protocolVersion,
      };
      const replacement = record('daemon_instance_nonce_handoff_new');
      await fs.mkdir(path.dirname(discoveryPath), {
        recursive: true,
        mode: 0o700,
      });
      await fs.writeFile(discoveryPath, `${JSON.stringify(previous)}\n`, {
        mode: 0o600,
      });
      let committed = false;
      const wait = vi.fn(async () => undefined);

      await expect(
        handoffLiveDiscoveryOwner(
          runtime,
          replacement,
          async () => {
            committed = true;
          },
          {
            wait,
            handoffGraceMs: 37,
            isProcessAlive: (ownerPid) => {
              expect(ownerPid).toBe(previous.pid);
              return false;
            },
          },
        ),
      ).resolves.toEqual({ reclaimed: true });
      expect(committed).toBe(true);
      expect(wait).toHaveBeenCalledOnce();
      expect(wait).toHaveBeenCalledWith(37);
      await expect(fs.stat(discoveryPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  it('does not replace a live owner only because its protocol is legacy', async () => {
    const runtime = await temporaryRuntime();
    const discoveryPath = getLiveDiscoveryPath(runtime);
    const previous = {
      ...record('daemon_instance_nonce_legacy_02', 999_997),
      protocolVersion: 2,
    };
    await fs.mkdir(path.dirname(discoveryPath), {
      recursive: true,
      mode: 0o700,
    });
    await fs.writeFile(discoveryPath, `${JSON.stringify(previous)}\n`, {
      mode: 0o600,
    });

    await expect(
      writeLiveDiscoveryFile(
        runtime,
        record('daemon_instance_nonce_current_02'),
        {
          isProcessAlive: (pid) => {
            expect(pid).toBe(previous.pid);
            return true;
          },
        },
      ),
    ).rejects.toBeInstanceOf(LiveDiscoveryOwnerActiveError);
    expect(JSON.parse(await fs.readFile(discoveryPath, 'utf8'))).toEqual(
      previous,
    );
  });

  it('does not overwrite an invalid existing record', async () => {
    const runtime = await temporaryRuntime();
    const discoveryPath = getLiveDiscoveryPath(runtime);
    await fs.mkdir(path.dirname(discoveryPath), { recursive: true });
    await fs.writeFile(discoveryPath, '{broken', { mode: 0o600 });

    await expect(
      writeLiveDiscoveryFile(runtime, record('daemon_instance_nonce_0007')),
    ).rejects.toThrow('Existing Live discovery record is invalid.');
    await expect(fs.readFile(discoveryPath, 'utf8')).resolves.toBe('{broken');
  });

  it('rejects non-loopback URLs and malformed nonces', async () => {
    const runtime = await temporaryRuntime();
    await expect(
      writeLiveDiscoveryFile(runtime, {
        ...record('daemon_instance_nonce_0005'),
        url: 'https://example.com',
      }),
    ).rejects.toThrow(/loopback/);
    await expect(
      writeLiveDiscoveryFile(runtime, record('short')),
    ).rejects.toThrow(/invalid/);
  });

  it('accepts concrete IPv4 loopback addresses in 127/8', async () => {
    const runtime = await temporaryRuntime();
    await expect(
      writeLiveDiscoveryFile(runtime, {
        ...record('daemon_instance_nonce_0006'),
        url: 'http://127.12.34.56:3210',
      }),
    ).resolves.toBe(getLiveDiscoveryPath(runtime));
  });
});
