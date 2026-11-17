/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveLogger } from './logger.js';

afterEach(() => vi.unstubAllEnvs());

describe('LiveLogger debug recording gate', () => {
  it('enables recording only at the debug level', () => {
    for (const level of ['info', 'warn', 'error'] as const) {
      expect(new LiveLogger(level).debugEnabled).toBe(false);
    }
    expect(new LiveLogger('debug').debugEnabled).toBe(true);
  });

  it('respects the environment level without enabling recording for unknown values', () => {
    vi.stubEnv('QWEN_LIVE_LOG_LEVEL', 'debug');
    expect(new LiveLogger().debugEnabled).toBe(true);
    expect(new LiveLogger('info').debugEnabled).toBe(false);
    vi.stubEnv('QWEN_LIVE_LOG_LEVEL', 'unknown');
    expect(new LiveLogger().debugEnabled).toBe(false);
    vi.stubEnv('QWEN_LIVE_LOG_LEVEL', undefined);
    expect(new LiveLogger().debugEnabled).toBe(false);
  });
});
