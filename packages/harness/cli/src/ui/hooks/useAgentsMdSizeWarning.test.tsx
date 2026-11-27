/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import {
  CoreEvent,
  coreEvents,
  type Config,
  type AgentsMdSizeSnapshot,
} from '@qwen-code/core';
import { renderHook } from '../../test-utils/render.js';
import { useAgentsMdSizeWarning } from './useAgentsMdSizeWarning.js';

describe('TUI AGENTS.md budget warning', () => {
  it('shows initial paths, shows every over-budget evaluation and unregisters', async () => {
    const snapshot: AgentsMdSizeSnapshot = {
      files: [{ path: '/project/AGENTS.md', bytes: 32768, depth: 0 }],
      totalBytes: 32768,
      thresholdBytes: 32768,
      thresholdSource: 'default',
      thresholdReached: true,
      measuredAt: 1,
      loadStatus: 'complete',
      readErrorCount: 0,
      reason: 'startup',
    };
    const config = {
      getSessionId: () => 'session',
      getMemoryContextManager: () => ({
        getAgentsMdSizeSnapshot: () => snapshot,
      }),
    } as unknown as Config;
    const add = vi.fn();
    const { unmount } = await renderHook(() =>
      useAgentsMdSizeWarning(config, add),
    );
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0][0].text).toContain('/project/AGENTS.md');
    act(() => {
      coreEvents.emit(CoreEvent.AgentsMdSizeEvaluated, {
        sessionId: 'session',
        snapshot,
        notifyWarning: false,
      });
    });
    expect(add).toHaveBeenCalledTimes(1);
    act(() => {
      coreEvents.emit(CoreEvent.AgentsMdSizeEvaluated, {
        sessionId: 'other',
        snapshot,
      });
      coreEvents.emit(CoreEvent.AgentsMdSizeEvaluated, {
        sessionId: 'session',
        snapshot: { ...snapshot, thresholdReached: false },
      });
      coreEvents.emit(CoreEvent.AgentsMdSizeEvaluated, {
        sessionId: 'session',
        snapshot,
      });
      coreEvents.emit(CoreEvent.AgentsMdSizeEvaluated, {
        sessionId: 'session',
        snapshot,
      });
    });
    expect(add).toHaveBeenCalledTimes(3);
    act(() => {
      unmount();
    });
    coreEvents.emit(CoreEvent.AgentsMdSizeEvaluated, {
      sessionId: 'session',
      snapshot,
    });
    expect(add).toHaveBeenCalledTimes(3);
  });
});
