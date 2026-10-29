/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import { makeBridge, makeChannel, WS_A } from './internal/testUtils.js';

function workflowOptions(
  value: 'on' | 'off',
  available = true,
): SessionConfigOption[] {
  return [
    {
      id: 'workflow_mode',
      name: 'Workflow mode',
      type: 'select',
      currentValue: value,
      options: [
        { value: 'off', name: 'Off' },
        { value: 'on', name: 'On' },
      ],
      _meta: {
        'qwen.workflowMode': {
          available,
          effective: value === 'on' && available,
          ...(!available ? { reason: 'workflow_unavailable' } : {}),
        },
      },
    },
  ];
}

describe('Workflow mode owner and lease control', () => {
  it('refreshes cached config options after committed setters for load and resume', async () => {
    const handle = makeChannel({
      loadSessionImpl: () => ({ configOptions: workflowOptions('off') }),
    });
    const setter = vi
      .spyOn(handle.agent, 'setSessionConfigOption')
      .mockImplementation(async ({ value }) => ({
        configOptions: workflowOptions(value as 'on' | 'off'),
      }));
    const bridge = makeBridge({ channelFactory: async () => handle.channel });
    const request = { sessionId: 'restored-mode', workspaceCwd: WS_A };
    try {
      const owner = await bridge.loadSession(request);
      expect(owner.state.configOptions).toEqual(workflowOptions('off'));
      for (const value of ['on', 'off'] as const) {
        await bridge.setSessionConfigOption(
          owner.sessionId,
          { sessionId: owner.sessionId, configId: 'workflow_mode', value },
          { clientId: owner.clientId },
        );
        expect((await bridge.loadSession(request)).state.configOptions).toEqual(
          workflowOptions(value),
        );
        expect(
          (await bridge.resumeSession(request)).state.configOptions,
        ).toEqual(workflowOptions(value));
      }
      setter.mockRejectedValueOnce(new Error('mode write failed'));
      await expect(
        bridge.setSessionConfigOption(owner.sessionId, {
          sessionId: owner.sessionId,
          configId: 'workflow_mode',
          value: 'on',
        }),
      ).rejects.toThrow('Internal error');
      expect((await bridge.resumeSession(request)).state.configOptions).toEqual(
        workflowOptions('off'),
      );
      expect(setter).toHaveBeenCalledTimes(3);
      setter.mockImplementationOnce(async () => {
        await bridge.detachClient(owner.sessionId, owner.clientId!);
        return { configOptions: workflowOptions('on') };
      });
      await expect(
        bridge.setSessionConfigOption(
          owner.sessionId,
          {
            sessionId: owner.sessionId,
            configId: 'workflow_mode',
            value: 'on',
          },
          { clientId: owner.clientId },
        ),
      ).rejects.toThrow();
      expect((await bridge.resumeSession(request)).state.configOptions).toEqual(
        workflowOptions('off'),
      );
      expect(setter).toHaveBeenCalledTimes(4);
      expect(handle.agent.loadSessionCalls).toHaveLength(1);
      expect(handle.agent.resumeSessionCalls).toHaveLength(0);
    } finally {
      await bridge.shutdown();
    }
  });

  it('refreshes cached config options from owner notifications without a setter', async () => {
    const handle = makeChannel({
      loadSessionImpl: () => ({ configOptions: workflowOptions('off') }),
    });
    const bridge = makeBridge({ channelFactory: async () => handle.channel });
    const request = { sessionId: 'restored-mode', workspaceCwd: WS_A };
    try {
      const owner = await bridge.loadSession(request);
      for (const configOptions of [
        workflowOptions('on'),
        workflowOptions('on', false),
        [],
      ]) {
        const previous = bridge.getSessionLastEventId(owner.sessionId);
        await handle.agentConnection.sessionUpdate({
          sessionId: owner.sessionId,
          update: { sessionUpdate: 'config_option_update', configOptions },
        });
        await vi.waitFor(() =>
          expect(bridge.getSessionLastEventId(owner.sessionId)).toBeGreaterThan(
            previous,
          ),
        );
        expect((await bridge.loadSession(request)).state.configOptions).toEqual(
          configOptions,
        );
        const resumed = await bridge.resumeSession(request);
        expect(resumed.state.configOptions).toEqual(configOptions);
        expect(resumed.compactedReplay).toBeUndefined();
        expect(resumed.lastEventId).toBeGreaterThan(0);
      }
    } finally {
      await bridge.shutdown();
    }
  });

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
