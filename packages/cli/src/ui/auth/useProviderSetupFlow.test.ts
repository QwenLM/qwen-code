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
  deepseekProvider,
  generateCustomEnvKey,
  getDefaultModelIds,
  kimiProvider,
  zaiProvider,
  type ModelProvidersConfig,
  type ProviderConfig,
  type ProviderModelConfig,
} from '@qwen-code/qwen-code-core';
import { describe, expect, it, vi } from 'vitest';
import { useProviderSetupFlow } from './useProviderSetupFlow.js';
import { getExistingProviderSetup, getProtocolSetups } from './AuthDialog.js';

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

  it('keys per-endpoint model state off the committed endpoint, not a padded paste (R41-5)', () => {
    // submitBaseUrl commits the TRIMMED endpoint; the per-endpoint maps must
    // be keyed by that same identity. A whitespace-padded paste used to
    // write under one key and read under the other, orphaning trim state so
    // deselected defaults resurrected when the user returned to the
    // endpoint.
    const endpointUrl = 'https://x.example/v1';
    const siblingUrl = 'https://y.example/v1';
    const provider: ProviderConfig = {
      id: 'padded-provider',
      label: 'Padded Provider',
      description: 'Provider for whitespace-padded endpoint pastes',
      protocol: AuthType.USE_OPENAI,
      baseUrl: [
        {
          id: 'first',
          label: 'First',
          url: endpointUrl,
          models: [{ id: 'default-a' }, { id: 'default-b' }],
        },
        {
          id: 'second',
          label: 'Second',
          url: siblingUrl,
          models: [{ id: 'sibling-default' }],
        },
      ],
      envKey: () => 'PADDED_API_KEY',
      modelsEditable: true,
      modelNamePrefix: 'Padded',
    };
    const runArm = (pastedBaseUrl: string): string => {
      const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
      act(() => {
        result.current.start(provider);
      });
      act(() => {
        // Paste the endpoint (possibly padded) and submit the baseUrl step.
        result.current.changeBaseUrl(pastedBaseUrl);
      });
      act(() => {
        expect(result.current.submitBaseUrl()).toBe(true);
      });
      act(() => {
        // Deselect 'default-a' at the endpoint.
        result.current.changeModelIds('default-b');
      });
      act(() => {
        result.current.selectBaseUrl(siblingUrl);
      });
      act(() => {
        result.current.selectBaseUrl(endpointUrl);
      });
      return result.current.state.modelIds;
    };

    // Control arm: an unpadded endpoint keeps the deselection across a
    // round trip.
    expect(runArm(endpointUrl)).toBe('default-b');
    // Padded arm: the same round trip must behave identically.
    expect(runArm(`  ${endpointUrl}  `)).toBe('default-b');
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

  it('does not leak model ids across protocols at the same endpoint', () => {
    const proxyUrl = 'https://proxy.example/v1';
    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));

    act(() => {
      result.current.start(customProvider, AuthType.USE_OPENAI, {}, []);
    });
    act(() => {
      result.current.selectProtocol(AuthType.USE_OPENAI);
    });
    act(() => {
      result.current.changeBaseUrl(proxyUrl);
    });
    act(() => {
      expect(result.current.submitBaseUrl()).toBe(true);
    });
    act(() => {
      result.current.changeModelIds('llama-70b, claude-sonnet-9');
    });

    // Switching protocol clears the fields (no draft for Anthropic yet)...
    act(() => {
      result.current.selectProtocol(AuthType.USE_ANTHROPIC);
    });
    expect(result.current.state.modelIds).toBe('');

    // ...and re-submitting the same endpoint under the new protocol must
    // not pre-fill the models field with the OpenAI session's ids.
    act(() => {
      result.current.changeBaseUrl(proxyUrl);
    });
    act(() => {
      expect(result.current.submitBaseUrl()).toBe(true);
    });
    expect(result.current.state.modelIds).toBe('');

    // The OpenAI session's ids are still there when switching back.
    act(() => {
      result.current.selectProtocol(AuthType.USE_OPENAI);
    });
    expect(result.current.state.modelIds).toBe('llama-70b, claude-sonnet-9');
  });

  it('re-seeds endpoint, key, and models from the selected protocol bucket on protocol switch', () => {
    // R34-2/R35-12: the same baseUrl can be connected under several protocol
    // buckets. Switching the protocol step must restore the selected
    // protocol's own saved endpoint/key/models — not leave the field blank
    // and not pre-fill another protocol's ids — so submitting preserves the
    // selected bucket's models.
    const proxyUrl = 'https://proxy.example/v1';
    const anthropicEnvKey = generateCustomEnvKey(
      AuthType.USE_ANTHROPIC,
      proxyUrl,
    );
    const anthropicModels = [
      { id: 'c-ant', baseUrl: proxyUrl, envKey: anthropicEnvKey },
      { id: 'd-ant', baseUrl: proxyUrl, envKey: anthropicEnvKey },
    ];
    const modelIdsByBaseUrlByProtocol = new Map<
      AuthType,
      ReadonlyMap<string, readonly string[]>
    >([[AuthType.USE_ANTHROPIC, new Map([[proxyUrl, ['c-ant', 'd-ant']]])]]);
    const preserveModelsByProtocol = new Map<
      AuthType,
      readonly ProviderModelConfig[]
    >([[AuthType.USE_ANTHROPIC, anthropicModels]]);
    const baseUrlByProtocol = new Map<AuthType, string>([
      [AuthType.USE_ANTHROPIC, proxyUrl],
    ]);

    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));

    act(() => {
      result.current.start(
        customProvider,
        AuthType.USE_OPENAI,
        { [anthropicEnvKey]: 'sk-ant-stored' },
        [],
        undefined,
        [],
        new Map(),
        [],
        modelIdsByBaseUrlByProtocol,
        preserveModelsByProtocol,
        baseUrlByProtocol,
      );
    });

    // Switching to Anthropic restores that bucket's saved endpoint, key, and
    // models instead of leaving them blank.
    act(() => {
      result.current.selectProtocol(AuthType.USE_ANTHROPIC);
    });
    expect(result.current.state.baseUrl).toBe(proxyUrl);
    expect(result.current.state.apiKey).toBe('sk-ant-stored');
    expect(result.current.state.modelIds).toBe('c-ant, d-ant');
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

  it('does not revive a non-merge sibling custom deleted from the models field (R42-2)', async () => {
    // For non-merge array providers the sibling-endpoint branch must carry
    // preserved entries or the remove-owned merge deletes them — but
    // preserveModelsRef is the dialog-open snapshot, never updated by
    // changeModelIds/switchEndpointModelState. Carrying it unconditionally
    // revived a custom model the user explicitly deleted from the sibling
    // endpoint's models field whenever setup completed at another
    // endpoint. The carry must be rebuilt from the live per-endpoint maps.
    const standardUrl = 'https://api.z.ai/api/paas/v4';
    const codingUrl = 'https://api.z.ai/api/coding/paas/v4';
    const zaiDefaults = getDefaultModelIds(zaiProvider, standardUrl);
    const removedCustom: ProviderModelConfig = {
      id: 'my-glm',
      name: '[Z.AI] my-glm',
      baseUrl: standardUrl,
      envKey: 'ZAI_API_KEY',
      generationConfig: { contextWindowSize: 12345 },
    };
    const keptCustom: ProviderModelConfig = {
      id: 'other-glm',
      name: '[Z.AI] other-glm',
      baseUrl: standardUrl,
      envKey: 'ZAI_API_KEY',
      generationConfig: { contextWindowSize: 54321 },
    };
    const onSubmit = vi.fn(async () => undefined);
    const { result } = renderHook(() => useProviderSetupFlow(onSubmit));

    // Delete 'my-glm' from the standard endpoint's models field, then
    // complete setup at the sibling coding endpoint.
    act(() => {
      result.current.start(
        zaiProvider,
        undefined,
        { ZAI_API_KEY: 'sk-zai' },
        ['my-glm', 'other-glm'],
        standardUrl,
        undefined,
        new Map<string, string[]>([
          [standardUrl, [...zaiDefaults, 'my-glm', 'other-glm']],
          [codingUrl, [...zaiDefaults]],
        ]),
        [removedCustom, keptCustom],
      );
    });
    act(() => {
      result.current.changeModelIds([...zaiDefaults, 'other-glm'].join(', '));
    });
    act(() => {
      result.current.selectBaseUrl(codingUrl);
    });
    await act(async () => {
      result.current.submit();
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    // The deleted custom is gone; the untouched sibling custom is still
    // carried (dropping it would delete it in the remove-owned merge).
    expect(onSubmit).toHaveBeenCalledWith(
      zaiProvider,
      expect.objectContaining({ preserveModels: [keptCustom] }),
    );
  });

  it('drops a non-merge custom deleted at the submitted endpoint itself (R42-2 control)', async () => {
    const standardUrl = 'https://api.z.ai/api/paas/v4';
    const zaiDefaults = getDefaultModelIds(zaiProvider, standardUrl);
    const removedCustom: ProviderModelConfig = {
      id: 'my-glm',
      name: '[Z.AI] my-glm',
      baseUrl: standardUrl,
      envKey: 'ZAI_API_KEY',
      generationConfig: { contextWindowSize: 12345 },
    };
    const keptCustom: ProviderModelConfig = {
      id: 'other-glm',
      name: '[Z.AI] other-glm',
      baseUrl: standardUrl,
      envKey: 'ZAI_API_KEY',
      generationConfig: { contextWindowSize: 54321 },
    };
    const onSubmit = vi.fn(async () => undefined);
    const { result } = renderHook(() => useProviderSetupFlow(onSubmit));

    act(() => {
      result.current.start(
        zaiProvider,
        undefined,
        { ZAI_API_KEY: 'sk-zai' },
        ['my-glm', 'other-glm'],
        standardUrl,
        undefined,
        new Map<string, string[]>([
          [standardUrl, [...zaiDefaults, 'my-glm', 'other-glm']],
        ]),
        [removedCustom, keptCustom],
      );
    });
    act(() => {
      result.current.changeModelIds([...zaiDefaults, 'other-glm'].join(', '));
    });
    await act(async () => {
      result.current.submit();
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(
      zaiProvider,
      expect.objectContaining({ preserveModels: [keptCustom] }),
    );
  });

  it('leaves a shared-key legacy entry untouched on an untouched dialog submit (R43-3)', async () => {
    // Full dialog data chain: getExistingProviderSetup + getProtocolSetups
    // → start() → untouched submit() → buildInstallPlan → apply. MOONSHOT_API_KEY
    // serves BOTH Kimi api endpoints, so the baseUrl-less legacy entry fails
    // attribution closed (R41-4): it must reach the submit unseeded and
    // unstamped and survive byte-identical — before the fix the
    // getProtocolSetups flatMap stamped it with the restored endpoint,
    // start() preferred that list, and buildInstallPlan wrote a re-homed
    // stamped copy beside the never-claimed original (permanent duplicate).
    const legacyModel: ProviderModelConfig = {
      id: 'my-custom',
      name: '[Kimi API] my-custom',
      envKey: 'MOONSHOT_API_KEY',
      generationConfig: { contextWindowSize: 12345 },
    };
    const stampedApi: ProviderModelConfig = {
      id: 'kimi-k3',
      name: '[Kimi API] kimi-k3',
      baseUrl: 'https://api.moonshot.ai/v1',
      envKey: 'MOONSHOT_API_KEY',
    };
    const saved = { [AuthType.USE_OPENAI]: [stampedApi, legacyModel] };
    const existingSetup = getExistingProviderSetup(kimiProvider, saved);
    const protocolSetups = getProtocolSetups(kimiProvider, saved);
    // kimi-k3 is a default id at the restored endpoint (regenerated on
    // submit); the legacy shared-key entry must be nowhere in the seeds.
    expect(existingSetup.preserveModels).toBeUndefined();
    expect(existingSetup.migratedLegacyModelIds).toBeUndefined();
    expect(protocolSetups.preserveModelsByProtocol.size).toBe(0);

    let modelProviders: ModelProvidersConfig = {
      [AuthType.USE_OPENAI]: [stampedApi, legacyModel],
    };
    const onSubmit = vi.fn(async (_config, inputs) => {
      const plan = buildInstallPlan(kimiProvider, inputs);
      await applyProviderInstallPlan(plan, {
        settings: {
          getValue: vi.fn(),
          setValue: vi.fn(),
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
        kimiProvider,
        existingSetup.initialProtocol,
        { MOONSHOT_API_KEY: 'sk-moon' },
        existingSetup.customModelIds,
        existingSetup.initialBaseUrl,
        existingSetup.trimmedDefaultModelIds,
        existingSetup.modelIdsByBaseUrl,
        existingSetup.preserveModels,
        protocolSetups.modelIdsByBaseUrlByProtocol,
        protocolSetups.preserveModelsByProtocol,
        protocolSetups.baseUrlByProtocol,
        existingSetup.migratedLegacyModelIds,
        protocolSetups.migratedLegacyModelIdsByProtocol,
      );
    });
    await act(async () => {
      result.current.submit();
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    // The original survives byte-identical and alone: no stamped copy
    // beside it, nothing written for its id by this submit.
    expect(
      modelProviders[AuthType.USE_OPENAI]?.filter(
        (model) => model.id === 'my-custom',
      ),
    ).toEqual([legacyModel]);
  });

  it('collapses an attributable legacy entry to its stamped copy on an untouched dialog submit (R43-3)', async () => {
    // The attributable twin of the test above: DEEPSEEK_API_KEY is the
    // single deepseek endpoint's own key, so the dialog seeds the entry
    // stamped and its id as migratedLegacyModelIds — the stored original
    // collapses into the stamped copy instead of persisting as a duplicate.
    const legacyModel: ProviderModelConfig = {
      id: 'legacy-custom',
      name: '[DeepSeek] legacy-custom',
      envKey: 'DEEPSEEK_API_KEY',
      generationConfig: { contextWindowSize: 54321 },
    };
    const provider = deepseekProvider;
    const saved = { [AuthType.USE_OPENAI]: [legacyModel] };
    const existingSetup = getExistingProviderSetup(provider, saved);
    const protocolSetups = getProtocolSetups(provider, saved);
    expect(existingSetup.migratedLegacyModelIds).toEqual(['legacy-custom']);

    let modelProviders: ModelProvidersConfig = {
      [AuthType.USE_OPENAI]: [legacyModel],
    };
    const onSubmit = vi.fn(async (_config, inputs) => {
      const plan = buildInstallPlan(provider, inputs);
      await applyProviderInstallPlan(plan, {
        settings: {
          getValue: vi.fn(),
          setValue: vi.fn(),
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
        existingSetup.initialProtocol,
        { DEEPSEEK_API_KEY: 'sk-ds' },
        existingSetup.customModelIds,
        existingSetup.initialBaseUrl,
        existingSetup.trimmedDefaultModelIds,
        existingSetup.modelIdsByBaseUrl,
        existingSetup.preserveModels,
        protocolSetups.modelIdsByBaseUrlByProtocol,
        protocolSetups.preserveModelsByProtocol,
        protocolSetups.baseUrlByProtocol,
        existingSetup.migratedLegacyModelIds,
        protocolSetups.migratedLegacyModelIdsByProtocol,
      );
    });
    await act(async () => {
      result.current.submit();
    });

    const survivors = modelProviders[AuthType.USE_OPENAI]?.filter(
      (model) => model.id === 'legacy-custom',
    );
    // Exactly one entry: stamped at the endpoint; the baseUrl-less original
    // is gone (claimed through migratedLegacyModelIds).
    expect(survivors).toEqual([
      { ...legacyModel, baseUrl: 'https://api.deepseek.com' },
    ]);
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

  it('migrates a stale-URL array-provider entry at submit instead of duplicating it', async () => {
    // A kimi entry stamped at a URL that matches no preset option is
    // restored raw (prefill contract), while the submission endpoint
    // resolves to the first option. The submit must re-stamp the entry at
    // the submission endpoint and emit its id in migratedLegacyModelIds so
    // buildInstallPlan's stale-stamped clause claims the stored original —
    // otherwise the stamped copy at the first option persisted beside the
    // unclaimed stale original, a permanent duplicate spanning two env
    // keys.
    const staleUrl = 'https://stale.example/v1';
    const codingUrl = 'https://api.kimi.com/coding/v1';
    const staleOriginal = {
      id: 'kimi-k3',
      name: '[Kimi API] kimi-k3',
      baseUrl: staleUrl,
      envKey: 'MOONSHOT_API_KEY',
      generationConfig: { contextWindowSize: 12345 },
    };
    const modelProvidersRecord = { [AuthType.USE_OPENAI]: [staleOriginal] };
    const setup = getExistingProviderSetup(kimiProvider, modelProvidersRecord);
    const protocolSetups = getProtocolSetups(
      kimiProvider,
      modelProvidersRecord,
    );

    let modelProviders: ModelProvidersConfig = {
      [AuthType.USE_OPENAI]: [staleOriginal],
    };
    const onSubmit = vi.fn(async (_config, inputs) => {
      const plan = buildInstallPlan(kimiProvider, inputs);
      await applyProviderInstallPlan(plan, {
        settings: {
          getValue: vi.fn(),
          setValue: vi.fn(),
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
        kimiProvider,
        setup.initialProtocol,
        { MOONSHOT_API_KEY: 'sk-moon' },
        setup.customModelIds,
        setup.initialBaseUrl,
        setup.trimmedDefaultModelIds,
        setup.modelIdsByBaseUrl,
        setup.preserveModels,
        protocolSetups.modelIdsByBaseUrlByProtocol,
        protocolSetups.preserveModelsByProtocol,
        protocolSetups.baseUrlByProtocol,
        setup.migratedLegacyModelIds,
        protocolSetups.migratedLegacyModelIdsByProtocol,
      );
    });

    // The submission endpoint resolves to the first option (the stale URL
    // is not selectable), while the models field carries the prefilled id.
    expect(result.current.state.baseUrl).toBe(codingUrl);
    expect(result.current.state.modelIds).toContain('kimi-k3');

    await act(async () => {
      result.current.submit();
    });

    const inputs = onSubmit.mock.calls[0][1];
    expect(inputs.migratedLegacyModelIds).toContain('kimi-k3');
    expect(inputs.preserveModels).toContainEqual(
      expect.objectContaining({ id: 'kimi-k3', baseUrl: codingUrl }),
    );

    // The pair collapses: exactly one kimi-k3 entry remains, stamped at the
    // submission endpoint — no stale-URL duplicate.
    const k3Entries = modelProviders[AuthType.USE_OPENAI]?.filter(
      (model: ProviderModelConfig) => model.id === 'kimi-k3',
    );
    expect(k3Entries).toHaveLength(1);
    expect(k3Entries?.[0].baseUrl).toBe(codingUrl);
    // The rich generationConfig survived the merge with the regenerated copy.
    expect(k3Entries?.[0].generationConfig).toEqual({
      contextWindowSize: 12345,
    });
  });

  it('adopts an explicitly typed floating legacy entry through adoptedFloatingModelIds', async () => {
    // A floating baseUrl-less entry (env key names NO endpoint) is never
    // seeded, but when the user explicitly types its id into the models
    // field the submit adopts it: stamped into preserveModels and emitted
    // via adoptedFloatingModelIds so buildInstallPlan claims the stored
    // original — without the channel the stamped copy is written while the
    // original can never be claimed, a permanent duplicate with the rich
    // generationConfig stranded (twin of the VS Code/ACP/serve channel).
    const url = 'https://proxy.example/v1';
    const floating = {
      id: 'floaty',
      envKey: 'QWEN_CUSTOM_API_KEY_OPENAI', // prefix-only: names no endpoint
      generationConfig: { contextWindowSize: 777 },
    };
    const onSubmit = vi.fn(async () => undefined);
    const { result } = renderHook(() => useProviderSetupFlow(onSubmit));

    act(() => {
      result.current.start(
        customProvider,
        AuthType.USE_OPENAI,
        {},
        [],
        url,
        undefined,
        new Map(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        [floating],
      );
    });

    // Not seeded: the field starts empty.
    expect(result.current.state.modelIds).toBe('');

    act(() => {
      result.current.changeModelIds('floaty');
    });
    await act(async () => {
      result.current.submit();
    });

    expect(onSubmit).toHaveBeenLastCalledWith(
      customProvider,
      expect.objectContaining({
        adoptedFloatingModelIds: ['floaty'],
        preserveModels: [
          expect.objectContaining({
            id: 'floaty',
            baseUrl: url,
            envKey: generateCustomEnvKey(AuthType.USE_OPENAI, url),
            generationConfig: { contextWindowSize: 777 },
          }),
        ],
      }),
    );

    // Control: not typed -> not adopted.
    vi.mocked(onSubmit).mockClear();
    act(() => {
      result.current.changeModelIds('some-other-model');
    });
    await act(async () => {
      result.current.submit();
    });
    expect(onSubmit).toHaveBeenLastCalledWith(
      customProvider,
      expect.not.objectContaining({
        adoptedFloatingModelIds: expect.anything(),
      }),
    );
  });

  it('carries a non-merge array provider.s restored-endpoint defaults across an endpoint switch (R46-6)', async () => {
    // For non-merge array-baseUrl providers (moonshot/minimax/zai/alibaba-
    // standard: static env key, UNSCOPED ownsModel) computePreservedModels
    // used to exclude the restored endpoint's DEFAULT entries from
    // preserveModels on the assumption a same-endpoint submit regenerates
    // them. When the user switched endpoint before submitting, nothing
    // regenerated them and the unscoped remove-owned merge deleted the
    // previously-connected endpoint's stored models.
    const standardUrl = 'https://api.z.ai/api/paas/v4';
    const codingUrl = 'https://api.z.ai/api/coding/paas/v4';
    const zaiDefaults = getDefaultModelIds(zaiProvider, standardUrl);
    const savedEntries: ProviderModelConfig[] = zaiDefaults.map((id) => ({
      id,
      name: `[Z.AI] ${id}`,
      baseUrl: standardUrl,
      envKey: 'ZAI_API_KEY',
    }));
    const saved = { [AuthType.USE_OPENAI]: savedEntries };
    const setup = getExistingProviderSetup(zaiProvider, saved);
    const protocolSetups = getProtocolSetups(zaiProvider, saved);
    // Non-merge array provider: restored-endpoint defaults are carried
    // regardless of default status.
    expect(setup.preserveModels).toEqual(savedEntries);

    let modelProviders: ModelProvidersConfig = {
      [AuthType.USE_OPENAI]: [...savedEntries],
    };
    const onSubmit = vi.fn(async (_config, inputs) => {
      const plan = buildInstallPlan(zaiProvider, inputs);
      await applyProviderInstallPlan(plan, {
        settings: {
          getValue: vi.fn(),
          setValue: vi.fn(),
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
        zaiProvider,
        setup.initialProtocol,
        { ZAI_API_KEY: 'sk-zai' },
        setup.customModelIds,
        setup.initialBaseUrl,
        setup.trimmedDefaultModelIds,
        setup.modelIdsByBaseUrl,
        setup.preserveModels,
        protocolSetups.modelIdsByBaseUrlByProtocol,
        protocolSetups.preserveModelsByProtocol,
        protocolSetups.baseUrlByProtocol,
        setup.migratedLegacyModelIds,
        protocolSetups.migratedLegacyModelIdsByProtocol,
      );
    });
    expect(result.current.state.baseUrl).toBe(standardUrl);

    act(() => {
      result.current.selectBaseUrl(codingUrl);
    });
    await act(async () => {
      result.current.submit();
    });

    // The restored endpoint's stored defaults survive the switch+submit;
    // the new endpoint's models are installed beside them.
    const atStandard = modelProviders[AuthType.USE_OPENAI]?.filter(
      (model) => model.baseUrl === standardUrl,
    );
    expect(atStandard).toHaveLength(zaiDefaults.length);
    expect(atStandard?.map((model) => model.id)).toEqual(zaiDefaults);
    expect(
      modelProviders[AuthType.USE_OPENAI]?.some(
        (model) => model.baseUrl === codingUrl,
      ),
    ).toBe(true);
  });

  it('seeds the resolved endpoint.s own bucket when the first saved model is a stale stamp (mixed storage)', async () => {
    // start() used to seed the models field from the flat view's
    // stale-scoped pair: trimmedDefaultModelIds snapped via resolveBaseUrl
    // to the first option's defaults while restoredModelIds stayed scoped
    // to the stale URL, so every genuinely-saved default of the resolved
    // endpoint rendered UNCHECKED and a plain submit deleted it. Seed from
    // the resolved endpoint's own bucket when the endpoints diverge.
    const staleUrl = 'https://stale.example/v1';
    const codingUrl = 'https://api.kimi.com/coding/v1';
    const staleOriginal: ProviderModelConfig = {
      id: 'kimi-k3',
      name: '[Kimi API] kimi-k3',
      baseUrl: staleUrl,
      envKey: 'MOONSHOT_API_KEY',
      generationConfig: { contextWindowSize: 12345 },
    };
    const codingSavedDefault: ProviderModelConfig = {
      id: 'kimi-for-coding',
      name: '[Kimi Code] kimi-for-coding',
      baseUrl: codingUrl,
      envKey: 'KIMI_CODE_API_KEY',
    };
    const saved = {
      [AuthType.USE_OPENAI]: [staleOriginal, codingSavedDefault],
    };
    const setup = getExistingProviderSetup(kimiProvider, saved);
    const protocolSetups = getProtocolSetups(kimiProvider, saved);

    let modelProviders: ModelProvidersConfig = {
      [AuthType.USE_OPENAI]: [staleOriginal, codingSavedDefault],
    };
    const onSubmit = vi.fn(async (_config, inputs) => {
      const plan = buildInstallPlan(kimiProvider, inputs);
      await applyProviderInstallPlan(plan, {
        settings: {
          getValue: vi.fn(),
          setValue: vi.fn(),
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
        kimiProvider,
        setup.initialProtocol,
        { MOONSHOT_API_KEY: 'sk-moon', KIMI_CODE_API_KEY: 'sk-code' },
        setup.customModelIds,
        setup.initialBaseUrl,
        setup.trimmedDefaultModelIds,
        setup.modelIdsByBaseUrl,
        setup.preserveModels,
        protocolSetups.modelIdsByBaseUrlByProtocol,
        protocolSetups.preserveModelsByProtocol,
        protocolSetups.baseUrlByProtocol,
        setup.migratedLegacyModelIds,
        protocolSetups.migratedLegacyModelIdsByProtocol,
      );
    });

    // The submission endpoint snaps to the first option, while the field
    // shows the resolved endpoint's OWN saved selection — kimi-for-coding
    // checked — plus the prefilled stale id.
    expect(result.current.state.baseUrl).toBe(codingUrl);
    expect(result.current.state.modelIds).toContain('kimi-for-coding');
    expect(result.current.state.modelIds).toContain('kimi-k3');

    await act(async () => {
      result.current.submit();
    });

    // The genuinely-saved default survives the plain submit.
    const codingEntries = modelProviders[AuthType.USE_OPENAI]?.filter(
      (model) => model.id === 'kimi-for-coding',
    );
    expect(codingEntries).toHaveLength(1);
    expect(codingEntries?.[0].baseUrl).toBe(codingUrl);
    // The prefilled stale entry collapses to one re-stamped copy.
    const k3Entries = modelProviders[AuthType.USE_OPENAI]?.filter(
      (model) => model.id === 'kimi-k3',
    );
    expect(k3Entries).toHaveLength(1);
    expect(k3Entries?.[0].baseUrl).toBe(codingUrl);
  });

  it('fails closed for a never-surfaced stale entry instead of claiming it (R46-4)', async () => {
    // The stale-stamped branch used to claim EVERY stale entry in
    // preserveModelsRef as an informed deselection, but the views prefill
    // only the RESTORED endpoint's ids. A stale entry at any other stale
    // URL never reaches the models field; claiming it let a routine
    // reconnect delete a custom model that was never displayed. Claim only
    // surfaced ids; carry the rest through unchanged.
    const codingUrl = 'https://api.kimi.com/coding/v1';
    const staleUrl = `${codingUrl}/v0`; // matches no preset option
    const codingSavedDefault: ProviderModelConfig = {
      id: 'kimi-for-coding',
      name: '[Kimi Code] kimi-for-coding',
      baseUrl: codingUrl,
      envKey: 'KIMI_CODE_API_KEY',
    };
    const staleCustom: ProviderModelConfig = {
      id: 'my-custom',
      name: '[Kimi Code] my-custom',
      baseUrl: staleUrl,
      envKey: 'KIMI_CODE_API_KEY',
      generationConfig: { contextWindowSize: 24680 },
    };
    const saved = { [AuthType.USE_OPENAI]: [codingSavedDefault, staleCustom] };
    const setup = getExistingProviderSetup(kimiProvider, saved);
    const protocolSetups = getProtocolSetups(kimiProvider, saved);
    // computePreservedModels still carries the stale entry (fail closed),
    // and the field seeds only the restored endpoint's id.
    expect(setup.preserveModels).toEqual([staleCustom]);
    expect(setup.customModelIds).toEqual([]);

    let modelProviders: ModelProvidersConfig = {
      [AuthType.USE_OPENAI]: [codingSavedDefault, staleCustom],
    };
    const onSubmit = vi.fn(async (_config, inputs) => {
      const plan = buildInstallPlan(kimiProvider, inputs);
      await applyProviderInstallPlan(plan, {
        settings: {
          getValue: vi.fn(),
          setValue: vi.fn(),
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
        kimiProvider,
        setup.initialProtocol,
        { KIMI_CODE_API_KEY: 'sk-code' },
        setup.customModelIds,
        setup.initialBaseUrl,
        setup.trimmedDefaultModelIds,
        setup.modelIdsByBaseUrl,
        setup.preserveModels,
        protocolSetups.modelIdsByBaseUrlByProtocol,
        protocolSetups.preserveModelsByProtocol,
        protocolSetups.baseUrlByProtocol,
        setup.migratedLegacyModelIds,
        protocolSetups.migratedLegacyModelIdsByProtocol,
      );
    });
    // The stale id is invisible in the models field.
    expect(result.current.state.modelIds).toContain('kimi-for-coding');
    expect(result.current.state.modelIds).not.toContain('my-custom');

    await act(async () => {
      result.current.submit();
    });

    const inputs = onSubmit.mock.calls[0][1];
    // Never surfaced -> never claimed, and left out of the plan (the
    // endpoint-scoped ownsModel writes it back untouched; carrying it
    // would persist a second copy).
    expect(inputs.migratedLegacyModelIds ?? []).not.toContain('my-custom');
    expect(inputs.preserveModels ?? []).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ id: 'my-custom' }),
      ]),
    );
    // The stored custom model survives byte-identical at its stale URL.
    expect(
      modelProviders[AuthType.USE_OPENAI]?.filter(
        (model) => model.id === 'my-custom',
      ),
    ).toEqual([staleCustom]);
  });
});
