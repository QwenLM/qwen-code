/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as core from '@qwen-code/core';
import type { Config } from '@qwen-code/core';
import type { SessionHandle, SessionSettings } from '../../session/session.js';
import type { SessionModelInfo } from '../../session/sessionModels.js';
import { testProviderModel } from '../../../../core/src/test-utils/model-resolution.js';
import { createSessionConfig } from './sessionConfig.js';

function fixture(contextWindow?: number, kind?: 'local') {
  const listed = testProviderModel('qwen3.7-max');
  const manager = {
    getMainModel: vi.fn(async () => testProviderModel('local-model')),
    getModel: vi.fn(async () => listed),
    getModelConfig: vi.fn(),
    setModelConfig: vi.fn(),
  };
  const config = {
    directory: '/local/project',
    getModelRequestIdentity: () => 'account',
    getSessionId: () => 'session',
    getModelProviderManager: () => manager,
    getTargetDir() {
      return this.directory;
    },
    getCliVersion: () => '1.0.0',
    getModel: vi.fn(() => 'local-model'),
    getActiveModel: vi.fn(() => 'local-model'),
    getReasoningEffort: vi.fn((_model?: string) => 'low'),
    getContextWindow: vi.fn((): number | undefined => undefined),
    getPermissionMode: vi.fn(() => 'default'),
    setModel: vi.fn(),
    setReasoningEffort: vi.fn((_effort?: core.ReasoningEffortLevel) => {}),
    setContextWindow: vi.fn((_contextWindow?: number) => {}),
    setPermissionMode: vi.fn(),
    persistSessionTitle: vi.fn(),
    setModelPreference: vi.fn(
      (_model: string, _patch: unknown, _persist: boolean) => undefined,
    ),
    resolveEffectiveContextWindow: vi.fn(
      (_model: core.Model | undefined, selected?: number) =>
        core.resolveContextWindow(
          {
            available_context_windows: [200_000, 1_000_000],
            default_context_window: 200_000,
            max_input_tokens: 1_000_000,
          },
          selected,
          1_000_000,
        ),
    ),
  };
  const models: SessionModelInfo[] = [
    {
      modelId: 'qwen3.7-max',
      displayName: 'Remote model',
      source: 'system',
      availableContextWindows: [200_000, 1_000_000],
      defaultContextWindow: 200_000,
      maxInputTokens: 1_000_000,
    },
  ];
  const session = {
    getState: () => ({ models }),
    setModel: vi.fn<SessionHandle['setModel']>(async () => {}),
    setContextWindow: vi.fn(async () => {}),
    setPermissionMode: vi.fn<SessionHandle['setPermissionMode']>(
      async () => {},
    ),
    setTitle: vi.fn(async () => {}),
  };
  const binding = {
    current: {
      kind,
      session: session as unknown as SessionHandle,
      settings: {
        model: 'qwen3.7-max',
        reasoningEffort: 'high',
        contextWindow,
        permissionMode: kind === 'local' ? 'default' : 'acceptEdits',
      } as SessionSettings,
    },
  };
  const errors = vi.fn();
  return {
    config,
    listed,
    manager,
    models,
    session,
    binding,
    errors,
    view: createSessionConfig(
      config as unknown as Config,
      binding,
      errors,
    ) as Config &
      Pick<
        typeof config,
        | 'getReasoningEffort'
        | 'getContextWindow'
        | 'setReasoningEffort'
        | 'setContextWindow'
        | 'setModelPreference'
      >,
  };
}
afterEach(() => vi.restoreAllMocks());

describe('session config compatibility', () => {
  it('reads the main model from the bound session without consulting the local manager', async () => {
    const h = fixture();
    const model = await h.view.getModelProviderManager().getMainModel();
    expect(model.key).toBe('qwen3.7-max');
    expect(model.defaultModelConfig?.context?.contextWindow).toBe(200_000);
    expect(model.limits.maxContextTokens).toBe(1_000_000);
    expect(h.manager.getMainModel).not.toHaveBeenCalled();
    expect(h.manager.getModel).not.toHaveBeenCalled();
  });

  it('follows model changes and replacement session bindings through the same manager view', async () => {
    const h = fixture();
    const manager = h.view.getModelProviderManager();
    h.models.push({
      ...h.models[0]!,
      modelId: 'remote/next',
      source: 'custom',
      provider: 'remote',
      defaultContextWindow: 1_000_000,
    });
    h.binding.current.settings = {
      ...h.binding.current.settings,
      model: 'remote/next',
    };
    const next = await manager.getMainModel();
    expect(next.key).toBe('remote/next');
    expect(next.source).toBe('remote');
    expect(next.defaultModelConfig?.context?.contextWindow).toBe(1_000_000);

    const replacement = fixture();
    h.binding.current = replacement.binding.current;
    expect((await manager.getMainModel()).key).toBe('qwen3.7-max');
    expect(h.manager.getMainModel).not.toHaveBeenCalled();
    expect(replacement.manager.getMainModel).not.toHaveBeenCalled();
  });

  it('rejects a missing bound main model without borrowing the local catalog', async () => {
    const h = fixture();
    h.models.length = 0;
    await expect(h.view.getModelProviderManager().getMainModel()).rejects.toThrow(
      core.ModelNotFoundError,
    );
    expect(h.manager.getMainModel).not.toHaveBeenCalled();
    expect(h.manager.getModel).not.toHaveBeenCalled();
  });

  it('preserves the native provider and other-model preferences for a local binding', () => {
    const h = fixture(undefined, 'local');
    expect(h.view.getModelProviderManager()).toBe(h.manager);
    expect(h.view.getModel()).toBe('local-model');
    const patch = { reasoning: { effort: 'low' } };
    h.view.setModelPreference('another', patch, true);
    expect(h.config.setModelPreference).toHaveBeenCalledExactlyOnceWith(
      'another',
      patch,
      true,
    );
    expect(h.session.setModel).not.toHaveBeenCalled();
  });

  it.each([true, false, undefined])(
    'preserves the native selection scope %s through the session',
    async (sessionOnly) => {
      const h = fixture(undefined, 'local');
      h.session.setModel.mockResolvedValueOnce(true);
      await expect(h.view.setModel('next', sessionOnly)).resolves.toBe(true);
      expect(h.session.setModel).toHaveBeenCalledExactlyOnceWith(
        'next',
        undefined,
        undefined,
        { sessionOnly },
      );
      expect(h.config.setModel).not.toHaveBeenCalled();
      expect(h.config.getModel()).toBe('local-model');
    },
  );

  it('does not report a failed native model save as success', async () => {
    const h = fixture(undefined, 'local');
    h.session.setModel.mockResolvedValueOnce(false);
    await expect(h.view.setModel('next', false)).resolves.toBe(false);
    expect(h.view.getModel()).toBe('local-model');
  });

  it('keeps synchronous permission rejection available to native shortcut fallback', () => {
    const h = fixture(undefined, 'local');
    h.session.setPermissionMode.mockImplementationOnce(() => {
      throw new Error('mode unavailable');
    });
    expect(() =>
      h.view.setPermissionMode('yolo', { trigger: 'shortcut' }),
    ).toThrow('mode unavailable');
    expect(h.view.getPermissionMode()).toBe('default');
    expect(h.errors).not.toHaveBeenCalled();
  });
  it('provides both model aliases and self config while preserving local methods', () => {
    const h = fixture();
    const manager = h.view.getModelProviderManager();
    expect(h.view.getModelProviderManager()).toBe(manager);
    expect(manager.getModelConfig(h.listed)).toEqual({
      reasoning: { effort: 'high' },
      context: { contextWindow: undefined },
    });
    expect(h.manager.getModelConfig).not.toHaveBeenCalled();
    expect(h.view.config).toBe(h.view);
    expect(h.view.getModel()).toBe('qwen3.7-max');
    expect(h.view.getActiveModel()).toBe('qwen3.7-max');
    expect(h.view.getPermissionMode()).toBe('acceptEdits');
    expect(h.view.getTargetDir()).toBe('/local/project');
    expect(h.view.getCliVersion()).toBe('1.0.0');
    expect(h.config.getModel).not.toHaveBeenCalled();
  });
  it('reads updated session state without replacing the view', () => {
    const h = fixture();
    h.binding.current.settings = {
      model: 'next',
      permissionMode: 'default',
      reasoningEffort: 'low',
      contextWindow: 1_000_000,
    };
    expect(h.view.getActiveModel()).toBe('next');
    expect(h.view.getReasoningEffort()).toBe('low');
    expect(h.view.getContextWindow()).toBe(1_000_000);
    expect(h.view.getPermissionMode()).toBe('default');
  });
  it('reports the tracked effort for the current model only and drops other-model preference writes', () => {
    const h = fixture();
    expect(h.view.getReasoningEffort()).toBe('high');
    expect(h.view.getReasoningEffort('qwen3.7-max')).toBe('high');
    expect(h.view.getReasoningEffort('another')).toBeUndefined();
    expect(
      h.view.setModelPreference('another', { effort: 'high' }, false),
    ).toBeUndefined();
    expect(h.config.getReasoningEffort).not.toHaveBeenCalled();
    expect(h.config.setModelPreference).not.toHaveBeenCalled();
  });
  it.each([
    [undefined, 200_000],
    [1_000_000, 1_000_000],
    [300_000, 200_000],
  ])(
    'keeps old effective-window resolution: %s -> %s',
    (selected, expected) => {
      const h = fixture(selected);
      expect(h.view.getEffectiveContextWindow(h.listed)).toBe(expected);
      expect(h.config.resolveEffectiveContextWindow).toHaveBeenCalledWith(
        h.listed,
        selected,
        'qwen3.7-max',
      );
    },
  );
  it('keeps the context-window feature gate', () => {
    vi.spyOn(core, 'isContextWindowSelectionEnabled').mockReturnValue(false);
    const h = fixture(1_000_000);
    expect(h.view.getContextWindow()).toBeUndefined();
    expect(h.view.getEffectiveContextWindow(h.listed)).toBe(
      core.tokenLimit(h.listed),
    );
    expect(h.config.resolveEffectiveContextWindow).not.toHaveBeenCalled();
  });
  it('forwards old setters to the current session without writing local preferences', async () => {
    const h = fixture(200_000);
    await h.view.setModel('next', false);
    expect(h.view.getModel()).toBe('next');
    expect(h.view.getReasoningEffort()).toBe('high');
    expect(h.view.getContextWindow()).toBe(200_000);
    h.view.setReasoningEffort(undefined);
    expect(h.view.getReasoningEffort()).toBeUndefined();
    h.view.setContextWindow(undefined);
    expect(h.view.getContextWindow()).toBeUndefined();
    h.view.setPermissionMode('yolo');
    expect(h.view.getPermissionMode()).toBe('yolo');
    await h.view.persistSessionTitle('Updated');
    expect(h.session.setModel.mock.calls).toEqual([
      ['next', undefined, undefined],
      ['next', undefined, undefined],
    ]);
    expect(h.session.setContextWindow).toHaveBeenCalledWith(undefined);
    expect(h.session.setPermissionMode).toHaveBeenCalledWith('yolo');
    expect(h.session.setTitle).toHaveBeenCalledWith('Updated');
    for (const setter of [
      h.config.setModel,
      h.config.setReasoningEffort,
      h.config.setContextWindow,
      h.config.setPermissionMode,
      h.config.persistSessionTitle,
    ])
      expect(setter).not.toHaveBeenCalled();
  });
  it('uses replacement operations from the binding and reports rejected writes', async () => {
    const h = fixture();
    const setModel = vi.fn(async () => {
      throw new Error('rejected');
    });
    h.binding.current.session = { ...h.binding.current.session, setModel };
    await expect(h.view.setModel('new')).rejects.toThrow('rejected');
    expect(h.view.getModel()).toBe('qwen3.7-max');
    expect(h.session.setModel).not.toHaveBeenCalled();
    expect(h.config.setModel).not.toHaveBeenCalled();
    h.session.setTitle.mockRejectedValueOnce(new Error('title rejected'));
    await expect(h.view.persistSessionTitle('Updated')).rejects.toThrow(
      'title rejected',
    );
  });
});
