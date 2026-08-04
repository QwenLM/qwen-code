/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook } from '@testing-library/react';
import { AuthType, type ProviderConfig } from '@qwen-code/qwen-code-core';
import { describe, expect, it, vi } from 'vitest';
import { useProviderSetupFlow } from './useProviderSetupFlow.js';

describe('useProviderSetupFlow', () => {
  it('updates endpoint-specific models and API key when selecting a base URL', () => {
    const firstUrl = 'https://first.example/v1';
    const secondUrl = 'https://second.example/v1';
    const provider: ProviderConfig = {
      id: 'endpoint-provider',
      label: 'Endpoint Provider',
      description: 'Provider with endpoint-specific defaults',
      protocol: AuthType.USE_OPENAI,
      baseUrl: [
        {
          id: 'first',
          label: 'First',
          url: firstUrl,
          models: [{ id: 'first-model' }],
        },
        {
          id: 'second',
          label: 'Second',
          url: secondUrl,
          models: [{ id: 'second-model' }],
        },
      ],
      envKey: (_protocol, baseUrl) =>
        baseUrl === firstUrl ? 'FIRST_API_KEY' : 'SECOND_API_KEY',
      modelsEditable: true,
      modelNamePrefix: 'Endpoint',
    };
    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));

    act(() => {
      result.current.start(
        provider,
        undefined,
        {
          FIRST_API_KEY: 'sk-first',
          SECOND_API_KEY: 'sk-second',
        },
        ['custom-model'],
      );
    });

    expect(result.current.state.modelIds).toBe('first-model, custom-model');
    expect(result.current.state.apiKey).toBe('sk-first');

    act(() => {
      result.current.selectBaseUrl(secondUrl);
    });

    expect(result.current.state.baseUrl).toBe(secondUrl);
    expect(result.current.state.modelIds).toBe('second-model, custom-model');
    expect(result.current.state.apiKey).toBe('sk-second');
  });

  it('preserves edited models and API key when reselecting the current endpoint', () => {
    const url = 'https://first.example/v1';
    const provider: ProviderConfig = {
      id: 'endpoint-provider',
      label: 'Endpoint Provider',
      description: 'Provider with endpoint-specific defaults',
      protocol: AuthType.USE_OPENAI,
      baseUrl: [
        {
          id: 'first',
          label: 'First',
          url,
          models: [{ id: 'first-model' }],
        },
      ],
      envKey: () => 'FIRST_API_KEY',
      models: [{ id: 'first-model' }],
      modelsEditable: true,
      modelNamePrefix: 'Endpoint',
    };
    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));

    act(() => {
      result.current.start(provider);
      result.current.changeApiKey('typed-key');
      result.current.changeModelIds('first-model, typed-model');
    });
    act(() => {
      result.current.selectBaseUrl(url);
    });

    expect(result.current.state.apiKey).toBe('typed-key');
    expect(result.current.state.modelIds).toBe('first-model, typed-model');
  });

  it('preserves a typed API key when switching endpoints in the same key domain', () => {
    const firstUrl = 'https://cn.example/v1';
    const secondUrl = 'https://global.example/v1';
    const provider: ProviderConfig = {
      id: 'regional-provider',
      label: 'Regional Provider',
      description: 'Provider with a shared regional credential',
      protocol: AuthType.USE_OPENAI,
      baseUrl: [
        { id: 'cn', label: 'China', url: firstUrl },
        { id: 'global', label: 'Global', url: secondUrl },
      ],
      envKey: () => 'SHARED_API_KEY',
      models: [{ id: 'regional-model' }],
      modelsEditable: true,
      modelNamePrefix: 'Regional',
    };
    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));

    act(() => {
      result.current.start(provider, undefined, {
        SHARED_API_KEY: 'stale-key',
      });
      result.current.changeApiKey('typed-key');
    });
    act(() => {
      result.current.selectBaseUrl(secondUrl);
    });

    expect(result.current.state.baseUrl).toBe(secondUrl);
    expect(result.current.state.apiKey).toBe('typed-key');
  });

  it('restores unsaved API key drafts when returning to a credential domain', () => {
    const firstUrl = 'https://first.example/v1';
    const secondUrl = 'https://second.example/v1';
    const provider: ProviderConfig = {
      id: 'endpoint-provider',
      label: 'Endpoint Provider',
      description: 'Provider with endpoint-specific credentials',
      protocol: AuthType.USE_OPENAI,
      baseUrl: [
        { id: 'first', label: 'First', url: firstUrl },
        { id: 'second', label: 'Second', url: secondUrl },
      ],
      envKey: (_protocol, baseUrl) =>
        baseUrl === firstUrl ? 'FIRST_API_KEY' : 'SECOND_API_KEY',
      models: [{ id: 'endpoint-model' }],
      modelsEditable: true,
      modelNamePrefix: 'Endpoint',
    };
    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));

    act(() => {
      result.current.start(provider, undefined, {
        FIRST_API_KEY: 'stored-first',
        SECOND_API_KEY: 'stored-second',
      });
      result.current.changeApiKey('draft-first');
    });
    act(() => {
      result.current.selectBaseUrl(secondUrl);
    });
    expect(result.current.state.apiKey).toBe('stored-second');

    act(() => {
      result.current.changeApiKey('draft-second');
    });
    act(() => {
      result.current.selectBaseUrl(firstUrl);
    });
    expect(result.current.state.apiKey).toBe('draft-first');

    act(() => {
      result.current.selectBaseUrl(secondUrl);
    });
    expect(result.current.state.apiKey).toBe('draft-second');
  });

  it('starts from a previously installed endpoint', () => {
    const firstUrl = 'https://first.example/v1';
    const secondUrl = 'https://second.example/v1';
    const provider: ProviderConfig = {
      id: 'endpoint-provider',
      label: 'Endpoint Provider',
      description: 'Provider with endpoint-specific defaults',
      protocol: AuthType.USE_OPENAI,
      baseUrl: [
        {
          id: 'first',
          label: 'First',
          url: firstUrl,
          models: [{ id: 'first-model' }],
        },
        {
          id: 'second',
          label: 'Second',
          url: secondUrl,
          models: [{ id: 'second-model' }],
        },
      ],
      envKey: (_protocol, baseUrl) =>
        baseUrl === firstUrl ? 'FIRST_API_KEY' : 'SECOND_API_KEY',
      modelsEditable: true,
      modelNamePrefix: 'Endpoint',
    };
    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));

    act(() => {
      result.current.start(
        provider,
        AuthType.USE_OPENAI,
        {
          FIRST_API_KEY: 'stored-first',
          SECOND_API_KEY: 'stored-second',
        },
        ['custom-model'],
        secondUrl,
      );
    });

    expect(result.current.state.baseUrl).toBe(secondUrl);
    expect(result.current.state.baseUrlOptionIndex).toBe(1);
    expect(result.current.state.apiKey).toBe('stored-second');
    expect(result.current.state.modelIds).toBe('second-model, custom-model');
  });
});
