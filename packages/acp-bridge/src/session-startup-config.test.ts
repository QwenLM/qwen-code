/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  RequestError,
  type SessionConfigOption,
} from '@agentclientprotocol/sdk';
import { makeBridge, makeChannel, WS_A } from './internal/testUtils.js';
import {
  applySessionStartupConfig,
  parseSessionStartupConfig,
} from './session-startup-config.js';

const startupConfig = {
  modelServiceId: 'gpt-5.4(openai)',
  reasoningEffort: 'high' as const,
};

function options(
  effort = 'high',
  model = startupConfig.modelServiceId,
): SessionConfigOption[] {
  return [
    {
      id: 'model',
      name: 'Model',
      type: 'select',
      currentValue: model,
      options: [{ value: model, name: model }],
    },
    {
      id: 'reasoning_effort',
      name: 'Reasoning',
      type: 'select',
      currentValue: effort,
      options: [{ value: effort, name: effort }],
    },
  ];
}

describe('session startup configuration', () => {
  it.each([
    null,
    [],
    {},
    { reasoningEffort: 'high' },
    { modelServiceId: 'x', reasoningEffort: null },
    { ...startupConfig, reasoningEffort: 'invalid' },
    { ...startupConfig, extra: true },
  ])('rejects malformed configuration %j', (value) => {
    expect(() => parseSessionStartupConfig(value)).toThrow();
  });

  it('preserves omission and rejects mixed selectors and attach scope', () => {
    expect(
      parseSessionStartupConfig(undefined, { modelServiceId: 'legacy' }),
    ).toBeUndefined();
    expect(() =>
      parseSessionStartupConfig(startupConfig, {
        modelServiceId: startupConfig.modelServiceId,
      }),
    ).toThrow();
    expect(() =>
      parseSessionStartupConfig(startupConfig, { sessionScope: 'single' }),
    ).toThrow();
  });

  it('only selects the model when reasoning is omitted and no reasoning option exists', async () => {
    const modelServiceId = 'gpt-4.1(openai)';
    const setSessionConfigOption = vi.fn().mockResolvedValue({
      configOptions: options('high', modelServiceId).filter(
        (option) => option.id === 'model',
      ),
    });
    const config = parseSessionStartupConfig({ modelServiceId })!;
    expect(config).toEqual({ modelServiceId });
    expect(
      await applySessionStartupConfig(
        { setSessionConfigOption },
        'session',
        config,
      ),
    ).toEqual({ modelServiceId });
    expect(setSessionConfigOption).toHaveBeenCalledExactlyOnceWith('session', {
      sessionId: 'session',
      configId: 'model',
      value: modelServiceId,
    });
  });

  it.each(['high', 'none', 'default'])(
    'derives default acknowledgment from current reasoning %s',
    async (current) => {
      const setSessionConfigOption = vi
        .fn()
        .mockResolvedValue({ configOptions: options(current) });
      const result = await applySessionStartupConfig(
        { setSessionConfigOption },
        'session',
        { ...startupConfig, reasoningEffort: 'default' },
      );
      expect(result.reasoningEffort).toBe('default');
      expect(result.effectiveReasoning).toEqual(
        current === 'high'
          ? { state: 'enabled', effort: 'high' }
          : current === 'none'
            ? { state: 'disabled' }
            : { state: 'provider-default' },
      );
    },
  );

  it('fails when reasoning is not applied or model changes between responses', async () => {
    for (const configOptions of [
      options('low'),
      options('high', 'another(openai)'),
      [],
    ]) {
      const setSessionConfigOption = vi
        .fn()
        .mockResolvedValueOnce({ configOptions: options() })
        .mockResolvedValueOnce({ configOptions });
      await expect(
        applySessionStartupConfig(
          { setSessionConfigOption },
          'session',
          startupConfig,
        ),
      ).rejects.toMatchObject({ code: 'startup_config_rejected' });
    }
  });

  it('forces a fresh thread, applies model then effort without persistence or workspace events', async () => {
    const handle = makeChannel();
    const newSession = vi
      .spyOn(handle.agent, 'newSession')
      .mockResolvedValueOnce({ sessionId: 'ordinary' })
      .mockResolvedValueOnce({ sessionId: 'configured' });
    const setter = vi
      .spyOn(handle.agent, 'setSessionConfigOption')
      .mockResolvedValue({ configOptions: options() });
    const bridge = makeBridge({
      channelFactory: async () => handle.channel,
      sessionScope: 'single',
    });
    try {
      await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const session = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        startupConfig,
      });
      expect(newSession).toHaveBeenCalledTimes(2);
      expect(session).toMatchObject({
        sessionId: 'configured',
        attached: false,
        modelApplied: true,
        startupConfigApplied: {
          ...startupConfig,
          effectiveReasoning: { state: 'enabled', effort: 'high' },
        },
      });
      expect(setter.mock.calls.map(([request]) => request)).toEqual([
        {
          sessionId: 'configured',
          configId: 'model',
          value: startupConfig.modelServiceId,
        },
        {
          sessionId: 'configured',
          configId: 'reasoning_effort',
          value: 'high',
        },
      ]);
      const abort = new AbortController();
      const events = bridge.subscribeEvents('ordinary', {
        signal: abort.signal,
      });
      const replay: string[] = [];
      const reading = (async () => {
        for await (const event of events) replay.push(event.type);
      })();
      await new Promise((resolve) => setTimeout(resolve, 0));
      abort.abort();
      await reading;
      expect(replay).not.toContain('settings_changed');
      expect(bridge.getSessionSummary('ordinary')).toBeDefined();
    } finally {
      await bridge.shutdown();
    }
  });

  it('removes only the failed new session and leaves its sibling usable', async () => {
    const handle = makeChannel();
    vi.spyOn(handle.agent, 'newSession')
      .mockResolvedValueOnce({ sessionId: 'sibling' })
      .mockResolvedValueOnce({ sessionId: 'failed' });
    vi.spyOn(handle.agent, 'setSessionConfigOption')
      .mockResolvedValueOnce({ configOptions: options() })
      .mockRejectedValueOnce(
        RequestError.invalidParams(undefined, 'unsupported effort'),
      );
    const bridge = makeBridge({ channelFactory: async () => handle.channel });
    try {
      await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      await expect(
        bridge.spawnOrAttach({ workspaceCwd: WS_A, startupConfig }),
      ).rejects.toThrow('unsupported effort');
      expect(() => bridge.getSessionSummary('failed')).toThrow();
      expect(bridge.getSessionSummary('sibling')).toBeDefined();
      await expect(
        bridge.sendPrompt('sibling', {
          sessionId: 'sibling',
          prompt: [{ type: 'text', text: 'still works' }],
        }),
      ).resolves.toBeDefined();
    } finally {
      await bridge.shutdown();
    }
  });
});
