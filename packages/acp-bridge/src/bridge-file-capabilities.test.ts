/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { makeBridge, makeChannel } from './internal/testUtils.js';
import type { AcpSessionBridge } from './bridgeTypes.js';

describe('ACP bridge file capabilities', () => {
  let bridge: AcpSessionBridge | undefined;

  afterEach(async () => {
    await bridge?.shutdown();
    bridge = undefined;
  });

  it('delegates reads to the ACP client by default', async () => {
    const handle = makeChannel();
    bridge = makeBridge({ channelFactory: async () => handle.channel });

    await bridge.preheat();

    expect(handle.agent.initializeCalls).toHaveLength(1);
    expect(handle.agent.initializeCalls[0]!.clientCapabilities!.fs).toEqual({
      readTextFile: true,
      writeTextFile: true,
    });
  });

  it('can keep text reads in a same-host ACP child', async () => {
    const handle = makeChannel();
    bridge = makeBridge({
      channelFactory: async () => handle.channel,
      delegateReadTextFileToClient: false,
    });

    await bridge.preheat();

    expect(handle.agent.initializeCalls).toHaveLength(1);
    expect(handle.agent.initializeCalls[0]!.clientCapabilities!.fs).toEqual({
      readTextFile: false,
      writeTextFile: true,
    });
  });
});
