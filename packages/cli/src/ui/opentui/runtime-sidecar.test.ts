/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';

const writeRuntimeStatusMock = vi.fn();
vi.mock('@qwen-code/qwen-code-core', async () => {
  const actual = await vi.importActual<
    typeof import('@qwen-code/qwen-code-core')
  >('@qwen-code/qwen-code-core');
  return {
    ...actual,
    writeRuntimeStatus: (...args: unknown[]) => writeRuntimeStatusMock(...args),
  };
});

vi.mock('../../utils/version.js', () => ({
  getCliVersion: vi.fn().mockResolvedValue('1.2.3'),
}));

import { writeRuntimeSidecar } from './runtime-sidecar.js';

function makeConfig(): {
  config: Config;
  markRuntimeStatusEnabled: () => void;
} {
  const markRuntimeStatusEnabled = vi.fn();
  const config = {
    getSessionId: () => 'sess-1',
    getTargetDir: () => '/tmp/proj',
    storage: {
      getRuntimeStatusPath: (sessionId: string) => `/run/${sessionId}.json`,
    },
    markRuntimeStatusEnabled,
  } as unknown as Config;
  return { config, markRuntimeStatusEnabled };
}

describe('writeRuntimeSidecar', () => {
  beforeEach(() => {
    writeRuntimeStatusMock.mockReset();
    writeRuntimeStatusMock.mockResolvedValue('/run/sess-1.json');
  });

  it('writes the sidecar and arms the session-swap refresh', async () => {
    const { config, markRuntimeStatusEnabled } = makeConfig();
    const ok = await writeRuntimeSidecar(config);
    expect(ok).toBe(true);
    expect(writeRuntimeStatusMock).toHaveBeenCalledWith('/run/sess-1.json', {
      sessionId: 'sess-1',
      workDir: '/tmp/proj',
      qwenVersion: '1.2.3',
    });
    expect(markRuntimeStatusEnabled).toHaveBeenCalledTimes(1);
  });

  it('returns false and does not arm when the write fails', async () => {
    writeRuntimeStatusMock.mockRejectedValue(new Error('read-only fs'));
    const { config, markRuntimeStatusEnabled } = makeConfig();
    const ok = await writeRuntimeSidecar(config);
    expect(ok).toBe(false);
    expect(markRuntimeStatusEnabled).not.toHaveBeenCalled();
  });
});
