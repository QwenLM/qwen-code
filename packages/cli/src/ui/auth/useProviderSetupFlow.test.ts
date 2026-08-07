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

  it('preserves typed ids colliding with a sibling endpoint built-in when switching', () => {
    const codeUrl = 'https://code.example/v1';
    const apiCnUrl = 'https://api-cn.example/v1';
    const apiIntlUrl = 'https://api-intl.example/v1';
    const provider: ProviderConfig = {
      id: 'three-endpoint-provider',
      label: 'Three Endpoint Provider',
      description: 'Provider with three endpoints',
      protocol: AuthType.USE_OPENAI,
      baseUrl: [
        {
          id: 'code',
          label: 'Code',
          url: codeUrl,
          models: [{ id: 'code-model' }],
        },
        {
          id: 'api-cn',
          label: 'API China',
          url: apiCnUrl,
          models: [{ id: 'api-model' }],
        },
        {
          id: 'api-intl',
          label: 'API International',
          url: apiIntlUrl,
          models: [{ id: 'api-model' }],
        },
      ],
      envKey: (_protocol, baseUrl) =>
        baseUrl === codeUrl ? 'CODE_API_KEY' : 'API_KEY',
      modelsEditable: true,
      modelNamePrefix: 'Three',
    };
    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));

    act(() => {
      result.current.start(
        provider,
        undefined,
        undefined,
        ['code-model'],
        apiCnUrl,
      );
    });
    act(() => {
      result.current.selectBaseUrl(apiIntlUrl);
    });

    expect(result.current.state.modelIds).toBe('api-model, code-model');
  });

  it('keeps seeded custom ids that collide with a destination built-in across a round trip', () => {
    const firstUrl = 'https://first.example/v1';
    const secondUrl = 'https://second.example/v1';
    const provider: ProviderConfig = {
      id: 'collision-provider',
      label: 'Collision Provider',
      description: 'Provider with colliding endpoint model IDs',
      protocol: AuthType.USE_OPENAI,
      baseUrl: [
        {
          id: 'first',
          label: 'First',
          url: firstUrl,
          models: [{ id: 'first-default' }],
        },
        {
          id: 'second',
          label: 'Second',
          url: secondUrl,
          models: [{ id: 'shared-id' }],
        },
      ],
      envKey: () => 'COLLISION_API_KEY',
      modelsEditable: true,
      modelNamePrefix: 'Collision',
    };
    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));

    act(() => {
      result.current.start(provider, undefined, undefined, ['shared-id']);
    });
    act(() => {
      result.current.selectBaseUrl(secondUrl);
    });
    expect(result.current.state.modelIds).toBe('shared-id');

    act(() => {
      result.current.selectBaseUrl(firstUrl);
    });
    expect(result.current.state.modelIds).toBe('first-default, shared-id');
  });

  it('rebuilds endpoint defaults after a net-zero model edit', () => {
    const firstUrl = 'https://first.example/v1';
    const secondUrl = 'https://second.example/v1';
    const provider: ProviderConfig = {
      id: 'net-zero-provider',
      label: 'Net Zero Provider',
      description: 'Provider with endpoint defaults',
      protocol: AuthType.USE_OPENAI,
      baseUrl: [
        {
          id: 'first',
          label: 'First',
          url: firstUrl,
          models: [{ id: 'first-default' }],
        },
        {
          id: 'second',
          label: 'Second',
          url: secondUrl,
          models: [{ id: 'second-default' }],
        },
      ],
      envKey: () => 'NET_ZERO_API_KEY',
      modelsEditable: true,
      modelNamePrefix: 'Net Zero',
    };
    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));

    act(() => {
      result.current.start(provider);
    });
    act(() => {
      result.current.changeModelIds('temporary');
    });
    act(() => {
      result.current.changeModelIds('first-default');
    });
    act(() => {
      result.current.selectBaseUrl(secondUrl);
    });

    expect(result.current.state.modelIds).toBe('second-default');
  });

  it('does not resurrect deselected defaults after an endpoint round trip', () => {
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
          models: [{ id: 'first-model-a' }, { id: 'first-model-b' }],
        },
        {
          id: 'second',
          label: 'Second',
          url: secondUrl,
          models: [{ id: 'second-model' }],
        },
      ],
      envKey: () => 'SHARED_API_KEY',
      modelsEditable: true,
      modelNamePrefix: 'Endpoint',
    };
    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));

    act(() => {
      result.current.start(provider);
    });
    expect(result.current.state.modelIds).toBe('first-model-a, first-model-b');

    // The user unchecks first-model-b at the models step; the deselection
    // must survive an A→B→A endpoint round trip.
    act(() => {
      result.current.changeModelIds('first-model-a');
    });
    act(() => {
      result.current.selectBaseUrl(secondUrl);
    });
    act(() => {
      result.current.selectBaseUrl(firstUrl);
    });

    expect(result.current.state.modelIds).toBe('first-model-a');
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
      // Drop the built-in so an unguarded recompute (which re-prepends it)
      // cannot reproduce the edit byte-for-byte.
      result.current.changeModelIds('typed-model');
    });
    act(() => {
      result.current.selectBaseUrl(url);
    });

    expect(result.current.state.apiKey).toBe('typed-key');
    expect(result.current.state.modelIds).toBe('typed-model');
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

  it('clears stale field errors when switching endpoints', () => {
    const firstUrl = 'https://first.example/v1';
    const secondUrl = 'https://second.example/v1';
    const provider: ProviderConfig = {
      id: 'endpoint-provider',
      label: 'Endpoint Provider',
      description: 'Provider with endpoint-specific defaults',
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
        FIRST_API_KEY: 'sk-first',
        SECOND_API_KEY: 'sk-second',
      });
      result.current.changeApiKey('');
    });
    act(() => {
      expect(result.current.submitApiKey()).toBe(false);
    });
    expect(result.current.state.apiKeyError).not.toBeNull();

    act(() => {
      result.current.changeModelIds('');
    });
    act(() => {
      expect(result.current.submitModelIds()).toBe(false);
    });
    expect(result.current.state.modelIdsError).not.toBeNull();

    act(() => {
      result.current.selectBaseUrl(secondUrl);
    });

    expect(result.current.state.apiKey).toBe('sk-second');
    expect(result.current.state.apiKeyError).toBeNull();
    expect(result.current.state.modelIdsError).toBeNull();
  });

  it('preserves seeded endpoint and key when reselecting the saved protocol', () => {
    const provider: ProviderConfig = {
      id: 'multi-protocol-provider',
      label: 'Multi Protocol Provider',
      description: 'Provider with a protocol step',
      protocol: AuthType.USE_OPENAI,
      protocolOptions: [AuthType.USE_OPENAI, AuthType.USE_ANTHROPIC],
      envKey: (protocol) =>
        protocol === AuthType.USE_ANTHROPIC
          ? 'ANTHROPIC_API_KEY'
          : 'OPENAI_API_KEY',
      modelsEditable: true,
      modelNamePrefix: 'Multi',
    };
    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));

    act(() => {
      result.current.start(
        provider,
        AuthType.USE_ANTHROPIC,
        { ANTHROPIC_API_KEY: 'sk-stored' },
        [],
        'https://my-proxy.example/v1',
      );
    });

    act(() => {
      result.current.selectProtocol(AuthType.USE_ANTHROPIC);
    });
    expect(result.current.state.baseUrl).toBe('https://my-proxy.example/v1');
    expect(result.current.state.apiKey).toBe('sk-stored');

    act(() => {
      result.current.changeApiKey('sk-new-rotated');
    });

    act(() => {
      result.current.selectProtocol(AuthType.USE_OPENAI);
    });
    expect(result.current.state.baseUrl).toBe('');
    expect(result.current.state.apiKey).toBe('');

    // A seeded→other→seeded round trip restores the saved endpoint and key
    // instead of falling back to the protocol-default placeholder.
    act(() => {
      result.current.selectProtocol(AuthType.USE_ANTHROPIC);
    });
    expect(result.current.state.baseUrl).toBe('https://my-proxy.example/v1');
    expect(result.current.state.baseUrlPlaceholder).toBe('');
    expect(result.current.state.apiKey).toBe('sk-new-rotated');
  });

  it('does not leak API key drafts into the next provider flow', () => {
    const aFirstUrl = 'https://a-first.example/v1';
    const aSecondUrl = 'https://a-second.example/v1';
    const providerA: ProviderConfig = {
      id: 'provider-a',
      label: 'Provider A',
      description: 'First provider',
      protocol: AuthType.USE_OPENAI,
      baseUrl: [
        { id: 'a-first', label: 'A First', url: aFirstUrl },
        { id: 'a-second', label: 'A Second', url: aSecondUrl },
      ],
      envKey: (_protocol, baseUrl) =>
        baseUrl === aFirstUrl ? 'A_FIRST_API_KEY' : 'SHARED_API_KEY',
      modelsEditable: true,
      modelNamePrefix: 'A',
    };
    const bFirstUrl = 'https://b-first.example/v1';
    const bSecondUrl = 'https://b-second.example/v1';
    const providerB: ProviderConfig = {
      id: 'provider-b',
      label: 'Provider B',
      description: 'Second provider sharing the env-key domain',
      protocol: AuthType.USE_OPENAI,
      baseUrl: [
        { id: 'b-first', label: 'B First', url: bFirstUrl },
        { id: 'b-second', label: 'B Second', url: bSecondUrl },
      ],
      envKey: (_protocol, baseUrl) =>
        baseUrl === bFirstUrl ? 'B_FIRST_API_KEY' : 'SHARED_API_KEY',
      modelsEditable: true,
      modelNamePrefix: 'B',
    };
    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));

    act(() => {
      result.current.start(providerA);
    });
    act(() => {
      result.current.selectBaseUrl(aSecondUrl);
    });
    act(() => {
      result.current.changeApiKey('draft-a');
    });
    act(() => {
      // Switching away stashes 'draft-a' under SHARED_API_KEY.
      result.current.selectBaseUrl(aFirstUrl);
    });

    act(() => {
      result.current.start(providerB, undefined, {
        SHARED_API_KEY: 'stored-shared',
      });
    });
    expect(result.current.state.apiKey).toBe('');

    act(() => {
      result.current.selectBaseUrl(bSecondUrl);
    });
    // Provider B must see the stored env value, never provider A's draft.
    expect(result.current.state.apiKey).toBe('stored-shared');
  });

  it('resets dirty model state when starting another provider flow', () => {
    const providerA: ProviderConfig = {
      id: 'provider-a',
      label: 'Provider A',
      description: 'First provider',
      protocol: AuthType.USE_OPENAI,
      baseUrl: [
        {
          id: 'a-first',
          label: 'A First',
          url: 'https://a-first.example/v1',
          models: [{ id: 'a-first-model' }],
        },
      ],
      envKey: () => 'A_API_KEY',
      modelsEditable: true,
      modelNamePrefix: 'A',
    };
    const bFirstUrl = 'https://b-first.example/v1';
    const bSecondUrl = 'https://b-second.example/v1';
    const providerB: ProviderConfig = {
      id: 'provider-b',
      label: 'Provider B',
      description: 'Second provider',
      protocol: AuthType.USE_OPENAI,
      baseUrl: [
        {
          id: 'b-first',
          label: 'B First',
          url: bFirstUrl,
          models: [{ id: 'b-first-model' }],
        },
        {
          id: 'b-second',
          label: 'B Second',
          url: bSecondUrl,
          models: [{ id: 'b-second-model' }],
        },
      ],
      envKey: () => 'B_API_KEY',
      modelsEditable: true,
      modelNamePrefix: 'B',
    };
    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));

    act(() => {
      result.current.start(providerA);
    });
    act(() => {
      result.current.changeModelIds('a-custom-model');
    });
    act(() => {
      result.current.start(providerB);
    });
    act(() => {
      result.current.selectBaseUrl(bSecondUrl);
    });

    expect(result.current.state.modelIds).toBe('b-second-model');
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
