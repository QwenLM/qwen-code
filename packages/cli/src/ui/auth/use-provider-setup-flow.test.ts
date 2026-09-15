/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  AuthType,
  buildInstallPlan,
  customProvider,
} from '@qwen-code/qwen-code-core';
import type { ProviderConfig } from '@qwen-code/qwen-code-core';
import { useProviderSetupFlow } from './useProviderSetupFlow.js';
import { maskApiKey } from './useAuth.js';

describe('useProviderSetupFlow API selection', () => {
  // A preset has no `protocolOptions`, so the API step never renders for it —
  // but the daemon/ACP contracts accept `wireApi` for any provider id, so a preset
  // can already hold a Responses install.
  const preset: ProviderConfig = {
    id: 'deepseek',
    label: 'DeepSeek',
    description: 'DeepSeek',
    protocol: AuthType.USE_OPENAI,
    baseUrl: 'https://api.deepseek.com/v1',
    envKey: 'DEEPSEEK_API_KEY',
    models: [{ id: 'deepseek-v4' }],
    modelNamePrefix: 'DeepSeek',
  };

  it('previews the same Responses model configuration that it submits', () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useProviderSetupFlow(submit));
    act(() => result.current.start(customProvider));
    act(() => result.current.selectProtocol(AuthType.USE_OPENAI));
    expect(result.current.state.step).toBe('wireApi');
    act(() => result.current.selectWireApi('responses'));
    act(() => result.current.changeBaseUrl('https://gateway.example/v1'));
    act(() => result.current.submitBaseUrl());
    act(() => result.current.submitApiKey('sk-secret-test'));
    act(() => result.current.changeModelIds('model'));
    act(() => result.current.submitModelIds());
    act(() => result.current.toggleFocusedAdvancedOption());
    act(() => result.current.changeContextWindowSize('272000'));
    act(() => result.current.submitAdvancedConfig());
    const preview = JSON.parse(result.current.state.previewJson);
    act(() => result.current.submit());
    const [provider, inputs] = submit.mock.calls[0]!;
    const plan = buildInstallPlan(provider, inputs);
    expect(preview.modelProviders).toEqual({
      openai: plan.modelProviders![0]!.models,
    });
    expect(preview.modelProviders.openai[0]).toMatchObject({
      wireApi: 'responses',
      generationConfig: {
        reasoning: { effort: 'medium' },
        contextWindowSize: 272000,
      },
    });
    expect(preview.security.auth.selectedType).toBe(plan.authType);
    expect(preview.model).toEqual({ name: 'model', baseUrl: inputs.baseUrl });
    expect(Object.values(preview.env)).toEqual([maskApiKey(inputs.apiKey)]);
    expect(result.current.state.previewJson).not.toContain(inputs.apiKey);
  });

  it('uses the saved canonical model metadata in both preview and submit', () => {
    const inputs = {
      protocol: AuthType.USE_OPENAI,
      wireApi: 'responses' as const,
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'test-secret',
      modelIds: ['same'],
    };
    const models = buildInstallPlan(customProvider, inputs).modelProviders![0]!
      .models;
    models[0] = {
      ...models[0]!,
      name: 'Saved name',
      generationConfig: {
        contextWindowSize: 32000,
        samplingParams: { temperature: 0.25 },
      },
    };
    const submit = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useProviderSetupFlow(submit, { openai: models }),
    );
    act(() => result.current.start(customProvider));
    act(() => result.current.selectProtocol(AuthType.USE_OPENAI));
    act(() => result.current.selectWireApi('responses'));
    act(() => result.current.changeBaseUrl(inputs.baseUrl));
    act(() => result.current.submitBaseUrl());
    act(() => result.current.submitApiKey(inputs.apiKey));
    act(() => result.current.changeModelIds('same'));
    act(() => result.current.submitModelIds());
    act(() => result.current.submitAdvancedConfig());
    const preview = JSON.parse(result.current.state.previewJson);
    act(() => result.current.submit());
    const [provider, submittedInputs] = submit.mock.calls[0]!;
    expect(preview.modelProviders.openai).toEqual(
      buildInstallPlan(provider, submittedInputs, models).modelProviders![0]!
        .models,
    );
    expect(preview.modelProviders.openai[0]).toMatchObject({
      name: 'Saved name',
      generationConfig: {
        contextWindowSize: 32000,
        samplingParams: { temperature: 0.25 },
      },
    });
    expect(result.current.state.previewJson).not.toContain(inputs.apiKey);
  });

  it('prefills saved Responses and clears API when switching to Anthropic', () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useProviderSetupFlow(submit));
    act(() =>
      result.current.start(customProvider, AuthType.USE_OPENAI_RESPONSES),
    );
    expect(result.current.state.protocol).toBe(AuthType.USE_OPENAI);
    expect(result.current.state.wireApi).toBe('responses');
    act(() => result.current.selectProtocol(AuthType.USE_OPENAI));
    expect(result.current.state.wireApi).toBe('responses');
    act(() => result.current.goBack());
    act(() => result.current.selectProtocol(AuthType.USE_ANTHROPIC));
    expect(result.current.state.step).toBe('baseUrl');
    act(() => result.current.submit());
    expect(submit.mock.calls[0]![1]).not.toHaveProperty('wireApi');
  });

  it.each([false, true])(
    'preserves saved preset APIs without broadcasting a hidden choice (mixed: %s)',
    (mixed) => {
      const config = {
        ...preset,
        models: mixed
          ? [{ id: 'deepseek-v4' }, { id: 'deepseek-pro' }]
          : preset.models,
        showAdvancedConfig: true,
      };
      const models = [
        {
          id: 'deepseek-v4',
          name: '[DeepSeek] Tuned',
          envKey: 'DEEPSEEK_API_KEY',
          baseUrl: 'https://api.deepseek.com/v1',
          wireApi: 'responses' as const,
        },
        ...(mixed
          ? [
              {
                id: 'deepseek-pro',
                name: '[DeepSeek] Pro',
                envKey: 'DEEPSEEK_API_KEY',
                baseUrl: 'https://api.deepseek.com/v1',
              },
            ]
          : []),
      ];
      const selection = {
        id: 'deepseek-v4',
        authType: AuthType.USE_OPENAI_RESPONSES,
      };
      const submit = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() =>
        useProviderSetupFlow(submit, { openai: models }, undefined, selection),
      );
      act(() => result.current.start(config, AuthType.USE_OPENAI_RESPONSES));
      expect(result.current.state.step).toBe('apiKey');
      act(() => result.current.submitApiKey('sk-secret-test'));
      act(() => result.current.submitAdvancedConfig());
      const preview = JSON.parse(result.current.state.previewJson);
      act(() => result.current.submit());
      expect(submit).toHaveBeenCalledOnce();
      const [provider, inputs] = submit.mock.calls[0]!;
      expect(inputs).not.toHaveProperty('wireApi');
      const plan = buildInstallPlan(provider, inputs, models, selection);
      expect(plan.modelProviders![0]!.models).toEqual(models);
      expect(preview.modelProviders.openai).toEqual(models);
      expect(preview.security.auth.selectedType).toBe(plan.authType);
      expect(plan.authType).toBe(AuthType.USE_OPENAI_RESPONSES);
      expect(preview.model.name).toBe(plan.modelSelection!.modelId);
      expect(result.current.state.previewJson).not.toContain(inputs.apiKey);
    },
  );

  it('omits api when re-authenticating a preset with no Responses install', () => {
    // A preset re-authentication that carries no Responses install must submit
    // without `wireApi`: stamping the default route would make the recorded
    // model-list version irreproducible by buildProviderTemplate and prompt a
    // spurious update on every launch.
    const submit = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useProviderSetupFlow(submit));
    act(() => result.current.start(preset));
    act(() => result.current.submitApiKey('sk-secret-test'));
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0]![1]).not.toHaveProperty('wireApi');
  });

  it('derives the baseUrl placeholder from the effective API route', () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useProviderSetupFlow(submit));
    act(() =>
      result.current.start(customProvider, AuthType.USE_OPENAI_RESPONSES),
    );
    act(() => result.current.selectProtocol(AuthType.USE_OPENAI));
    // The Responses API prefilled from the saved model keeps the protocol
    // reselection on the Responses wire's default endpoint.
    expect(result.current.state.baseUrlPlaceholder).toBe(
      'https://api.openai.com',
    );
    act(() => result.current.selectWireApi('chat-completions'));
    expect(result.current.state.baseUrlPlaceholder).toBe(
      'https://api.openai.com/v1',
    );
    act(() => result.current.goBack());
    act(() => result.current.selectWireApi('responses'));
    expect(result.current.state.baseUrlPlaceholder).toBe(
      'https://api.openai.com',
    );
    act(() => result.current.submitBaseUrl());
    expect(result.current.state.baseUrl).toBe('https://api.openai.com');
    // Switching routes after a blank submit must drop the endpoint auto-filled
    // from the previous route's placeholder — otherwise the install persists
    // the Responses default onto the Chat Completions wire, where the SDK
    // appends no /v1 and every request 404s.
    act(() => result.current.goBack());
    act(() => result.current.goBack());
    act(() => result.current.selectWireApi('chat-completions'));
    expect(result.current.state.baseUrl).toBe('https://api.openai.com/v1');
    expect(result.current.state.baseUrlPlaceholder).toBe(
      'https://api.openai.com/v1',
    );
    act(() => result.current.submitBaseUrl());
    expect(result.current.state.baseUrl).toBe('https://api.openai.com/v1');
  });
  it.each(['responses', 'chat-completions'] as const)(
    'keeps a typed endpoint when selecting %s',
    (wireApi) => {
      const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
      act(() => result.current.start(customProvider));
      act(() => result.current.selectProtocol(AuthType.USE_OPENAI));
      act(() => result.current.selectWireApi('chat-completions'));
      act(() =>
        result.current.changeBaseUrl('https://private-gateway.example/v1'),
      );
      act(() => result.current.goBack());
      act(() => result.current.selectWireApi(wireApi));
      expect(result.current.state.baseUrl).toBe(
        'https://private-gateway.example/v1',
      );
    },
  );
});
