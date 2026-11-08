/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeOptions } from './acp-session-bridge.js';
import type { SpawnChannelFactoryOptions } from '@qwen-code/acp-bridge/spawnChannel';
import { ProcessRegistry } from '@qwen-code/acp-bridge/processRegistry';
import { createChildHeapPolicy } from '@qwen-code/acp-bridge/childHeapPolicy';
import { resolveDaemonMemoryBudget } from '@qwen-code/acp-bridge/daemonMemoryBudget';
import { hashDaemonWorkspace } from '@qwen-code/qwen-code-core/telemetry/daemon-tracing.js';

const harness = vi.hoisted(() => ({
  spawnFactoryCalls: [] as SpawnChannelFactoryOptions[],
  createAcpSessionBridge: vi.fn(),
  reclaimIdleAcp: vi.fn(),
}));

vi.mock('./idle-acp-reclamation.js', () => ({
  createIdleAcpReclaimer: () => harness.reclaimIdleAcp,
}));

vi.mock('./acp-session-bridge.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./acp-session-bridge.js')>();
  return {
    ...actual,
    createSpawnChannelFactory: (options: SpawnChannelFactoryOptions) => {
      harness.spawnFactoryCalls.push(options);
      return actual.createSpawnChannelFactory(options);
    },
    createAcpSessionBridge: (options: BridgeOptions) => {
      harness.createAcpSessionBridge(options);
      return new Proxy(
        {},
        {
          get: (_target, prop) => {
            if (prop === 'then') return undefined;
            return vi.fn();
          },
        },
      );
    },
  };
});

import { createServeApp } from './server.js';

describe('createServeApp default ACP child extraArgs', () => {
  afterEach(() => {
    harness.spawnFactoryCalls.length = 0;
    harness.createAcpSessionBridge.mockReset();
    harness.reclaimIdleAcp.mockReset();
  });

  it('does not spawn extraArgs when restore is off', () => {
    createServeApp({
      hostname: '127.0.0.1',
      port: 4170,
      mode: 'http-bridge',
    });

    expect(harness.spawnFactoryCalls).toEqual([]);
    expect(
      harness.createAcpSessionBridge.mock.calls[0]?.[0],
    ).not.toHaveProperty('channelFactory');
  });

  it('binds a managed default factory to the shared reclaimer', async () => {
    const boundWorkspace = process.cwd();
    createServeApp(
      { hostname: '127.0.0.1', port: 4170, mode: 'http-bridge' },
      undefined,
      {
        boundWorkspace,
        managedChildProcesses: {
          registry: new ProcessRegistry(),
          policy: createChildHeapPolicy({
            budget: resolveDaemonMemoryBudget({ availableMemoryMb: 2048 }),
            mode: 'admit',
          }),
        },
      },
    );
    const signal = new AbortController().signal;
    const callback = harness.spawnFactoryCalls[0]?.reclaimIdleChild;
    expect(callback).toEqual(expect.any(Function));
    await callback!(signal);
    expect(harness.reclaimIdleAcp).toHaveBeenCalledWith(
      hashDaemonWorkspace(boundWorkspace),
      signal,
    );
  });

  it('forwards --restore-ask-user-question to the default child factory', () => {
    createServeApp({
      hostname: '127.0.0.1',
      port: 4170,
      mode: 'http-bridge',
      restoreAskUserQuestion: true,
    });

    expect(harness.spawnFactoryCalls).toEqual([
      { extraArgs: ['--restore-ask-user-question'] },
    ]);
    expect(harness.createAcpSessionBridge.mock.calls[0]?.[0]).toMatchObject({
      restoreAskUserQuestion: true,
    });
  });
});
