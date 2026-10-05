/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackendAdaptor } from './adaptor/types.js';
import { BackendRegistry } from './adaptor/registry.js';
import { loadConfig } from './config.js';
import { LiveDaemon } from './daemon.js';
import { getLiveDiscoveryPath } from './host/discovery.js';
import { LiveLogger } from './logger.js';

const directories: string[] = [];
const daemons: Array<{ daemon: LiveDaemon; close: ReturnType<typeof vi.fn> }> =
  [];

async function fixture(overrides: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'qwen-live-r2-runtime-'));
  directories.push(directory);
  await writeFile(
    join(directory, 'config.json'),
    JSON.stringify({
      realtimeApiKey: 'synthetic-key',
      realtimeEndpoint: 'https://dashscope.example.invalid',
      memory: { enabled: false },
      ...overrides,
    }),
  );
  const config = loadConfig({
    QWEN_LIVE_DATA_DIR: directory,
    QWEN_LIVE_DISCOVERY_DIR: join(directory, 'discovery'),
  });
  config.port = 0;
  const close = vi.fn(async () => {});
  const logger = new LiveLogger('error');
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  const daemon = new LiveDaemon(config, {
    registry: new BackendRegistry([
      {
        adaptor: {
          name: 'qwen-code',
          preflight: async () => {},
          close,
        } as unknown as BackendAdaptor,
        isDefault: true,
      },
    ]),
    logger,
  });
  daemons.push({ daemon, close });
  return { config, daemon, close, warn };
}

afterEach(async () => {
  for (const { daemon, close } of daemons.splice(0)) {
    close.mockResolvedValue(undefined);
    await daemon.stop();
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('PR #11369 round 2 daemon runtime reproduction', () => {
  it('R2-6 rejects unknown visual input keys instead of selecting the desktop', async () => {
    await expect(
      fixture({
        visualInput: { sourc: 'camera', cameraResoluton: 'native' },
      }),
    ).rejects.toThrow('unknown key');
  });

  it.each([
    'dashscope.aliyuncs.com',
    'wss://user:pass@proxy.example.invalid/realtime',
  ])(
    'R2-8 keeps disabled-memory startup available for realtime endpoint %s',
    async (realtimeEndpoint) => {
      const { daemon, config } = await fixture({ realtimeEndpoint });
      await expect(daemon.start()).resolves.toMatchObject({
        port: expect.any(Number),
      });
      await expect(
        readFile(getLiveDiscoveryPath(config.discoveryDir), 'utf8'),
      ).resolves.toContain('http://127.0.0.1:');
    },
  );

  it('R2-7 logs the resource cleanup cause without changing the shutdown error', async () => {
    const { daemon, close, warn } = await fixture();
    await daemon.start();
    close.mockRejectedValueOnce(new Error('Synthetic backend cleanup failure'));
    await expect(daemon.stop()).rejects.toThrow(
      'Live shutdown cleanup failed.',
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Synthetic backend cleanup failure'),
    );
  });

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'R2-9 removes discovery before the CLI %s handler exits after a cleanup failure',
    async (signalName) => {
      const { daemon, config, close } = await fixture();
      close.mockRejectedValueOnce(
        new Error('Synthetic backend cleanup failure'),
      );
      const start = vi.spyOn(daemon, 'start');
      const originalArguments = process.argv;
      const events = ['SIGINT', 'SIGTERM'] as const;
      const originalListeners = events.map((event) => process.listeners(event));
      const originalRejections = process.listeners('unhandledRejection');
      const exit = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => undefined as never);
      vi.spyOn(LiveLogger.prototype, 'error').mockImplementation(() => {});
      vi.stubEnv('QWEN_LIVE_LOG_LEVEL', 'error');
      vi.resetModules();
      vi.doMock('./daemon.js', () => ({
        LiveDaemon: class {
          constructor() {
            return daemon;
          }
        },
      }));
      vi.doMock('./config.js', async (importOriginal) => ({
        ...(await importOriginal<typeof import('./config.js')>()),
        loadConfig: () => config,
      }));
      process.argv = [
        process.execPath,
        fileURLToPath(new URL('./index.ts', import.meta.url)),
      ];
      try {
        await import('./index.js');
        await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
        await start.mock.results[0]!.value;
        const signal = process
          .listeners(signalName)
          .find(
            (listener) =>
              !originalListeners[events.indexOf(signalName)]!.includes(
                listener,
              ),
          );
        expect(signal).toBeTypeOf('function');
        signal!(signalName);
        await vi.waitFor(() => expect(exit).toHaveBeenCalled());
        await expect(
          readFile(getLiveDiscoveryPath(config.discoveryDir), 'utf8'),
        ).rejects.toThrow();
      } finally {
        process.argv = originalArguments;
        for (const [index, event] of events.entries()) {
          for (const listener of process.listeners(event)) {
            if (!originalListeners[index]!.includes(listener))
              process.removeListener(event, listener);
          }
        }
        for (const listener of process.listeners('unhandledRejection')) {
          if (!originalRejections.includes(listener))
            process.removeListener('unhandledRejection', listener);
        }
        vi.doUnmock('./daemon.js');
        vi.doUnmock('./config.js');
        vi.resetModules();
      }
    },
  );
});
