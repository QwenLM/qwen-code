/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  ChatCompletionsTransport,
  Config,
  CustomProviderManager,
  createCustomModelProviders,
  coreEvents,
  MessagesTransport,
  ModelTransportManager,
  QWEN_SUBSCRIPTION_PROVIDER_ID,
  type Model,
} from '@qwen-code/core';
import { SettingsService, type MergedSettings } from '@qwen-code/resource';
import { createEmptyLoadedSettings } from '../../../../core/src/test-utils/config.js';
import {
  renderWithProviders,
  renderHookWithProviders,
} from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import { useModelList } from '../contexts/ConfigContext.js';
import {
  ModelSelector,
  buildSelectOptions,
  stepValue,
} from './ModelSelector.js';

function createLocalConfig(
  models: Array<{
    key: string;
    displayName: string;
    adapter?: string;
    modelId?: string;
  }>,
  provider: { providerId?: string; providerDisplayName?: string } = {},
) {
  const providerId = provider.providerId ?? 'local-provider';
  return {
    getCustomProviderAccessMode: () => 'local',
    canUseCustomProviders: () => true,
    ensureCustomProvidersAccess: async () => true,
    getCustomProviderRegistry: () => ({
      getPublicModels: () =>
        models.map((model) => ({
          ...model,
          providerId,
          providerDisplayName:
            provider.providerDisplayName ?? 'Local provider',
          modelId: model.modelId ?? model.key,
          adapter: model.adapter ?? 'openai-chat',
        })),
      getProviderForModel: () => undefined,
      getPublicProviders: () => [],
    }),
    getLoadedSettings: () => createEmptyLoadedSettings(),
    getModelRequestIdentity: () => 'local-model-list',
    getSessionId: () => 'local-model-list',
    getModelProviderManager: () => ({
      listModels: async () =>
        models.map((model) =>
          providerModel({
            key: model.key,
            source: providerId,
            displayName: model.displayName,
          }),
        ),
    }),
  } as unknown as Config;
}

function providerModel(overrides: Partial<Model> = {}): Model {
  return {
    source: 'qoder',
    key: 'qmodel_38max',
    displayName: 'Qwen3.8-Max',
    enabled: true,
    capabilities: {
      tools: true,
      vision: true,
      reasoning: {
        supported: true,
        supportedEfforts: ['none', 'low', 'high'],
      },
      contextWindows: [{ tokens: 200_000 }],
    },
    limits: { maxContextTokens: 200_000, maxOutputTokens: 32_000 },
    ...overrides,
  };
}

describe('ModelSelector', () => {
  it('allows adding the first model when no providers are configured', async () => {
    const config = new Config({
      loadedSettings: createEmptyLoadedSettings(),
      sessionId: 'empty-local-models',
      targetDir: process.cwd(),
      cwd: process.cwd(),
      debugMode: false,
      model: '',
    });
    try {
      let rendered!: Awaited<ReturnType<typeof renderWithProviders>>;
      await act(async () => {
        rendered = await renderWithProviders(
          <ModelSelector config={config} onSelect={vi.fn()} onClose={vi.fn()} />,
          { width: 120 },
        );
      });
      try {
        await waitFor(() => {
          expect(rendered.lastFrame()).toContain('Add custom model...');
        });
      } finally {
        rendered.unmount();
      }
    } finally {
      await config.dispose();
    }
  });

  it('lists saved providers after restart without commercial authentication', async () => {
    const modelKey = 'restored/saved-model';
    const loadedSettings = createEmptyLoadedSettings();
    loadedSettings.user.settings = {
      providers: {
        restored: {
          baseUrl: 'https://restored.example/v1',
          apiKey: 'test-only-key',
          protocol: 'anthropic',
          models: [
            {
              model: 'saved-model',
              displayName: 'Restored model',
              contextWindow: 256000,
            },
          ],
        },
      },
      model: { name: modelKey },
    };
    vi.spyOn(loadedSettings, 'merged', 'get').mockImplementation(
      () => loadedSettings.user.settings as MergedSettings,
    );
    const settingsService = new SettingsService();
    vi.spyOn(settingsService, 'resolve').mockReturnValue(loadedSettings);
    vi.spyOn(settingsService, 'getProjectSettingsSources').mockReturnValue({
      project: { read: () => '{}' },
      local: { read: () => '{}' },
    } as never);
    const transports = new ModelTransportManager([
      new ChatCompletionsTransport(),
      new MessagesTransport(),
    ]);
    const config = new Config({
      loadedSettings,
      settingsService,
      customProviderManager: new CustomProviderManager(settingsService),
      modelProviderFactory: () =>
        createCustomModelProviders(
          loadedSettings.merged.providers,
          transports,
          settingsService,
          'user',
        ),
      customProviderSettings: loadedSettings.merged.providers,
      sessionId: 'restored-local-models',
      targetDir: process.cwd(),
      cwd: process.cwd(),
      debugMode: false,
      model: '',
    });
    try {
      await config.getModelProviderManager().start();
      let rendered!: Awaited<ReturnType<typeof renderWithProviders>>;
      await act(async () => {
        rendered = await renderWithProviders(
          <ModelSelector
            config={config}
            currentModel={modelKey}
            onSelect={vi.fn()}
            onClose={vi.fn()}
          />,
          { width: 120 },
        );
      });
      try {
        await waitFor(() => {
          expect(rendered.lastFrame()).toContain('Restored model');
        });
      } finally {
        rendered.unmount();
      }
    } finally {
      await config.dispose();
      vi.restoreAllMocks();
    }
  });

  it('protects the current model by display name with an empty legacy registry', async () => {
    const config = createLocalConfig([
      { key: 'gateway/m', displayName: 'Current model' },
    ]);
    const settings = config.getLoadedSettings();
    settings.user.readOnly = false;
    settings.user.settings.providers = {
      gateway: {
        baseUrl: 'https://gateway.example/v1',
        apiKey: 'test-only-key',
        models: [{ model: 'm', displayName: 'Current model' }],
      },
    };
    const remove = vi.fn();
    Object.assign(config, {
      getCustomProviderRegistry: () => ({
        getPublicModels: () => [],
        getPublicProviders: () => [],
      }),
      getCustomProviderManager: () => ({
        getModelEdit: () => undefined,
        deleteModel: remove,
      }),
    });
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const rendered = await renderWithProviders(
      <ModelSelector
        config={config}
        currentModel="Current model"
        onSelect={onSelect}
        onClose={onClose}
      />,
      { width: 120 },
    );
    try {
      await waitFor(() =>
        expect(rendered.lastFrame()).toContain('Current model'),
      );
      await rendered.waitUntilReady();
      for (const key of ['\u001b[B', 'd']) {
        await act(async () => {
          rendered.stdin.write(key);
        });
        await rendered.waitUntilReady();
      }
      await waitFor(() => {
        expect(rendered.lastFrame()).toContain('Switch to a model outside');
      });
      await act(async () => {
        rendered.stdin.write('\r');
      });
      await rendered.waitUntilReady();
      await waitFor(() => {
        expect(rendered.lastFrame()).toMatch(/Current model.*✓/);
      });
      expect(remove).not.toHaveBeenCalled();
      expect(onSelect).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      rendered.unmount();
    }
  });

  it.each([false, true])(
    'removes deleted models from the opening snapshot after refresh (empty: %s)',
    async (empty) => {
      const models = [
        { key: 'gateway/m', displayName: 'Deletable model' },
        ...(!empty
          ? [{ key: 'gateway/keep', displayName: 'Remaining model' }]
          : []),
      ];
      const config = createLocalConfig(models);
      const openingModels = await config.getModelProviderManager().listModels();
      let rendered!: Awaited<ReturnType<typeof renderWithProviders>>;
      await act(async () => {
        rendered = await renderWithProviders(
          <ModelSelector
            config={config}
            listedModels={openingModels}
            onSelect={vi.fn()}
            onClose={vi.fn()}
          />,
          { width: 120 },
        );
      });
      try {
        expect(rendered.lastFrame()).toContain('Deletable model');
        await act(async () => {
          models.splice(0, 1);
          coreEvents.emitModelInfoChanged();
        });
        await rendered.waitUntilReady();
        await waitFor(() => {
          expect(rendered.lastFrame()).toContain('Add custom model...');
          expect(rendered.lastFrame()).not.toContain('Deletable model');
          if (!empty) expect(rendered.lastFrame()).toContain('Remaining model');
        });
      } finally {
        rendered.unmount();
      }
    },
  );

  it('lists local Custom Provider models without catalog content', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <ModelSelector
        config={createLocalConfig([
          { key: 'local-model', displayName: 'Local model' },
        ])}
        currentModel="local-model"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
      { width: 120 },
    );

    try {
      expect(lastFrame()).toMatch(/Current Model\s+: Local model/);
      expect(lastFrame()).toContain(
        '[openai] [Local provider] Local model (local-model) ✓',
      );
      expect(lastFrame()).toContain('Overview:');
      expect(lastFrame()).not.toContain('Credit');
    } finally {
      unmount();
    }
  });

  it('activates custom provider metadata when the registry is empty', async () => {
    const initializeCustomProviders = vi.fn(async () => {});
    const config = {
      getCustomProviderAccessMode: () => 'local',
      canUseCustomProviders: () => true,
      ensureCustomProvidersAccess: async () => true,
      getCustomProviderRegistry: () => ({
        getPublicModels: () => [],
        getProviderForModel: () => undefined,
      }),
      getLoadedSettings: () => ({
        merged: { providers: { 'custom-x': {} } },
      }),
      getModelRequestIdentity: () => 'custom-x',
      getSessionId: () => 'custom-x',
      getModelProviderManager: () => ({
        listModels: async () => [],
      }),
      initializeCustomProviders,
    } as unknown as Config;
    const { unmount } = await renderWithProviders(
      <ModelSelector
        config={config}
        currentModel="custom-x/model"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
      { width: 120 },
    );

    try {
      await vi.waitFor(() =>
        expect(initializeCustomProviders).toHaveBeenCalledOnce(),
      );
    } finally {
      unmount();
    }
  });

  it('omits the provider tag for manually added custom providers', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <ModelSelector
        config={createLocalConfig(
          [
            {
              key: 'custom-abcdef/gemini-3.8-flash',
              displayName: 'gemini-3.8-flash',
              adapter: 'gemini',
            },
          ],
          {
            providerId: 'custom-abcdef',
            providerDisplayName: 'generativelanguage.googleapis.com',
          },
        )}
        currentModel="custom-abcdef/gemini-3.8-flash"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
      { width: 120 },
    );

    try {
      expect(lastFrame()).toContain('[gemini] gemini-3.8-flash');
      expect(lastFrame()).not.toContain('[generativelanguage.googleapis.com]');
    } finally {
      unmount();
    }
  });

  it('renders platform presets with the provider prefix and raw id', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <ModelSelector
        config={createLocalConfig(
          [
            {
              key: 'coding-plan/qwen3.7-plus',
              displayName: 'qwen3.7-plus',
              modelId: 'qwen3.7-plus',
            },
          ],
          {
            providerId: 'coding-plan',
            providerDisplayName: 'ModelStudio Coding Plan',
          },
        )}
        currentModel="coding-plan/qwen3.7-plus"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
      { width: 120 },
    );

    try {
      expect(lastFrame()).toContain(
        '[openai] [ModelStudio Coding Plan] qwen3.7-plus (qwen3.7-plus)',
      );
    } finally {
      unmount();
    }
  });

  it('labels Qwen subscription models with the upstream auth type', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <ModelSelector
        listedModels={[
          providerModel({
            source: QWEN_SUBSCRIPTION_PROVIDER_ID,
            key: `${QWEN_SUBSCRIPTION_PROVIDER_ID}/qwen3.8-max`,
            displayName: 'qwen3.8-max',
          }),
        ]}
        currentModel={`${QWEN_SUBSCRIPTION_PROVIDER_ID}/qwen3.8-max`}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
      { width: 120 },
    );

    try {
      expect(lastFrame()).toContain('[qwen-subscription] qwen3.8-max');
    } finally {
      unmount();
    }
  });

  it('labels a Gemini custom provider with the gemini protocol', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <ModelSelector
        config={createLocalConfig([
          {
            key: 'local-gemini',
            displayName: 'Gemini 3.8 Flash',
            adapter: 'gemini',
          },
        ])}
        currentModel="local-gemini"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
      { width: 120 },
    );

    try {
      expect(lastFrame()).toContain(
        '[gemini] [Local provider] Gemini 3.8 Flash (local-gemini) ✓',
      );
    } finally {
      unmount();
    }
  });

  it('lists provider-manager models without a local registry', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <ModelSelector
        listedModels={[providerModel()]}
        currentModel="qmodel_38max"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
      { width: 120 },
    );

    try {
      expect(lastFrame()).toMatch(/Current Model\s+: Qwen3.8-Max/);
      expect(lastFrame()).toContain('Qwen3.8-Max');
    } finally {
      unmount();
    }
  });

  it('only offers deletion when a custom model is focused', async () => {
    const config = createLocalConfig([
      { key: 'local-model', displayName: 'Local model' },
    ]);
    const localModels = await config.getModelProviderManager().listModels();
    const listedModels = [providerModel(), ...localModels];
    Object.assign(config, {
      getModelProviderManager: () => ({ listModels: async () => listedModels }),
    });
    let rendered!: Awaited<ReturnType<typeof renderWithProviders>>;
    await act(async () => {
      rendered = await renderWithProviders(
        <ModelSelector
          config={config}
          listedModels={listedModels}
          currentModel="qmodel_38max"
          onSelect={vi.fn()}
          onClose={vi.fn()}
        />,
        { width: 120 },
      );
    });
    try {
      await rendered.waitUntilReady();
      expect(rendered.lastFrame()).toContain('n add');
      expect(rendered.lastFrame()).not.toContain('d delete');
      await act(async () => rendered.stdin.write('\u001b[B'));
      await rendered.waitUntilReady();
      await waitFor(() => expect(rendered.lastFrame()).toContain('d delete'));
      await act(async () => rendered.stdin.write('\u001b[A'));
      await rendered.waitUntilReady();
      await waitFor(() => {
        expect(rendered.lastFrame()).toContain('n add');
        expect(rendered.lastFrame()).not.toContain('d delete');
      });
    } finally {
      rendered.unmount();
    }
  });

  it('ignores the delete shortcut for a Qoder catalog model', async () => {
    const config = createLocalConfig([]);
    const listedModels = [providerModel()];
    Object.assign(config, {
      getModelProviderManager: () => ({ listModels: async () => listedModels }),
    });
    const onSelect = vi.fn();
    let rendered!: Awaited<ReturnType<typeof renderWithProviders>>;
    await act(async () => {
      rendered = await renderWithProviders(
        <ModelSelector
          config={config}
          listedModels={listedModels}
          currentModel="qmodel_38max"
          onSelect={onSelect}
          onClose={vi.fn()}
        />,
        { width: 120 },
      );
    });
    try {
      await rendered.waitUntilReady();
      await act(async () => rendered.stdin.write('d'));
      await rendered.waitUntilReady();
      expect(rendered.lastFrame()).toContain('[Qoder] Qwen3.8-Max');
      expect(rendered.lastFrame()).not.toContain('Delete custom model?');
      await act(async () => rendered.stdin.write('\r'));
      await waitFor(() =>
        expect(onSelect).toHaveBeenCalledWith('qmodel_38max', undefined, undefined),
      );
    } finally {
      rendered.unmount();
    }
  });

  it('lists Qoder catalog models above local models', async () => {
    const config = createLocalConfig([
      { key: 'local-model', displayName: 'Local model' },
    ]);
    const localModels = await config.getModelProviderManager().listModels();
    Object.assign(config, {
      getModelProviderManager: () => ({
        listModels: async () => [providerModel(), ...localModels],
      }),
    });
    const { lastFrame, unmount } = await renderWithProviders(
      <ModelSelector
        config={config}
        listedModels={[providerModel()]}
        currentModel="local-model"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
      { width: 120 },
    );

    try {
      const frame = lastFrame();
      const qoderIndex = frame.indexOf('[Qoder] Qwen3.8-Max');
      const localIndex = frame.indexOf(
        '[openai] [Local provider] Local model',
      );
      expect(qoderIndex).toBeGreaterThanOrEqual(0);
      expect(localIndex).toBeGreaterThanOrEqual(0);
      expect(qoderIndex).toBeLessThan(localIndex);
      expect(frame).toContain('[Qoder] Qwen3.8-Max');
      expect(frame).not.toContain('Custom (');
    } finally {
      unmount();
    }
  });

  it('ignores late provider results after switching the session config', async () => {
    const previous = createLocalConfig([
      { key: 'previous', displayName: 'Previous model' },
    ]);
    const next = createLocalConfig([
      { key: 'next', displayName: 'Next model' },
    ]);
    const manager = previous.getModelProviderManager();
    const previousModels = await manager.listModels();
    let finish!: (models: Model[]) => void;
    const pending = new Promise<Model[]>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(previous, 'getModelProviderManager').mockReturnValue({
      ...manager,
      listModels: () => pending,
    } as never);
    const rendered = await renderHookWithProviders(
      ({ config }: { config: Config }) => useModelList(config, 0),
      { initialProps: { config: previous } },
    );
    try {
      rendered.rerender({ config: next });
      await waitFor(() =>
        expect(rendered.result.current[0]?.displayName).toBe('Next model'),
      );
      await act(async () => {
        finish(previousModels);
      });
      expect(rendered.result.current[0]?.displayName).toBe('Next model');
    } finally {
      rendered.unmount();
      vi.restoreAllMocks();
    }
  });

  it('falls back to Auto when no local model is configured', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <ModelSelector onSelect={vi.fn()} onClose={vi.fn()} />,
      { width: 120 },
    );

    try {
      expect(lastFrame()).toMatch(/Current Model\s+: Auto/);
    } finally {
      unmount();
    }
  });

  it('keeps row drafts for other locally configured models', () => {
    expect(
      buildSelectOptions(
        { first: { effort: 'high' }, selected: { contextWindow: 200_000 } },
        'selected',
        undefined,
      ),
    ).toEqual({ otherModelPreferences: { first: { effort: 'high' } } });
  });

  it('clamps inline option navigation at both ends', () => {
    expect(stepValue(['low', 'high'], 'low', -1)).toBeUndefined();
    expect(stepValue(['low', 'high'], 'low', 1)).toBe('high');
    expect(stepValue(['low', 'high'], 'high', 1)).toBeUndefined();
  });
});
