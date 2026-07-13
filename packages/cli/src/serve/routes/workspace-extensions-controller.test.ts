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

  it('releases the commit lane at the durable commit boundary', async () => {
    let finishPostCommit!: () => void;
    const postCommit = new Promise<void>((resolve) => {
      finishPostCommit = resolve;
    });
    const controller = createExtensionsController({
      boundWorkspace: '/work/bound',
      bridge: {} as AcpSessionBridge,
      workspace: {} as DaemonWorkspaceService,
    });
    const manager = {
      refreshCache: vi.fn(async () => undefined),
    } as unknown as ExtensionManager;
    const response = () =>
      ({
        status: vi.fn().mockReturnThis(),
        location: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis(),
        json: vi.fn(),
      }) as unknown as Response;
    let firstCommitted!: () => void;
    const durableCommit = new Promise<void>((resolve) => {
      firstCommitted = resolve;
    });
    let finishFirstOperation!: () => void;
    const firstOperationFinished = new Promise<void>((resolve) => {
      finishFirstOperation = resolve;
    });
    let finishSecondOperation!: () => void;
    const secondOperationFinished = new Promise<void>((resolve) => {
      finishSecondOperation = resolve;
    });
    let secondStarted = false;

    controller.runQueuedExtensionMutation(
      'install',
      { name: 'first' },
      response(),
      async (_extensionManager, _signal, context) => {
        await context!.commit(async (onCommitted) => {
          onCommitted(1);
          firstCommitted();
          await postCommit;
          return { generation: 1 };
        });
        finishFirstOperation();
        return { status: 'installed', name: 'first' };
      },
      { manager, skipRefresh: true },
    );
    await durableCommit;

    controller.runQueuedExtensionMutation(
      'enable',
      { name: 'second' },
      response(),
      async (_extensionManager, _signal, context) => {
        await context!.commit(async (onCommitted) => {
          secondStarted = true;
          onCommitted(2);
          return { generation: 2 };
        });
        finishSecondOperation();
        return { status: 'enabled', name: 'second' };
      },
      { manager, skipRefresh: true },
    );

    await vi.waitFor(() => expect(secondStarted).toBe(true));
    finishPostCommit();
    await Promise.all([firstOperationFinished, secondOperationFinished]);
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

  it('aborts timed-out preparation without committing and releases its slot', async () => {
    vi.useFakeTimers();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    let releaseBlocker!: () => void;
    const blocker = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const controller = createExtensionsController({
      boundWorkspace: '/work/bound',
      bridge: {
        broadcastExtensionsChanged: vi.fn(),
      } as unknown as AcpSessionBridge,
      workspace: {} as DaemonWorkspaceService,
    });
    const manager = {
      refreshCache: vi.fn(async () => undefined),
    } as unknown as ExtensionManager;
    const responseBody = vi.fn();
    const response = {
      status: vi.fn().mockReturnThis(),
      location: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      json: responseBody,
    } as unknown as Response;
    const commit = vi.fn(async () => ({ generation: 1 }));
    const held = controller.preparationQueue.run(async () => await blocker);

    controller.runQueuedExtensionMutation(
      'install',
      { name: 'demo' },
      response,
      async (_extensionManager, _signal, context) => {
        await context!.prepare(
          async (signal) =>
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), {
                once: true,
              });
            }),
        );
        await context!.commit(commit);
        return { status: 'installed', name: 'demo' };
      },
      { manager, deadlineMs: 100 },
    );
    await vi.advanceTimersByTimeAsync(0);
    const operationId = responseBody.mock.calls[0]?.[0].operationId as string;
    let probeStarted = false;
    const probe = controller.preparationQueue.run(async () => {
      probeStarted = true;
    });
    expect(probeStarted).toBe(false);

    await vi.advanceTimersByTimeAsync(100);
    await probe;

    expect(controller.getOperation(operationId)).toMatchObject({
      status: 'failed',
      code: 'extension_prepare_timeout',
    });
    expect(commit).not.toHaveBeenCalled();
    expect(probeStarted).toBe(true);

    releaseBlocker();
    await held;
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
