import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelsConfig } from '@qwen-code/qwen-code-core/models/modelsConfig.js';
import { loadSettings } from '../config/settings.js';
import { loadManagedLocalModels } from './managed-local-models.js';

vi.mock('../config/settings.js', () => ({ loadSettings: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('local Managed model catalog', () => {
  beforeEach(() => {
    vi.mocked(loadSettings).mockReturnValue({ merged: {} } as ReturnType<
      typeof loadSettings
    >);
  });

  it('uses deployment settings and returns only unique conversation model IDs and labels', () => {
    const merged = {
      model: { name: 'selected' },
      security: { auth: { selectedType: 'openai' } },
      providerProtocol: { custom: 'openai' },
      modelProviders: {
        custom: [
          { id: 'other', apiKey: 'secret-key', baseUrl: 'https://private/v1' },
          { id: 'selected', name: 'Selected model' },
          { id: 'shared', baseUrl: 'https://one/v1' },
          { id: 'shared', baseUrl: 'https://two/v1' },
          { id: 'cross-wire' },
          { id: 'fast', fastOnly: true },
          { id: 'image', imageOnly: true },
          { id: 'vision', visionOnly: true },
          { id: 'voice', voiceOnly: true },
          { id: 'realtime', realtimeOnly: true },
        ],
        anthropic: [{ id: 'cross-wire' }],
      },
    };
    vi.mocked(loadSettings).mockReturnValue({ merged } as unknown as ReturnType<
      typeof loadSettings
    >);
    expect(loadManagedLocalModels()).toEqual({
      defaultModelId: 'selected',
      models: [
        { modelId: 'selected', label: 'Selected model' },
        { modelId: 'other', label: 'other' },
      ],
    });
    expect(loadSettings).toHaveBeenCalledWith(process.cwd(), {
      skipLoadEnvironment: true,
      skipWorkspaceSettings: true,
      workspaceTrusted: false,
    });
    const harnessModels = new ModelsConfig({
      modelProvidersConfig: merged.modelProviders,
      providerProtocolConfig: merged.providerProtocol,
    }).getAllConfiguredModels();
    for (const model of loadManagedLocalModels().models) {
      expect(
        harnessModels.filter((entry) => entry.id === model.modelId),
      ).toHaveLength(1);
    }
  });

  it('keeps the existing default fallback when no provider models are configured', () => {
    expect(loadManagedLocalModels()).toEqual({
      models: [],
      defaultModelId: undefined,
    });
  });

  it.each(['qwen-oauth', 'openai'])(
    'keeps an unmatched %s default instead of silently selecting another provider',
    (authType) => {
      vi.mocked(loadSettings).mockReturnValue({
        merged: {
          security: { auth: { selectedType: authType } },
          model: { name: 'default-not-in-catalog' },
          modelProviders: { openai: [{ id: 'other' }] },
        },
      } as unknown as ReturnType<typeof loadSettings>);
      expect(loadManagedLocalModels()).toEqual({
        models: [{ modelId: 'other', label: 'other' }],
        defaultModelId: undefined,
      });
    },
  );

  it('recognizes an environment-selected configured model using the CLI resolver', () => {
    vi.stubEnv('OPENAI_MODEL', 'model-b');
    vi.mocked(loadSettings).mockReturnValue({
      merged: {
        security: { auth: { selectedType: 'openai' } },
        modelProviders: { openai: [{ id: 'model-a' }, { id: 'model-b' }] },
      },
    } as unknown as ReturnType<typeof loadSettings>);
    expect(loadManagedLocalModels()).toEqual({
      models: [
        { modelId: 'model-b', label: 'model-b' },
        { modelId: 'model-a', label: 'model-a' },
      ],
      defaultModelId: 'model-b',
    });
  });
});
