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
  it('adds --workspace when a workspace cwd is given', () => {
    const args = buildServeArgs(4181, '/home/evan/projects/qwen-code');
    expect(args).toEqual([
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      '4181',
      '--require-auth',
      '--workspace',
      '/home/evan/projects/qwen-code',
    ]);
  });

  it('omits --workspace when no cwd is given (unchanged default)', () => {
    expect(buildServeArgs(4180)).not.toContain('--workspace');
  });

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

  it('stop() escalates SIGTERM → SIGKILL when the daemon ignores SIGTERM', async () => {
    // A daemon mid-turn can ignore SIGTERM; stop() must force-kill after a grace
    // period so the launcher never leaks a daemon (the Phase-3 reap path).
    stub = await startStubDaemon();
    const signals: string[] = [];
    let resolveExit: (v: { reason: string }) => void = () => {};
    const whenExited = new Promise<{ reason: string }>((r) => {
      resolveExit = r;
    });
    const handle = await startDaemon({
      stopGraceMs: 50,
      spawner: () => ({
        baseUrl: stub!.baseUrl,
        token: undefined,
        whenExited,
        // Only a SIGKILL actually ends this (simulated) process.
        kill: (sig?: string) => {
          signals.push(sig ?? 'SIGTERM');
          if (sig === 'SIGKILL') resolveExit({ reason: 'force-killed' });
        },
      }),
    });
    await handle.stop();
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('stop() does not escalate when the daemon exits promptly on SIGTERM', async () => {
    stub = await startStubDaemon();
    const signals: string[] = [];
    let resolveExit: (v: { reason: string }) => void = () => {};
    const whenExited = new Promise<{ reason: string }>((r) => {
      resolveExit = r;
    });
    const handle = await startDaemon({
      stopGraceMs: 1000,
      spawner: () => ({
        baseUrl: stub!.baseUrl,
        token: undefined,
        whenExited,
        kill: (sig?: string) => {
          signals.push(sig ?? 'SIGTERM');
          resolveExit({ reason: 'graceful' }); // exits on the first (SIGTERM) signal
        },
      }),
    });
    await handle.stop();
    expect(signals).toEqual(['SIGTERM']);
  });

  it('fails fast with the child exit reason instead of polling until timeout', async () => {
    // A spawned daemon that dies at startup must surface WHY (its exit reason),
    // not masquerade as a generic health timeout — the bug that made us
    // misdiagnose a supervisor failure as a "WSL timeout".
    const t0 = Date.now();
    await expect(
      startDaemon({
        readyTimeoutMs: 10000,
        spawner: () => ({
          baseUrl: 'http://127.0.0.1:59999', // nothing listening here
          token: undefined,
          kill: () => {},
          whenExited: Promise.resolve({
            reason: '"qwen serve" exited with code 1: untrusted workspace',
          }),
        }),
      }),
    ).rejects.toThrow(/exited with code 1.*untrusted workspace/);
    // It must NOT have burned the full 10s health budget waiting.
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('rejects a zero/ephemeral port on the real-spawn path without spawning', async () => {
    // With no injected spawner, port 0 would silently poll http://127.0.0.1:0
    // forever; convert that latent gap into an immediate, clear error.
    await expect(startDaemon({ port: 0 })).rejects.toThrow(/non-zero port/);
  });
});
