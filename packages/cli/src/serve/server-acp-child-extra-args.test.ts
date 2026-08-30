/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeOptions } from './acp-session-bridge.js';

const harness = vi.hoisted(() => ({
  spawnFactoryCalls: [] as Array<{ extraArgs?: string[] }>,
  createAcpSessionBridge: vi.fn(),
}));

vi.mock('./acp-session-bridge.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./acp-session-bridge.js')>();
  return {
    ...actual,
    createSpawnChannelFactory: (options: { extraArgs?: string[] }) => {
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
