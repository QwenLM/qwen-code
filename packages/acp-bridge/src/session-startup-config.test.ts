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
import { REASONING_EFFORT_TIERS } from '@qwen-code/qwen-code-core/core/reasoning-effort.js';
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
    { modelServiceId: 'x'.repeat(257) },
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

  it.each(REASONING_EFFORT_TIERS)(
    'accepts the core reasoning tier %s',
    (reasoningEffort) => {
      expect(
        parseSessionStartupConfig({ modelServiceId: 'm', reasoningEffort }),
      ).toEqual({ modelServiceId: 'm', reasoningEffort });
    },
  );

  it('uses the canonical confirmation for model-only selection instead of echoing input', async () => {
    const setSessionConfigOption = vi
      .fn()
      .mockResolvedValue({ configOptions: options() });
    expect(
      await applySessionStartupConfig({ setSessionConfigOption }, 'session', {
        modelServiceId: 'gpt-5.4',
      }),
    ).toEqual({ modelServiceId: startupConfig.modelServiceId });
  });

  it.each(
    [
      [],
      options().filter((option) => option.id !== 'model'),
      options('high', ''),
    ].map((configOptions) => ({ configOptions })),
  )(
    'rejects a missing model confirmation for model-only startup',
    async ({ configOptions }) => {
      const setSessionConfigOption = vi
        .fn()
        .mockResolvedValue({ configOptions });
      await expect(
        applySessionStartupConfig({ setSessionConfigOption }, 'session', {
          modelServiceId: 'gpt-5.4',
        }),
      ).rejects.toMatchObject({ code: 'startup_config_rejected' });
      expect(setSessionConfigOption).toHaveBeenCalledTimes(1);
    },
  );

  it('reports toggle-only reasoning as enabled without inventing an effort', async () => {
    const configOptions = options('default');
    configOptions[1]!._meta = { 'qwenCode/reasoning': { toggleOnly: true } };
    const setSessionConfigOption = vi.fn().mockResolvedValue({ configOptions });
    const result = await applySessionStartupConfig(
      { setSessionConfigOption },
      'session',
      { ...startupConfig, reasoningEffort: 'default' },
    );
    expect(result.effectiveReasoning).toEqual({ state: 'enabled' });
  });

  it('maps only deterministic parameter rejection to startup_config_rejected', async () => {
    const invalid = RequestError.invalidParams(undefined, 'unsupported effort');
    const setSessionConfigOption = vi.fn().mockRejectedValue(invalid);
    await expect(
      applySessionStartupConfig(
        { setSessionConfigOption },
        'session',
        startupConfig,
      ),
    ).rejects.toMatchObject({
      code: 'startup_config_rejected',
      message: invalid.message,
    });
    for (const error of [
      RequestError.authRequired(),
      new Error('transport closed'),
    ]) {
      setSessionConfigOption.mockRejectedValueOnce(error);
      await expect(
        applySessionStartupConfig(
          { setSessionConfigOption },
          'session',
          startupConfig,
        ),
      ).rejects.toBe(error);
    }
  });

  it('leaves the internal-error wire shape unmapped even with a details string', async () => {
    // -32603 is what every child-side internal fault produces — auth,
    // credential, timeout and transport failures included — so even a
    // refusal-shaped `data.details` is an uncertain outcome, not a definite
    // rejection. The child maps its caller-caused refusals to invalidParams
    // before they reach the wire.
    const setSessionConfigOption = vi.fn();
    for (const shape of [
      {
        code: -32603,
        message: 'Internal error',
        data: { details: "Model 'qwen-typo' not found for authType 'openai'" },
      },
      {
        code: -32603,
        message: 'Internal error',
        data: { details: 'Missing API key for openai auth' },
      },
      { code: -32603, message: 'Internal error' },
      { code: -32603, message: 'Internal error', data: { details: 42 } },
      { code: -32603, message: 'Internal error', data: null },
    ]) {
      setSessionConfigOption.mockRejectedValueOnce(shape);
      await expect(
        applySessionStartupConfig(
          { setSessionConfigOption },
          'session',
          startupConfig,
        ),
      ).rejects.toBe(shape);
    }
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

  it('applies explicit none and confirms disabled reasoning', async () => {
    const setSessionConfigOption = vi
      .fn()
      .mockResolvedValue({ configOptions: options('none') });
    const result = await applySessionStartupConfig(
      { setSessionConfigOption },
      'session',
      { ...startupConfig, reasoningEffort: 'none' },
    );
    expect(result).toEqual({
      ...startupConfig,
      reasoningEffort: 'none',
      effectiveReasoning: { state: 'disabled' },
    });
    expect(setSessionConfigOption.mock.calls[1]?.[1]).toMatchObject({
      configId: 'reasoning_effort',
      value: 'none',
    });
  });

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
      .mockImplementation(async (request) => {
        if (request.configId === 'model') {
          await handle.agentConnection.extNotification(
            'qwen/notify/session/model-update',
            {
              v: 1,
              sessionId: request.sessionId,
              currentModelId: startupConfig.modelServiceId,
            },
          );
        }
        return { configOptions: options() };
      });
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
      expect(
        bridge
          .getDaemonStatusSnapshot()
          .sessions.find((entry) => entry.sessionId === 'configured')
          ?.currentModelId,
      ).toBe(startupConfig.modelServiceId);
      const abort = new AbortController();
      const events = bridge.subscribeEvents('ordinary', {
        signal: abort.signal,
        lastEventId: 0,
      });
      const replay: string[] = [];
      const reading = (async () => {
        for await (const event of events) replay.push(event.type);
      })();
      await new Promise((resolve) => setTimeout(resolve, 0));
      abort.abort();
      await reading;
      expect(replay).toContain('replay_complete');
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
      ).rejects.toMatchObject({
        code: 'startup_config_rejected',
        message: expect.stringContaining('unsupported effort'),
      });
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
