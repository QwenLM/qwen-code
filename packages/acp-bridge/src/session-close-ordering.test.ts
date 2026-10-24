/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ClientSideConnection } from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import { makeBridge, makeChannel, WS_A } from './internal/testUtils.js';
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
});
