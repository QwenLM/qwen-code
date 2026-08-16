/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook } from '@testing-library/react';
import {
  applyProviderInstallPlan,
  AuthType,
  buildInstallPlan,
  customProvider,
  generateCustomEnvKey,
  type ModelProvidersConfig,
  type ProviderConfig,
} from '@qwen-code/qwen-code-core';
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

  it('restores saved model selections for every endpoint', () => {
    const firstUrl = 'https://first.example/v1';
    const secondUrl = 'https://second.example/v1';
    const provider: ProviderConfig = {
      id: 'saved-endpoint-provider',
      label: 'Saved Endpoint Provider',
      description: 'Provider with saved models at sibling endpoints',
      protocol: AuthType.USE_OPENAI,
      baseUrl: [
        {
          id: 'first',
          label: 'First',
          url: firstUrl,
          models: [{ id: 'first-a' }, { id: 'first-b' }],
        },
        {
          id: 'second',
          label: 'Second',
          url: secondUrl,
          models: [{ id: 'second-a' }, { id: 'second-b' }],
        },
      ],
      envKey: () => 'SAVED_API_KEY',
      modelsEditable: true,
      modelNamePrefix: 'Saved',
      mergeModelsByIdentity: true,
    };
    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));

    act(() => {
      result.current.start(
        provider,
        undefined,
        undefined,
        ['custom-first'],
        firstUrl,
        ['first-b'],
        new Map([
          [firstUrl, ['first-a', 'custom-first']],
          [secondUrl, ['second-b', 'custom-second']],
        ]),
      );
    });

    expect(result.current.state.modelIds).toBe('first-a, custom-first');

    act(() => {
      result.current.selectBaseUrl(secondUrl);
    });

    expect(result.current.state.modelIds).toBe('second-b, custom-second');
  });

  it('submits a saved sibling selection without deleting its custom model', async () => {
    const firstUrl = 'https://first.example/v1';
    const secondUrl = 'https://second.example/v1';
    const provider: ProviderConfig = {
      id: 'saved-submit-provider',
      label: 'Saved Submit Provider',
      description: 'Provider with persisted sibling model choices',
      protocol: AuthType.USE_OPENAI,
      baseUrl: [
        {
          id: 'first',
          label: 'First',
          url: firstUrl,
          models: [{ id: 'first-a' }, { id: 'first-b' }],
        },
        {
          id: 'second',
          label: 'Second',
          url: secondUrl,
          models: [{ id: 'second-a' }, { id: 'second-b' }],
        },
      ],
      envKey: () => 'SAVED_API_KEY',
      modelsEditable: true,
      modelNamePrefix: 'Saved',
      mergeModelsByIdentity: true,
      ownsModel: (model) => model.envKey === 'SAVED_API_KEY',
    };
    const firstCustom = {
      id: 'custom-first',
      name: '[Saved] custom-first',
      baseUrl: firstUrl,
      envKey: 'SAVED_API_KEY',
    };
    const secondCustom = {
      id: 'custom-second',
      name: '[Saved] custom-second',
      baseUrl: secondUrl,
      envKey: 'SAVED_API_KEY',
    };
    let modelProviders: ModelProvidersConfig = {
      [AuthType.USE_OPENAI]: [
        {
          id: 'first-a',
          name: '[Saved] first-a',
          baseUrl: firstUrl,
          envKey: 'SAVED_API_KEY',
        },
        firstCustom,
        {
          id: 'second-b',
          name: '[Saved] second-b',
          baseUrl: secondUrl,
          envKey: 'SAVED_API_KEY',
        },
        secondCustom,
      ],
    };
    const setValue = vi.fn();
    const onSubmit = vi.fn(async (_config, inputs) => {
      const plan = buildInstallPlan(provider, inputs);
      await applyProviderInstallPlan(plan, {
        settings: {
          getValue: vi.fn(),
          setValue,
          getModelProviders: () => modelProviders,
          persist: vi.fn(),
        },
        reloadModelProviders: (next) => {
          modelProviders = next;
        },
        doRefreshAuth: false,
      });
    });
    const { result } = renderHook(() => useProviderSetupFlow(onSubmit));

    act(() => {
      result.current.start(
        provider,
        undefined,
        undefined,
        ['custom-first'],
        firstUrl,
        ['first-b'],
        new Map([
          [firstUrl, ['first-a', 'custom-first']],
          [secondUrl, ['second-b', 'custom-second']],
        ]),
      );
    });
    act(() => {
      result.current.selectBaseUrl(secondUrl);
    });

    await act(async () => {
      result.current.submit();
    });

    expect(modelProviders[AuthType.USE_OPENAI]).toEqual([
      expect.objectContaining({ id: 'first-a', baseUrl: firstUrl }),
      firstCustom,
      expect.objectContaining({ id: 'second-b', baseUrl: secondUrl }),
      expect.objectContaining({ id: 'custom-second', baseUrl: secondUrl }),
    ]);
    expect(
      modelProviders[AuthType.USE_OPENAI]?.filter(
        (model) => model.id === 'second-a',
      ),
    ).toEqual([]);
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
          models: [{ id: 'shared-id' }, { id: 'second-default' }],
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
    expect(result.current.state.modelIds).toBe('shared-id, second-default');

    act(() => {
      result.current.changeModelIds('shared-id');
    });
    act(() => {
      result.current.changeModelIds('shared-id, second-default');
    });

    act(() => {
      result.current.selectBaseUrl(firstUrl);
    });
    expect(result.current.state.modelIds).toBe('first-default, shared-id');
  });

  it('keeps a seeded custom id deselected as a sibling endpoint recommendation', () => {
    const firstUrl = 'https://first.example/v1';
    const secondUrl = 'https://second.example/v1';
    const provider: ProviderConfig = {
      id: 'sibling-uncheck-provider',
      label: 'Sibling Uncheck Provider',
      description:
        'Provider whose second endpoint has a built-in colliding with a seeded custom id',
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
          models: [{ id: 'shared-id' }, { id: 'second-default' }],
        },
      ],
      envKey: () => 'SIBLING_API_KEY',
      modelsEditable: true,
      modelNamePrefix: 'Sibling',
    };
    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));

    act(() => {
      result.current.start(provider, undefined, undefined, ['shared-id']);
    });
    expect(result.current.state.modelIds).toBe('first-default, shared-id');

    act(() => {
      result.current.selectBaseUrl(secondUrl);
    });
    expect(result.current.state.modelIds).toBe('shared-id, second-default');

    act(() => {
      // Unchecking the 'shared-id' recommendation means "do not install this
      // built-in here" — it must not delete the seeded custom provenance.
      result.current.changeModelIds('second-default');
    });
    expect(result.current.state.modelIds).toBe('second-default');

    act(() => {
      result.current.selectBaseUrl(firstUrl);
    });
    expect(result.current.state.modelIds).toBe('first-default, shared-id');

    act(() => {
      result.current.selectBaseUrl(secondUrl);
    });
    expect(result.current.state.modelIds).toBe('second-default');
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

  it('rebuilds endpoint defaults after a net-zero edit with seeded custom ids', () => {
    const firstUrl = 'https://first.example/v1';
    const secondUrl = 'https://second.example/v1';
    const provider: ProviderConfig = {
      id: 'seeded-custom-net-zero-provider',
      label: 'Seeded Custom Net Zero Provider',
      description: 'Provider with endpoint defaults and a saved custom id',
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
      result.current.start(provider, undefined, undefined, ['custom-model']);
    });
    act(() => {
      result.current.changeModelIds('temporary');
    });
    act(() => {
      result.current.changeModelIds('custom-model, first-default');
    });
    act(() => {
      result.current.selectBaseUrl(secondUrl);
    });

    expect(result.current.state.modelIds).toBe('second-default, custom-model');
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

  it('does not resurrect persisted default trims after an endpoint round trip', () => {
    const firstUrl = 'https://first.example/v1';
    const secondUrl = 'https://second.example/v1';
    const provider: ProviderConfig = {
      id: 'persisted-trim-provider',
      label: 'Persisted Trim Provider',
      description: 'Provider with a saved default trim',
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
      modelNamePrefix: 'Persisted Trim',
    };
    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));

    act(() => {
      result.current.start(
        provider,
        undefined,
        undefined,
        ['shared-id'],
        firstUrl,
        ['first-model-b'],
      );
    });
    expect(result.current.state.modelIds).toBe('first-model-a, shared-id');

    act(() => {
      result.current.changeModelIds('first-model-a');
    });
    act(() => {
      result.current.changeModelIds('first-model-a, shared-id');
    });

    act(() => {
      result.current.selectBaseUrl(secondUrl);
    });
    expect(result.current.state.modelIds).toBe('second-model, shared-id');
    act(() => {
      result.current.selectBaseUrl(firstUrl);
    });

    expect(result.current.state.modelIds).toBe('first-model-a, shared-id');
  });

  it('keeps persisted default trims across a round trip without field edits', () => {
    const firstUrl = 'https://first.example/v1';
    const secondUrl = 'https://second.example/v1';
    const provider: ProviderConfig = {
      id: 'persisted-trim-no-edit-provider',
      label: 'Persisted Trim No Edit Provider',
      description: 'Provider with a saved default trim',
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
      modelNamePrefix: 'Persisted Trim',
    };
    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));

    act(() => {
      result.current.start(
        provider,
        undefined,
        undefined,
        ['shared-id'],
        firstUrl,
        ['first-model-b'],
      );
    });
    expect(result.current.state.modelIds).toBe('first-model-a, shared-id');

    // No field edits: the seeded trim alone must keep the deleted default
    // deleted across the round trip.
    act(() => {
      result.current.selectBaseUrl(secondUrl);
    });
    expect(result.current.state.modelIds).toBe('second-model, shared-id');
    act(() => {
      result.current.selectBaseUrl(firstUrl);
    });

    expect(result.current.state.modelIds).toBe('first-model-a, shared-id');
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

  it('restores edited endpoint, key, and models together across protocol switches', () => {
    const provider: ProviderConfig = {
      id: 'custom-multi-protocol-provider',
      label: 'Custom Multi Protocol Provider',
      description: 'Custom provider with protocol-specific endpoint drafts',
      protocol: AuthType.USE_OPENAI,
      protocolOptions: [AuthType.USE_OPENAI, AuthType.USE_ANTHROPIC],
      envKey: (selectedProtocol, selectedBaseUrl) =>
        `${selectedProtocol}:${selectedBaseUrl}`,
      modelsEditable: true,
      modelNamePrefix: 'Custom',
    };
    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));

    act(() => {
      result.current.start(
        provider,
        AuthType.USE_OPENAI,
        { 'openai:https://saved.example/v1': 'sk-saved' },
        [],
        'https://saved.example/v1',
      );
    });
    act(() => {
      result.current.changeBaseUrl('https://edited.example/v1');
      result.current.changeApiKey('sk-edited');
      result.current.changeModelIds('openai-a, openai-b');
    });
    act(() => {
      result.current.selectProtocol(AuthType.USE_ANTHROPIC);
    });
    expect(result.current.state.modelIds).toBe('');
    act(() => {
      result.current.changeBaseUrl('https://anthropic-proxy.example/v1');
      result.current.changeApiKey('sk-anthropic');
      result.current.changeModelIds('anthropic-a');
    });
    act(() => {
      result.current.selectProtocol(AuthType.USE_OPENAI);
    });
    expect(result.current.state.baseUrl).toBe('https://edited.example/v1');
    expect(result.current.state.apiKey).toBe('sk-edited');
    expect(result.current.state.modelIds).toBe('openai-a, openai-b');

    act(() => {
      result.current.selectProtocol(AuthType.USE_ANTHROPIC);
    });
    expect(result.current.state.baseUrl).toBe(
      'https://anthropic-proxy.example/v1',
    );
    expect(result.current.state.apiKey).toBe('sk-anthropic');
    expect(result.current.state.modelIds).toBe('anthropic-a');
  });

  it('restores the credential for a submitted custom endpoint', () => {
    const firstUrl = 'https://first.example/v1';
    const secondUrl = 'https://second.example/v1';
    const unknownUrl = 'https://unknown.example/v1';
    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));

    act(() => {
      result.current.start(
        customProvider,
        AuthType.USE_OPENAI,
        {
          [generateCustomEnvKey(AuthType.USE_OPENAI, firstUrl)]: 'sk-first',
          [generateCustomEnvKey(AuthType.USE_OPENAI, secondUrl)]: 'sk-second',
        },
        [],
        firstUrl,
      );
    });

    act(() => {
      result.current.changeBaseUrl(secondUrl);
    });
    act(() => {
      expect(result.current.submitBaseUrl()).toBe(true);
    });
    expect(result.current.state.apiKey).toBe('sk-second');

    act(() => {
      result.current.changeBaseUrl(`${firstUrl}/`);
    });
    act(() => {
      expect(result.current.submitBaseUrl()).toBe(true);
    });
    expect(result.current.state.apiKey).toBe('sk-first');

    act(() => {
      result.current.changeBaseUrl(unknownUrl);
    });
    act(() => {
      expect(result.current.submitBaseUrl()).toBe(true);
    });
    expect(result.current.state.apiKey).toBe('');

    act(() => {
      result.current.changeBaseUrl(secondUrl);
    });
    act(() => {
      expect(result.current.submitBaseUrl()).toBe(true);
    });
    expect(result.current.state.apiKey).toBe('sk-second');
  });

  it('restores saved models when submitting a custom endpoint', async () => {
    const firstUrl = 'https://first.example/v1';
    const secondUrl = 'https://second.example/v1';
    const onSubmit = vi.fn(async () => undefined);
    const firstPreserved = {
      id: 'first-custom',
      baseUrl: firstUrl,
      envKey: generateCustomEnvKey(AuthType.USE_OPENAI, firstUrl),
      generationConfig: { contextWindowSize: 11111 },
    };
    const secondPreserved = {
      id: 'second-custom',
      baseUrl: secondUrl,
      envKey: generateCustomEnvKey(AuthType.USE_OPENAI, secondUrl),
      generationConfig: { contextWindowSize: 22222 },
    };
    const { result } = renderHook(() => useProviderSetupFlow(onSubmit));

    act(() => {
      result.current.start(
        customProvider,
        AuthType.USE_OPENAI,
        {
          [generateCustomEnvKey(AuthType.USE_OPENAI, firstUrl)]: 'sk-first',
          [generateCustomEnvKey(AuthType.USE_OPENAI, secondUrl)]: 'sk-second',
        },
        ['first-custom'],
        firstUrl,
        undefined,
        new Map([
          [firstUrl, ['first-custom']],
          [secondUrl, ['second-custom']],
        ]),
        [firstPreserved, secondPreserved],
      );
      result.current.changeBaseUrl(secondUrl);
    });
    act(() => {
      expect(result.current.submitBaseUrl()).toBe(true);
    });
    expect(result.current.state.modelIds).toBe('second-custom');
    expect(result.current.state.apiKey).toBe('sk-second');

    await act(async () => {
      result.current.submit();
    });
    expect(onSubmit).toHaveBeenLastCalledWith(
      customProvider,
      expect.objectContaining({
        baseUrl: secondUrl,
        apiKey: 'sk-second',
        modelIds: ['second-custom'],
        preserveModels: [secondPreserved],
      }),
    );

    act(() => {
      result.current.changeBaseUrl(`${firstUrl}/`);
    });
    act(() => {
      expect(result.current.submitBaseUrl()).toBe(true);
    });
    expect(result.current.state.modelIds).toBe('first-custom');
    expect(result.current.state.apiKey).toBe('sk-first');
  });

  it('passes exact preserved model objects through submit', async () => {
    const baseUrl = 'https://api.deepseek.com';
    const proxyCustom = {
      id: 'proxy-custom',
      name: '[DeepSeek] proxy-custom',
      baseUrl: 'https://corp-proxy.example/v1',
      envKey: 'DEEPSEEK_API_KEY',
      generationConfig: { contextWindowSize: 12345 },
    };
    const provider: ProviderConfig = {
      id: 'non-merge-provider',
      label: 'Non-merge Provider',
      description: 'Provider with provider-wide replacement semantics',
      protocol: AuthType.USE_OPENAI,
      baseUrl,
      envKey: 'DEEPSEEK_API_KEY',
      models: [{ id: 'default-model' }],
      modelsEditable: true,
      modelNamePrefix: 'DeepSeek',
    };
    const onSubmit = vi.fn(async () => undefined);
    const { result } = renderHook(() => useProviderSetupFlow(onSubmit));

    act(() => {
      result.current.start(
        provider,
        undefined,
        { DEEPSEEK_API_KEY: 'sk-test' },
        [],
        baseUrl,
        undefined,
        undefined,
        [proxyCustom],
      );
    });
    await act(async () => {
      result.current.submit();
    });

    expect(onSubmit).toHaveBeenCalledWith(
      provider,
      expect.objectContaining({ preserveModels: [proxyCustom] }),
    );
  });

  it('preserves selected rich merge customs without reviving removed ids', async () => {
    const baseUrl = 'https://api.kimi.com/coding/v1';
    const richCustom = {
      id: 'my-custom',
      name: '[Kimi Code] my-custom',
      baseUrl,
      envKey: 'KIMI_CODE_API_KEY',
      generationConfig: { contextWindowSize: 12345 },
    };
    const provider: ProviderConfig = {
      id: 'merge-provider',
      label: 'Merge Provider',
      description: 'Identity-merged provider',
      protocol: AuthType.USE_OPENAI,
      baseUrl: [
        {
          id: 'coding',
          label: 'Coding',
          url: baseUrl,
          models: [{ id: 'default-model' }],
        },
      ],
      envKey: 'KIMI_CODE_API_KEY',
      models: [{ id: 'default-model' }],
      modelsEditable: true,
      modelNamePrefix: 'Kimi Code',
      mergeModelsByIdentity: true,
    };
    const onSubmit = vi.fn(async () => undefined);
    const { result } = renderHook(() => useProviderSetupFlow(onSubmit));

    act(() => {
      result.current.start(
        provider,
        undefined,
        { KIMI_CODE_API_KEY: 'sk-test' },
        ['my-custom'],
        baseUrl,
        undefined,
        undefined,
        [richCustom],
      );
    });
    await act(async () => result.current.submit());
    expect(onSubmit).toHaveBeenLastCalledWith(
      provider,
      expect.objectContaining({ preserveModels: [richCustom] }),
    );

    act(() => result.current.changeModelIds('default-model'));
    await act(async () => result.current.submit());
    expect(onSubmit).toHaveBeenLastCalledWith(
      provider,
      expect.not.objectContaining({ preserveModels: expect.anything() }),
    );
  });

  it('keeps a promoted protocol default endpoint in its protocol draft', () => {
    const provider: ProviderConfig = {
      id: 'fresh-custom-provider',
      label: 'Fresh Custom Provider',
      description: 'Custom provider with protocol defaults',
      protocol: AuthType.USE_OPENAI,
      protocolOptions: [AuthType.USE_OPENAI, AuthType.USE_ANTHROPIC],
      envKey: (selectedProtocol, selectedBaseUrl) =>
        `${selectedProtocol}:${selectedBaseUrl}`,
      modelsEditable: true,
      modelNamePrefix: 'Custom',
    };
    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));

    act(() => {
      result.current.start(provider, AuthType.USE_OPENAI);
    });
    act(() => {
      expect(result.current.submitBaseUrl()).toBe(true);
    });
    act(() => {
      result.current.changeApiKey('sk-openai');
    });
    act(() => {
      result.current.selectProtocol(AuthType.USE_ANTHROPIC);
    });
    act(() => {
      result.current.selectProtocol(AuthType.USE_OPENAI);
    });

    expect(result.current.state.baseUrl).toBe('https://api.openai.com/v1');
    expect(result.current.state.apiKey).toBe('sk-openai');
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

  it('does not leak protocol drafts into the next provider flow', () => {
    const providerA: ProviderConfig = {
      id: 'provider-a',
      label: 'Provider A',
      description: 'First multi-protocol provider',
      protocol: AuthType.USE_OPENAI,
      protocolOptions: [AuthType.USE_OPENAI, AuthType.USE_ANTHROPIC],
      envKey: (protocol) =>
        protocol === AuthType.USE_ANTHROPIC
          ? 'A_ANTHROPIC_API_KEY'
          : 'A_OPENAI_API_KEY',
      modelsEditable: true,
      modelNamePrefix: 'A',
    };
    const providerB: ProviderConfig = {
      id: 'provider-b',
      label: 'Provider B',
      description: 'Second multi-protocol provider',
      protocol: AuthType.USE_OPENAI,
      protocolOptions: [AuthType.USE_OPENAI, AuthType.USE_ANTHROPIC],
      envKey: (protocol) =>
        protocol === AuthType.USE_ANTHROPIC
          ? 'B_ANTHROPIC_API_KEY'
          : 'B_OPENAI_API_KEY',
      modelsEditable: true,
      modelNamePrefix: 'B',
    };
    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));

    act(() => {
      result.current.start(providerA);
    });
    act(() => {
      result.current.selectProtocol(AuthType.USE_ANTHROPIC);
    });
    act(() => {
      result.current.changeBaseUrl('https://a-anthropic.example/v1');
      result.current.changeApiKey('sk-a-anthropic');
    });
    act(() => {
      // Leaving the protocol stashes the endpoint and key under its draft.
      result.current.selectProtocol(AuthType.USE_OPENAI);
    });

    act(() => {
      result.current.start(providerB);
    });
    act(() => {
      result.current.selectProtocol(AuthType.USE_ANTHROPIC);
    });

    // Provider A's protocol draft must not resurface under provider B.
    expect(result.current.state.baseUrl).toBe('');
    expect(result.current.state.apiKey).toBe('');
  });

  it('resets dirty model state when starting another provider flow', () => {
    const sharedUrl = 'https://shared.example/v1';
    const providerA: ProviderConfig = {
      id: 'provider-a',
      label: 'Provider A',
      description: 'First provider',
      protocol: AuthType.USE_OPENAI,
      baseUrl: [
        {
          id: 'a-shared',
          label: 'A Shared',
          url: sharedUrl,
          models: [{ id: 'shared-model' }, { id: 'a-only' }],
        },
      ],
      envKey: () => 'A_API_KEY',
      modelsEditable: true,
      modelNamePrefix: 'A',
    };
    const bFirstUrl = 'https://b-first.example/v1';
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
          id: 'b-shared',
          label: 'B Shared',
          url: sharedUrl,
          models: [{ id: 'shared-model' }, { id: 'b-only' }],
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
      // Trim a default and type a custom id; both must die with this flow.
      result.current.changeModelIds('a-only, a-custom-model');
    });
    act(() => {
      result.current.start(providerB);
    });

    expect(result.current.state.modelIds).toBe('b-first-model');

    act(() => {
      // Provider B reuses provider A's endpoint URL and one built-in id: a
      // stale per-URL trim entry would strip 'shared-model' here, and a
      // leaked custom id from provider A would ride along in the field.
      result.current.selectBaseUrl(sharedUrl);
    });

    expect(result.current.state.modelIds).toBe('shared-model, b-only');
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
