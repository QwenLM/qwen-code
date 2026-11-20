/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { AcpSessionBridge } from './bridgeTypes.js';
import {
  collectedAfterGc,
  makeBridge,
  makeChannel,
  nativeRaceRetainsValues,
  WS_A,
} from './internal/testUtils.js';
import { SERVE_STATUS_EXT_METHODS } from './status.js';

// Polls in a frame of its own, so nothing but the returned WeakRef points at
// the first response once it returns. Later polls move the connection's
// read loop past it; that loop holds the most recent message until the next.
async function pollTasks(
  bridge: AcpSessionBridge,
  sessionId: string,
): Promise<WeakRef<object>> {
  let first: WeakRef<object> | undefined;
  for (let poll = 0; poll < 3; poll++) {
    const response = await bridge.getSessionTasksStatus(sessionId);
    first ??= new WeakRef(response);
  }
  return first!;
}

describe('session status requests', () => {
  // Web Shell polls these every few seconds for the session's lifetime
  // (#15071), so a response must not outlive its request.
  it('leave each response collectable while the session stays open', async ({
    skip,
  }) => {
    skip(
      !(await nativeRaceRetainsValues()),
      'native Promise.race does not retain finished values on this runtime',
    );
    const bridge = makeBridge({
      channelFactory: async () =>
        makeChannel({
          extMethodImpl: (method, params) =>
            method === SERVE_STATUS_EXT_METHODS.sessionTasks
              ? { v: 1, sessionId: params['sessionId'], tasks: [] }
              : {},
        }).channel,
    });
    try {
      const { sessionId } = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const lastResponse = await pollTasks(bridge, sessionId);
      expect(await collectedAfterGc(lastResponse)).toBe(true);
    } finally {
      await bridge.shutdown();
    }
  });
});
