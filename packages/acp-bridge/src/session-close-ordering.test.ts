/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ClientSideConnection } from '@agentclientprotocol/sdk';
import { describe, expect, it, vi, type MockInstance } from 'vitest';
import type { AcpSessionBridge } from './bridgeTypes.js';
import {
  collectedAfterGc,
  makeBridge,
  makeChannel,
  nativeRaceRetainsValues,
  WS_A,
} from './internal/testUtils.js';
import { BridgeChannelClosedError } from './status.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Switches in a frame of its own, so nothing but the returned WeakRef points
// at the first response once it returns. The spy records every value it
// returns, so its history is cleared after each switch.
async function switchModels(
  bridge: AcpSessionBridge,
  sessionId: string,
  setModel: MockInstance<ClientSideConnection['unstable_setSessionModel']>,
): Promise<WeakRef<object>> {
  let first: WeakRef<object> | undefined;
  for (let call = 0; call < 3; call++) {
    const response = {};
    setModel.mockResolvedValueOnce(response);
    await bridge.setSessionModel(sessionId, {
      sessionId,
      modelId: `model-${call}`,
    });
    setModel.mockClear();
    first ??= new WeakRef(response);
  }
  return first!;
}

describe('session calls racing the transport', () => {
  it('fail when the transport fails before the reply arrives', async () => {
    const transportFailure = deferred<unknown>();
    const requested = deferred<void>();
    const reply = deferred<Record<string, never>>();
    const handle = makeChannel();
    handle.channel = {
      ...handle.channel,
      transportFailed: transportFailure.promise,
    };
    const bridge = makeBridge({ channelFactory: async () => handle.channel });
    const setModel = vi
      .spyOn(ClientSideConnection.prototype, 'unstable_setSessionModel')
      .mockImplementation(() => {
        requested.resolve();
        return reply.promise;
      });
    try {
      const { sessionId } = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const switching = bridge
        .setSessionModel(sessionId, { sessionId, modelId: 'other-model' })
        .then(
          () => 'switched',
          (error: unknown) => error,
        );
      await requested.promise;
      // Same job: any extra hop on the closed-signal side lets the reply win.
      transportFailure.reject(new Error('transport failed'));
      reply.resolve({});
      expect(await switching).toBeInstanceOf(BridgeChannelClosedError);
    } finally {
      setModel.mockRestore();
      reply.resolve({});
      await bridge.shutdown();
    }
  });

  it('leave each model switch response collectable while the session stays open', async ({
    skip,
  }) => {
    skip(
      !(await nativeRaceRetainsValues()),
      'native Promise.race does not retain finished values on this runtime',
    );
    const handle = makeChannel();
    const bridge = makeBridge({ channelFactory: async () => handle.channel });
    const setModel = vi.spyOn(
      ClientSideConnection.prototype,
      'unstable_setSessionModel',
    );
    try {
      const { sessionId } = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const first = await switchModels(bridge, sessionId, setModel);
      expect(await collectedAfterGc(first)).toBe(true);
    } finally {
      setModel.mockRestore();
      await bridge.shutdown();
    }
  });
});
