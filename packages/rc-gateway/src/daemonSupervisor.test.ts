/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { startStubDaemon, type StubDaemon } from './testing/stubDaemon.js';
import { startDaemon, buildServeArgs } from './daemonSupervisor.js';

let stub: StubDaemon | undefined;
afterEach(async () => {
  if (stub) await stub.close();
  stub = undefined;
});

describe('daemonSupervisor', () => {
  it('builds serve args with the flags the daemon actually accepts', () => {
    const args = buildServeArgs(4180);
    // The daemon defines --hostname (not --host) and validates with strict yargs.
    expect(args).toContain('--hostname');
    expect(args).not.toContain('--host');
    expect(args).toContain('--require-auth');
    const portIdx = args.indexOf('--port');
    expect(portIdx).toBeGreaterThanOrEqual(0);
    expect(args[portIdx + 1]).toBe('4180');
    expect(args[0]).toBe('serve');
  });

  it('waits for health then returns a usable DaemonClient', async () => {
    stub = await startStubDaemon();
    const stubUrl = stub.baseUrl;
    let killed = false;
    const handle = await startDaemon({
      // Injected spawner: ignore the real CLI, point at the stub.
      spawner: () => ({
        baseUrl: stubUrl,
        token: undefined,
        kill: () => {
          killed = true;
        },
      }),
    });
    const health = await handle.daemon.health();
    expect(health.status).toBe('ok');
    expect(handle.attached).toBe(false);
    await handle.stop();
    expect(killed).toBe(true);
  });

  it('attach mode: shares an existing daemon, never spawns, and stop() does not kill it', async () => {
    stub = await startStubDaemon();
    let spawnerCalled = false;
    const handle = await startDaemon({
      attach: { url: stub.baseUrl, token: 'shared-token' },
      // A spawner that would flag if (wrongly) invoked in attach mode.
      spawner: () => {
        spawnerCalled = true;
        throw new Error('spawner must not run in attach mode');
      },
    });
    expect(spawnerCalled).toBe(false);
    expect(handle.attached).toBe(true);
    expect((await handle.daemon.health()).status).toBe('ok');
    // stop() is a no-op: the externally-managed daemon stays reachable.
    await handle.stop();
    expect((await handle.daemon.health()).status).toBe('ok');
  });

  it('attach mode: throws (without spawning) when the daemon is unreachable', async () => {
    await expect(
      startDaemon({
        attach: { url: 'http://127.0.0.1:1', token: 't' },
        readyTimeoutMs: 150,
      }),
    ).rejects.toThrow(/Could not reach the daemon/);
  });
});
