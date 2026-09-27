/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Config } from '../config/config.js';
import * as runtimeStatus from './runtimeStatus.js';

let temp: string;
beforeEach(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), 'runtime-owner-'));
  vi.stubEnv('QWEN_RUNTIME_DIR', path.join(temp, 'runtime'));
  for (const key of [
    'QWEN_CODE_SESSION_ID',
    'QWEN_CODE_MODEL',
    'QWEN_CODE_MODEL_IDENTITY',
  ]) {
    vi.stubEnv(key, process.env[key]);
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(temp, { recursive: true, force: true });
});

it.each([false, true])(
  'swaps sidecars only when this Config owns one (%s)',
  async (owner) => {
    const clear = vi
      .spyOn(runtimeStatus, 'clearRuntimeStatus')
      .mockResolvedValue(undefined);
    const write = vi
      .spyOn(runtimeStatus, 'writeRuntimeStatus')
      .mockResolvedValue('written');
    const config = new Config({
      sessionId: 'old-session',
      cwd: temp,
      targetDir: temp,
      debugMode: false,
      model: 'test-model',
      usageStatisticsEnabled: false,
      bareMode: true,
    });
    try {
      const oldPath = config.storage.getRuntimeStatusPath('old-session');
      const newPath = config.storage.getRuntimeStatusPath('new-session');
      if (owner) config.markRuntimeStatusEnabled();
      expect(config.startNewSession('new-session')).toBe('new-session');
      await (
        config as unknown as { flushRuntimeStatusWrites(): Promise<void> }
      ).flushRuntimeStatusWrites();

      if (owner) {
        expect(clear).toHaveBeenCalledExactlyOnceWith(oldPath);
        expect(write).toHaveBeenCalledExactlyOnceWith(newPath, {
          sessionId: 'new-session',
          workDir: temp,
          qwenVersion: null,
        });
      } else {
        expect(clear).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
      }
    } finally {
      await config.shutdown({ shutdownTelemetry: false });
    }
  },
);
