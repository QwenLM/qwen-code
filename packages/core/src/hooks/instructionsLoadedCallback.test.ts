/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { createInstructionsLoadedCallback } from './instructionsLoadedCallback.js';
import type { HookSystem } from './hookSystem.js';

describe('createInstructionsLoadedCallback', () => {
  it('forwards instruction load metadata to the hook system', async () => {
    const fireInstructionsLoadedEvent = vi.fn().mockResolvedValue(undefined);
    const callback = createInstructionsLoadedCallback(
      () =>
        ({
          hasHooksForEvent: vi.fn().mockReturnValue(true),
          fireInstructionsLoadedEvent,
        }) as unknown as HookSystem,
    );

    await callback({
      filePath: '/repo/QWEN.md',
      memoryType: 'project',
      loadReason: 'include',
      triggerFilePath: '/repo/src/app.ts',
      parentFilePath: '/repo/AGENTS.md',
    });

    expect(fireInstructionsLoadedEvent).toHaveBeenCalledWith(
      '/repo/QWEN.md',
      'project',
      'include',
      {
        triggerFilePath: '/repo/src/app.ts',
        parentFilePath: '/repo/AGENTS.md',
      },
    );
  });

  it('skips firing when InstructionsLoaded hooks are not configured', async () => {
    const fireInstructionsLoadedEvent = vi.fn();
    const callback = createInstructionsLoadedCallback(
      () =>
        ({
          hasHooksForEvent: vi.fn().mockReturnValue(false),
          fireInstructionsLoadedEvent,
        }) as unknown as HookSystem,
    );

    await callback({
      filePath: '/repo/QWEN.md',
      memoryType: 'project',
      loadReason: 'session_start',
    });

    expect(fireInstructionsLoadedEvent).not.toHaveBeenCalled();
  });

  it('does nothing when no hook system is available', async () => {
    const callback = createInstructionsLoadedCallback(() => undefined);

    await expect(
      callback({
        filePath: '/repo/QWEN.md',
        memoryType: 'project',
        loadReason: 'session_start',
      }),
    ).resolves.toBeUndefined();
  });

  it('propagates hook system errors to the memory loader wrapper', async () => {
    const error = new Error('hook failed');
    const callback = createInstructionsLoadedCallback(
      () =>
        ({
          hasHooksForEvent: vi.fn().mockReturnValue(true),
          fireInstructionsLoadedEvent: vi.fn().mockRejectedValue(error),
        }) as unknown as HookSystem,
    );

    await expect(
      callback({
        filePath: '/repo/QWEN.md',
        memoryType: 'project',
        loadReason: 'session_start',
      }),
    ).rejects.toThrow('hook failed');
  });
});
