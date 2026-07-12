/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExtensionManager } from '@qwen-code/qwen-code-core';
import type { Response } from 'express';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import type { DaemonWorkspaceService } from '../workspace-service/types.js';
import { createExtensionsController } from './workspace-extensions-controller.js';

describe('createExtensionsController', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('releases the commit lane after a manual refresh times out', async () => {
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
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshCalls).toBe(2);
    await expect(nextOutcome).resolves.toEqual({ refreshed: 1, failed: 0 });

    releaseRefresh?.({ refreshed: 0, failed: 0 });
  });

  it('starts the status cache lifetime after a slow refresh completes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const refreshCache = vi
      .spyOn(ExtensionManager.prototype, 'refreshCache')
      .mockImplementation(async () => {
        vi.setSystemTime(3_000);
      });
    vi.spyOn(ExtensionManager.prototype, 'getLoadedExtensions').mockReturnValue(
      [],
    );
    const controller = createExtensionsController({
      boundWorkspace: '/work/bound',
      bridge: {} as AcpSessionBridge,
      workspace: {} as DaemonWorkspaceService,
    });

    await controller.buildLocalExtensionsStatus();
    await controller.buildLocalExtensionsStatus();

    expect(refreshCache).toHaveBeenCalledOnce();
  });

  it('releases the operation slot when the acceptance response throws', () => {
    let operationId: string | undefined;
    const throwingResponse = {
      status: vi.fn().mockReturnThis(),
      location: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      json: vi.fn((body: { operationId: string }) => {
        operationId = body.operationId;
        throw new Error('socket closed');
      }),
    } as unknown as Response;
    const controller = createExtensionsController({
      boundWorkspace: '/work/bound',
      bridge: {} as AcpSessionBridge,
      workspace: {} as DaemonWorkspaceService,
    });

    expect(() =>
      controller.runQueuedExtensionMutation(
        'install',
        {},
        throwingResponse,
        async () => ({ status: 'installed' }),
      ),
    ).not.toThrow();
    expect(operationId).toBeDefined();
    expect(controller.getOperation(operationId!)).toBeUndefined();

    const response = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    const releases = Array.from({ length: 10 }, () =>
      controller.acquireOperationSlot(response),
    );
    expect(releases.every(Boolean)).toBe(true);
    releases.forEach((release) => release?.());
  });
});
