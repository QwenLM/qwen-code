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
  it('previews the same Responses model configuration that it submits', () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useProviderSetupFlow(submit));
    act(() => result.current.start(customProvider));
    act(() => result.current.selectProtocol(AuthType.USE_OPENAI));
    expect(result.current.state.step).toBe('api');
    act(() => result.current.selectApi('responses'));
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
      api: 'responses',
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

  it('prefills legacy Responses and clears API when switching to Anthropic', () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useProviderSetupFlow(submit));
    act(() =>
      result.current.start(customProvider, AuthType.USE_OPENAI_RESPONSES),
    );
    expect(result.current.state.protocol).toBe(AuthType.USE_OPENAI);
    expect(result.current.state.api).toBe('responses');
    act(() => result.current.selectProtocol(AuthType.USE_OPENAI));
    expect(result.current.state.api).toBe('responses');
    act(() => result.current.goBack());
    act(() => result.current.selectProtocol(AuthType.USE_ANTHROPIC));
    expect(result.current.state.step).toBe('baseUrl');
    act(() => result.current.submit());
    expect(submit.mock.calls[0]![1]).not.toHaveProperty('api');
  });

  it('keeps the prefilled Responses API for a preset provider with no API step', () => {
    // Presets have no `protocolOptions`, so the API step never renders for
    // them — but the daemon/ACP contracts accept `api` for any provider id, so
    // a preset can already hold a Responses install. Re-authenticating it must
    // not silently drop the field and move the user to Chat Completions.
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
    const submit = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useProviderSetupFlow(submit));
    act(() => result.current.start(preset, AuthType.USE_OPENAI_RESPONSES));
    expect(result.current.state.api).toBe('responses');
    act(() => result.current.submitApiKey('sk-secret-test'));
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0]![1]).toMatchObject({ api: 'responses' });
  });

  it('derives the baseUrl placeholder from the effective API route', () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useProviderSetupFlow(submit));
    // A legacy Responses install pre-fills the Responses default endpoint, so
    // re-authentication matches the stored identity (the envKey derivation and
    // the legacy prune both key on the baseUrl string).
    act(() =>
      result.current.start(customProvider, AuthType.USE_OPENAI_RESPONSES),
    );
    expect(result.current.state.baseUrlPlaceholder).toBe(
      'https://api.openai.com',
    );
    act(() => result.current.selectProtocol(AuthType.USE_OPENAI));
    act(() => result.current.selectApi('chat-completions'));
    expect(result.current.state.baseUrlPlaceholder).toBe(
      'https://api.openai.com/v1',
    );
    act(() => result.current.goBack());
    act(() => result.current.selectApi('responses'));
    expect(result.current.state.baseUrlPlaceholder).toBe(
      'https://api.openai.com',
    );
    act(() => result.current.submitBaseUrl());
    expect(result.current.state.baseUrl).toBe('https://api.openai.com');
  });
});
