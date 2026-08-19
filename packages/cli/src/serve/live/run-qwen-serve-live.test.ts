/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetHomeEnvBootstrapForTesting } from '../../config/settings.js';
import { runQwenServe } from '../run-qwen-serve.js';
import { getLiveDiscoveryPath } from './discovery.js';
import { LIVE_HOST_PROTOCOL_VERSION } from './types.js';

const trackedWriteLiveDiscoveryFile = vi.hoisted(() => vi.fn());

vi.mock('./discovery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./discovery.js')>();
  trackedWriteLiveDiscoveryFile.mockImplementation(
    actual.writeLiveDiscoveryFile,
  );
  return {
    ...actual,
    writeLiveDiscoveryFile: trackedWriteLiveDiscoveryFile,
  };
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  trackedWriteLiveDiscoveryFile.mockClear();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('qwen serve Live Host discovery', () => {
  it('publishes the authenticated listener and removes only its own record', async () => {
    const runtime = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-serve-live-'),
    );
    temporaryDirectories.push(runtime);
    const workspace = path.join(runtime, 'workspace');
    const qwenHome = path.join(runtime, 'settings-home');
    await fs.mkdir(workspace);
    await fs.mkdir(qwenHome, { recursive: true });
    await fs.writeFile(
      path.join(qwenHome, 'settings.json'),
      JSON.stringify({
        experimental: {
          liveVoice: { enabled: true, apiKey: 'test-realtime-key' },
        },
      }),
    );
    const previousQwenHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = qwenHome;
    resetHomeEnvBootstrapForTesting();
    const token = 'integration-test-token';
    const discoveryPath = getLiveDiscoveryPath(runtime);
    let handle: Awaited<ReturnType<typeof runQwenServe>> | undefined;

    try {
      handle = await runQwenServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace,
          maxSessions: 1,
          token,
        },
        {
          preheatBridge: false,
          daemonLogBaseDir: path.join(runtime, 'debug'),
          liveDiscoveryStableBaseDir: runtime,
          runtimePlatform: 'darwin',
        },
      );

      const record = JSON.parse(
        await fs.readFile(discoveryPath, 'utf8'),
      ) as Record<string, unknown>;
      expect(record).toMatchObject({
        url: handle.url,
        token,
        protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
        pid: process.pid,
      });
      expect(record['instanceNonce']).toMatch(/^[A-Za-z0-9_-]{16,256}$/);
      expect((await fs.stat(discoveryPath)).mode & 0o777).toBe(0o600);

      const statusResponse = await fetch(`${handle.url}/live/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(statusResponse.status).toBe(200);
      expect(await statusResponse.json()).toMatchObject({
        v: 1,
        available: false,
        state: 'unavailable',
      });
      expect(
        trackedWriteLiveDiscoveryFile.mock.calls.map(([baseDir]) =>
          path.resolve(String(baseDir)),
        ),
      ).toEqual([path.resolve(runtime)]);

      const disabled = await fetch(`${handle.url}/live/setup`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ enabled: false }),
      });
      expect(disabled.status).toBe(200);
      expect(await disabled.json()).toMatchObject({ enabled: false });
      await expect(fs.stat(discoveryPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      const capabilities = await fetch(`${handle.url}/capabilities`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(
        ((await capabilities.json()) as { features: string[] }).features,
      ).not.toContain('realtime_voice');
    } finally {
      await handle?.close();
      if (previousQwenHome === undefined) delete process.env['QWEN_HOME'];
      else process.env['QWEN_HOME'] = previousQwenHome;
      resetHomeEnvBootstrapForTesting();
    }

    await expect(fs.stat(discoveryPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }, 30_000);

  it('publishes a stable Host locator alongside a custom runtime record', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-serve-live-stable-'),
    );
    temporaryDirectories.push(root);
    const runtime = path.join(root, 'custom-runtime');
    const stable = path.join(root, 'stable-qwen-home');
    const qwenHome = path.join(root, 'settings-home');
    const workspace = path.join(root, 'workspace');
    await fs.mkdir(qwenHome, { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      path.join(qwenHome, 'settings.json'),
      JSON.stringify({
        experimental: {
          liveVoice: { enabled: true, apiKey: 'test-realtime-key' },
        },
      }),
    );
    const previousQwenHome = process.env['QWEN_HOME'];
    const previousRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_HOME'] = qwenHome;
    process.env['QWEN_RUNTIME_DIR'] = runtime;
    resetHomeEnvBootstrapForTesting();
    const runtimeDiscoveryPath = getLiveDiscoveryPath(runtime);
    await fs.mkdir(path.dirname(runtimeDiscoveryPath), {
      recursive: true,
      mode: 0o700,
    });
    await fs.writeFile(
      runtimeDiscoveryPath,
      `${JSON.stringify({
        url: 'http://127.0.0.1:1',
        protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
        pid: 999_999,
        instanceNonce: 'stale_runtime_owner_nonce_0001',
      })}\n`,
      { mode: 0o600 },
    );
    let handle: Awaited<ReturnType<typeof runQwenServe>> | undefined;
    try {
      handle = await runQwenServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace,
          maxSessions: 1,
        },
        {
          preheatBridge: false,
          liveDiscoveryStableBaseDir: stable,
          runtimePlatform: 'darwin',
        },
      );

      const runtimeRecord = JSON.parse(
        await fs.readFile(getLiveDiscoveryPath(runtime), 'utf8'),
      ) as Record<string, unknown>;
      const stableRecord = JSON.parse(
        await fs.readFile(getLiveDiscoveryPath(stable), 'utf8'),
      ) as Record<string, unknown>;
      expect(runtimeRecord).toMatchObject({
        url: handle.url,
        pid: process.pid,
      });
      expect(stableRecord).toEqual(runtimeRecord);
      const writtenBaseDirs = trackedWriteLiveDiscoveryFile.mock.calls.map(
        ([baseDir]) => path.resolve(String(baseDir)),
      );
      expect(writtenBaseDirs).toEqual([
        path.resolve(runtime),
        path.resolve(stable),
      ]);
      expect(
        writtenBaseDirs.every(
          (baseDir) =>
            baseDir === path.resolve(root) ||
            baseDir.startsWith(`${path.resolve(root)}${path.sep}`),
        ),
      ).toBe(true);
    } finally {
      await handle?.close();
      if (previousQwenHome === undefined) delete process.env['QWEN_HOME'];
      else process.env['QWEN_HOME'] = previousQwenHome;
      if (previousRuntimeDir === undefined)
        delete process.env['QWEN_RUNTIME_DIR'];
      else process.env['QWEN_RUNTIME_DIR'] = previousRuntimeDir;
      resetHomeEnvBootstrapForTesting();
    }

    await expect(fs.stat(getLiveDiscoveryPath(runtime))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.stat(getLiveDiscoveryPath(stable))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }, 30_000);

  it('hands stable discovery ownership to a waiting enabled daemon', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-serve-live-handoff-'),
    );
    temporaryDirectories.push(root);
    const stable = path.join(root, 'stable-qwen-home');
    const qwenHome = path.join(root, 'settings-home');
    const workspaceOne = path.join(root, 'workspace-one');
    const workspaceTwo = path.join(root, 'workspace-two');
    const runtimeOne = path.join(root, 'runtime-one');
    const runtimeTwo = path.join(root, 'runtime-two');
    await fs.mkdir(qwenHome, { recursive: true });
    await fs.mkdir(workspaceOne, { recursive: true });
    await fs.mkdir(workspaceTwo, { recursive: true });
    await fs.writeFile(
      path.join(qwenHome, 'settings.json'),
      JSON.stringify({
        experimental: {
          liveVoice: { enabled: true, apiKey: 'test-realtime-key' },
        },
      }),
    );
    const previousQwenHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = qwenHome;
    resetHomeEnvBootstrapForTesting();
    let first: Awaited<ReturnType<typeof runQwenServe>> | undefined;
    let second: Awaited<ReturnType<typeof runQwenServe>> | undefined;
    try {
      first = await runQwenServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: workspaceOne,
          maxSessions: 1,
        },
        {
          preheatBridge: false,
          daemonLogBaseDir: path.join(runtimeOne, 'debug'),
          liveDiscoveryStableBaseDir: stable,
          liveDiscoveryRetryDelayMs: 20,
          runtimePlatform: 'darwin',
        },
      );
      second = await runQwenServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: workspaceTwo,
          maxSessions: 1,
        },
        {
          preheatBridge: false,
          daemonLogBaseDir: path.join(runtimeTwo, 'debug'),
          liveDiscoveryStableBaseDir: stable,
          liveDiscoveryRetryDelayMs: 20,
          runtimePlatform: 'darwin',
        },
      );
      const stablePath = getLiveDiscoveryPath(stable);
      expect(JSON.parse(await fs.readFile(stablePath, 'utf8'))).toMatchObject({
        url: first.url,
      });

      await first.close();
      first = undefined;

      await vi.waitFor(
        async () => {
          expect(
            JSON.parse(await fs.readFile(stablePath, 'utf8')),
          ).toMatchObject({ url: second!.url });
        },
        { timeout: 5_000, interval: 20 },
      );
      expect(
        trackedWriteLiveDiscoveryFile.mock.calls.every(([baseDir]) => {
          const resolved = path.resolve(String(baseDir));
          return (
            resolved === path.resolve(root) ||
            resolved.startsWith(`${path.resolve(root)}${path.sep}`)
          );
        }),
      ).toBe(true);
    } finally {
      await second?.close();
      await first?.close();
      if (previousQwenHome === undefined) delete process.env['QWEN_HOME'];
      else process.env['QWEN_HOME'] = previousQwenHome;
      resetHomeEnvBootstrapForTesting();
    }

    await expect(fs.stat(getLiveDiscoveryPath(stable))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }, 30_000);
});
