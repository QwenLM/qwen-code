/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import { makeBridge, makeChannel, WS_A } from './internal/testUtils.js';

describe('Workflow mode owner and lease control', () => {
  it('rechecks a detached client before dispatching a queued mutation', async () => {
    const handle = makeChannel();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const setter = vi
      .spyOn(handle.agent, 'setSessionConfigOption')
      .mockImplementation(async () => {
        await gate;
        return { configOptions: [] };
      });
    const bridge = makeBridge({
      channelFactory: async () => handle.channel,
      sessionScope: 'single',
    });
    try {
      const owner = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const observer = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(observer.sessionId).toBe(owner.sessionId);
      expect(observer.clientId).not.toBe(owner.clientId);
      const request = {
        sessionId: owner.sessionId,
        configId: 'workflow_mode',
        value: 'on',
      };
      const first = bridge.setSessionConfigOption(owner.sessionId, request, {
        clientId: owner.clientId,
      });
      const firstResult = first.catch((error: unknown) => error);
      await vi.waitFor(() => expect(setter).toHaveBeenCalledOnce());
      const queued = bridge.setSessionConfigOption(
        owner.sessionId,
        { ...request, value: 'off' },
        { clientId: owner.clientId },
      );
      const queuedResult = queued.catch((error: unknown) => error);
      await bridge.detachClient(owner.sessionId, owner.clientId);
      release();
      expect(await firstResult).toBeInstanceOf(Error);
      expect(await queuedResult).toBeInstanceOf(Error);
      expect(setter).toHaveBeenCalledOnce();
      await expect(
        bridge.setSessionConfigOption('missing', request),
      ).rejects.toThrow();
      expect(setter).toHaveBeenCalledOnce();
    } finally {
      release();
      await bridge.shutdown();
    }
  });

  it('rechecks the captured runtime generation before a queued mutation dispatches', async () => {
    const handle = makeChannel();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const setter = vi
      .spyOn(handle.agent, 'setSessionConfigOption')
      .mockImplementation(async () => {
        await gate;
        return { configOptions: [] };
      });
    const bridge = makeBridge({ channelFactory: async () => handle.channel });
    let generationOpen = true;
    const assertGeneration = () => {
      if (!generationOpen) throw new Error('retired generation');
    };
    try {
      const owner = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const request = {
        sessionId: owner.sessionId,
        configId: 'workflow_mode',
        value: 'on',
      };
      const first = bridge.setSessionConfigOption(owner.sessionId, request);
      await vi.waitFor(() => expect(setter).toHaveBeenCalledOnce());
      const queued = bridge.setSessionConfigOption(
        owner.sessionId,
        request,
        { clientId: owner.clientId },
        assertGeneration,
      );
      const result = queued.catch((error: unknown) => error);
      generationOpen = false;
      release();
      await first;
      expect(await result).toEqual(
        expect.objectContaining({ message: 'retired generation' }),
      );
      expect(setter).toHaveBeenCalledOnce();
    } finally {
      release();
      await bridge.shutdown();
    }
  });
});
