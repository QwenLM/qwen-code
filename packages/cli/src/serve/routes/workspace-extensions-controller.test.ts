/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import type { DaemonWorkspaceService } from '../workspace-service/types.js';
import { createExtensionsController } from './workspace-extensions-controller.js';

describe('createExtensionsController', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('times out a manual refresh without releasing its commit lane', async () => {
    vi.useFakeTimers();
    let refreshCalls = 0;
    let releaseRefresh:
      | ((result: { refreshed: number; failed: number }) => void)
      | undefined;
    const controller = createExtensionsController({
      boundWorkspace: '/work/bound',
      bridge: {} as AcpSessionBridge,
      workspace: {
        refreshExtensionsForAllSessions: () => {
          refreshCalls += 1;
          if (refreshCalls > 1) {
            return Promise.resolve({ refreshed: 1, failed: 0 });
          }
          return new Promise<{ refreshed: number; failed: number }>(
            (resolve) => {
              releaseRefresh = resolve;
            },
          );
        },
      } as unknown as DaemonWorkspaceService,
    });

    const outcome = controller.refreshExtensionsForAllSessions().then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : 'error'),
    );
    await vi.advanceTimersByTimeAsync(30_000);

    expect(await Promise.race([outcome, Promise.resolve('pending')])).toBe(
      'extension refresh timed out after 30000ms',
    );

    const nextOutcome = controller.refreshExtensionsForAllSessions().then(
      (result) => result,
      (error: unknown) => (error instanceof Error ? error.message : 'error'),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refreshCalls).toBe(1);
    expect(await Promise.race([nextOutcome, Promise.resolve('pending')])).toBe(
      'pending',
    );

    releaseRefresh?.({ refreshed: 0, failed: 0 });
    await expect(nextOutcome).resolves.toEqual({ refreshed: 1, failed: 0 });
    expect(refreshCalls).toBe(2);
  });
});
