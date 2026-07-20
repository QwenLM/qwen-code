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

  it('releases the commit lane when a manual refresh times out', async () => {
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
    await vi.advanceTimersByTimeAsync(0);
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
      .spyOn(ExtensionManager.prototype, 'refreshCacheWithSnapshot')
      .mockImplementation(async () => {
        vi.setSystemTime(3_000);
        return { extensions: {} } as never;
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

  it('reports user and workspace activation from the existing store rules', async () => {
    vi.spyOn(
      ExtensionManager.prototype,
      'refreshCacheWithSnapshot',
    ).mockResolvedValue({ extensions: {} } as never);
    vi.spyOn(ExtensionManager.prototype, 'getLoadedExtensions').mockReturnValue(
      [
        {
          id: 'extension-id',
          name: 'demo',
          version: '1.0.0',
          isActive: false,
          path: '/extensions/demo',
          config: {},
          contextFiles: [],
        } as never,
      ],
    );
    vi.spyOn(
      ExtensionManager.prototype,
      'getExtensionActivationFromSnapshot',
    ).mockImplementation((_id, _snapshot, path) => ({
      default: 'enabled',
      workspace: 'inherit',
      effective: path === '/work/bound' ? 'disabled' : 'enabled',
      source: 'legacy_path_rule',
    }));
    const controller = createExtensionsController({
      boundWorkspace: '/work/bound',
      bridge: {} as AcpSessionBridge,
      workspace: {} as DaemonWorkspaceService,
    });

    await expect(
      controller.buildLocalExtensionsStatus(),
    ).resolves.toMatchObject({
      extensions: [
        {
          name: 'demo',
          isActive: false,
          defaultActivation: 'enabled',
          workspaceActivation: 'disabled',
        },
      ],
    });
  });

  it('reports an accepted operation as running while its cache refreshes', async () => {
    let finishRefresh!: () => void;
    const refreshPending = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    const manager = {
      refreshCache: vi.fn(async () => await refreshPending),
    } as unknown as ExtensionManager;
    const responseBody = vi.fn();
    const response = {
      status: vi.fn().mockReturnThis(),
      location: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      json: responseBody,
    } as unknown as Response;
    const controller = createExtensionsController({
      boundWorkspace: '/work/bound',
      bridge: {} as AcpSessionBridge,
      workspace: {} as DaemonWorkspaceService,
    });

    controller.runQueuedExtensionMutation(
      'install',
      { name: 'demo' },
      response,
      async () => ({ status: 'installed', name: 'demo', updated: false }),
      { manager, skipRefresh: true },
    );
    const operationId = responseBody.mock.calls[0]?.[0].operationId as string;

    await vi.waitFor(() => expect(manager.refreshCache).toHaveBeenCalledOnce());
    expect(controller.getOperation(operationId)).toMatchObject({
      status: 'running',
      phase: 'preparing',
    });

    finishRefresh();
    await vi.waitFor(() =>
      expect(controller.getOperation(operationId)?.status).toBe('succeeded'),
    );
  });

  it('reports an operation as preparing while any parallel preparation is active', async () => {
    let releaseBlocker!: () => void;
    const blocker = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstActive = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const controller = createExtensionsController({
      boundWorkspace: '/work/bound',
      bridge: {} as AcpSessionBridge,
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
    const held = controller.preparationQueue.run(async () => await blocker);

    controller.runQueuedExtensionMutation(
      'install',
      { name: 'demo' },
      response,
      async (_extensionManager, _signal, context) => {
        await Promise.all([
          context!.prepare(async () => {
            firstStarted();
            await first;
          }),
          context!.prepare(async () => undefined),
        ]);
        return { status: 'installed', name: 'demo', updated: false };
      },
      { manager, skipRefresh: true },
    );
    const operationId = responseBody.mock.calls[0]?.[0].operationId as string;

    await firstActive;
    expect(controller.getOperation(operationId)).toMatchObject({
      status: 'running',
      phase: 'preparing',
    });

    releaseFirst();
    releaseBlocker();
    await held;
    await vi.waitFor(() =>
      expect(controller.getOperation(operationId)).toMatchObject({
        status: 'succeeded',
        phase: undefined,
      }),
    );
  });

  it('clears phase from every terminal operation state', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
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
    const response = () => {
      const responseBody = vi.fn();
      return {
        responseBody,
        value: {
          status: vi.fn().mockReturnThis(),
          location: vi.fn().mockReturnThis(),
          set: vi.fn().mockReturnThis(),
          json: responseBody,
        } as unknown as Response,
      };
    };
    const run = async (
      operation: Parameters<typeof controller.runQueuedExtensionMutation>[3],
    ) => {
      const res = response();
      controller.runQueuedExtensionMutation(
        'install',
        { name: 'demo' },
        res.value,
        operation,
        { manager, skipRefresh: true },
      );
      const operationId = res.responseBody.mock.calls[0]?.[0]
        .operationId as string;
      await vi.waitFor(() =>
        expect(controller.getOperation(operationId)?.status).toMatch(
          /^(succeeded|succeeded_with_warnings|failed)$/,
        ),
      );
      return controller.getOperation(operationId);
    };

    await expect(
      run(async () => ({
        status: 'installed',
        name: 'demo',
        updated: false,
      })),
    ).resolves.toMatchObject({ status: 'succeeded', phase: undefined });
    await expect(
      run(async (_extensionManager, _signal, context) => {
        await context!.commit(async () => ({
          generation: 1,
          warnings: [{ code: 'cleanup_failed', error: 'cleanup failed' }],
        }));
        return { status: 'installed', name: 'demo', updated: false };
      }),
    ).resolves.toMatchObject({
      status: 'succeeded_with_warnings',
      phase: undefined,
    });
    await expect(
      run(async () => {
        throw new Error('prepare failed');
      }),
    ).resolves.toMatchObject({ status: 'failed', phase: undefined });
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
    const accepted = responseBody.mock.calls[0]?.[0] as {
      operationId: string;
      deadlineAt: number;
    };
    const operationId = accepted.operationId;
    expect(accepted.deadlineAt).toBe(Date.now() + 100);
    expect(controller.getOperation(operationId)?.deadlineAt).toBe(
      accepted.deadlineAt,
    );
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

  it('does not commit preparation that settles after its deadline', async () => {
    vi.useFakeTimers();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    let finishPreparation!: () => void;
    const preparation = new Promise<void>((resolve) => {
      finishPreparation = resolve;
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

    controller.runQueuedExtensionMutation(
      'install',
      { name: 'demo' },
      response,
      async (_extensionManager, _signal, context) => {
        await context!.prepare(async () => await preparation);
        await context!.commit(commit);
        return { status: 'installed', name: 'demo' };
      },
      { manager, deadlineMs: 100 },
    );
    await vi.advanceTimersByTimeAsync(0);
    const operationId = responseBody.mock.calls[0]?.[0].operationId as string;

    await vi.advanceTimersByTimeAsync(100);
    finishPreparation();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() =>
      expect(controller.getOperation(operationId)).toMatchObject({
        status: 'failed',
        code: 'extension_prepare_timeout',
      }),
    );
    expect(commit).not.toHaveBeenCalled();
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
