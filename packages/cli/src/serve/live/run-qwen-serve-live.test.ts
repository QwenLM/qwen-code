/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resetHomeEnvBootstrapForTesting } from '../../config/settings.js';
import { runQwenServe } from '../run-qwen-serve.js';
import { getLiveDiscoveryPath } from './discovery.js';
import { LIVE_HOST_PROTOCOL_VERSION } from './types.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
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
    await fs.mkdir(workspace);
    const token = 'integration-test-token';
    const discoveryPath = getLiveDiscoveryPath(runtime);
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace,
        maxSessions: 1,
        serveWebShell: false,
        token,
      },
      {
        preheatBridge: false,
        daemonLogBaseDir: path.join(runtime, 'debug'),
      },
    );

    try {
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
    } finally {
      await handle.close();
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
      JSON.stringify({ general: { liveVoice: { enabled: true } } }),
    );
    const previousQwenHome = process.env['QWEN_HOME'];
    const previousRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_HOME'] = qwenHome;
    process.env['QWEN_RUNTIME_DIR'] = runtime;
    resetHomeEnvBootstrapForTesting();
    let handle: Awaited<ReturnType<typeof runQwenServe>> | undefined;
    try {
      handle = await runQwenServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace,
          maxSessions: 1,
          serveWebShell: false,
        },
        {
          preheatBridge: false,
          liveDiscoveryStableBaseDir: stable,
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
});
