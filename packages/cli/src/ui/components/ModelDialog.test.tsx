/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render, cleanup, act } from '@testing-library/react';
import process from 'node:process';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ModelDialog, encodeAuxModelSelector } from './ModelDialog.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { DescriptiveRadioButtonSelect } from './shared/DescriptiveRadioButtonSelect.js';
import { ConfigContext } from '../contexts/ConfigContext.js';
import { SettingsContext } from '../contexts/SettingsContext.js';
import { UIStateContext, type UIState } from '../contexts/UIStateContext.js';
import type { Config } from '@qwen-code/qwen-code-core';
import {
  AuthType,
  DEFAULT_QWEN_MODEL,
  probeImageSupport,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { SettingScope } from '../../config/settings.js';
import { getFilteredQwenModels } from '../models/availableModels.js';

vi.mock('../hooks/useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));
const mockedUseKeypress = vi.mocked(useKeypress);

vi.mock('./shared/DescriptiveRadioButtonSelect.js', () => ({
  DescriptiveRadioButtonSelect: vi.fn(() => null),
}));

// The "Test image support" action must hit a controlled probe, never the
// network. Everything else from core stays real.
vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return { ...actual, probeImageSupport: vi.fn() };
});
const mockedProbeImageSupport = vi.mocked(probeImageSupport);

// Helper to create getAvailableModelsForAuthType mock
const createMockGetAvailableModelsForAuthType = () =>
  vi.fn((t: AuthType) => {
    if (t === AuthType.QWEN_OAUTH) {
      return getFilteredQwenModels().map((m) => ({
        id: m.id,
        label: m.label,
        authType: AuthType.QWEN_OAUTH,
      }));
    }
    return [];
  });
const mockedSelect = vi.mocked(DescriptiveRadioButtonSelect);

const renderComponent = (
  props: Partial<React.ComponentProps<typeof ModelDialog>> = {},
  contextValue: Partial<Config> | undefined = undefined,
  settingsValue: Partial<LoadedSettings> | undefined = undefined,
) => {
  const defaultProps = {
    onClose: vi.fn(),
  };
  const combinedProps = { ...defaultProps, ...props };

  const mockSettings = {
    isTrusted: true,
    user: { settings: {} },
    workspace: { settings: {} },
    setValue: vi.fn(),
    ...(settingsValue ?? {}),
  } as unknown as LoadedSettings;

  const recordSlashCommand = vi.fn();

  const mockConfig = {
    // --- Functions used by ModelDialog ---
    getModel: vi.fn(() => DEFAULT_QWEN_MODEL),
    setModel: vi.fn().mockResolvedValue(undefined),
    switchModel: vi.fn().mockResolvedValue(undefined),
    getAuthType: vi.fn(() => 'qwen-oauth'),
    getAllConfiguredModels: vi.fn(() =>
      getFilteredQwenModels().map((m) => ({
        id: m.id,
        label: m.label,
        description: m.description || '',
        authType: AuthType.QWEN_OAUTH,
      })),
    ),
    getModelsConfig: vi.fn(() => ({
      getGenerationConfig: vi.fn(() => ({ baseUrl: undefined })),
    })),
    getActiveRuntimeModelSnapshot: vi.fn(() => undefined),
    getChatRecordingService: vi.fn(() => ({ recordSlashCommand })),

    // --- Functions used by ClearcutLogger ---
    getUsageStatisticsEnabled: vi.fn(() => true),
    getSessionId: vi.fn(() => 'mock-session-id'),
    getDebugMode: vi.fn(() => false),
    getContentGeneratorConfig: vi.fn(() => ({
      authType: AuthType.QWEN_OAUTH,
      model: DEFAULT_QWEN_MODEL,
    })),
    getUseModelRouter: vi.fn(() => false),
    getProxy: vi.fn(() => undefined),

    // --- Spread test-specific overrides ---
    ...(contextValue ?? {}),
  } as unknown as Config;

  // ModelDialog only reads historyManager off the UI state; mock just that so
  // selection notices (e.g. the non-image-capable vision warning) are assertable.
  const mockHistoryManager = {
    addItem: vi.fn(),
  } as unknown as UIState['historyManager'];

  const renderResult = render(
    <SettingsContext.Provider value={mockSettings}>
      <ConfigContext.Provider value={mockConfig}>
        <UIStateContext.Provider
          value={{ historyManager: mockHistoryManager } as unknown as UIState}
        >
          <ModelDialog {...combinedProps} />
        </UIStateContext.Provider>
      </ConfigContext.Provider>
    </SettingsContext.Provider>,
  );

  return {
    ...renderResult,
    props: combinedProps,
    mockConfig,
    mockSettings,
    mockHistoryManager,
    recordSlashCommand,
  };
};

describe('<ModelDialog />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure env-based fallback models don't leak into this suite from the developer environment.
    delete process.env['OPENAI_MODEL'];
    delete process.env['ANTHROPIC_MODEL'];
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the title', () => {
    const { getByText } = renderComponent();
    expect(getByText('Select Model')).toBeDefined();
  });

  it('passes all model options to DescriptiveRadioButtonSelect', () => {
    renderComponent();
    expect(mockedSelect).toHaveBeenCalledTimes(1);

    const props = mockedSelect.mock.calls[0][0];
    expect(props.items).toHaveLength(getFilteredQwenModels().length);
    // coder-model is the only model and it has vision capability
    expect(props.items[0].value).toBe(
      `${AuthType.QWEN_OAUTH}::${DEFAULT_QWEN_MODEL}`,
    );
    expect(props.showNumbers).toBe(true);
  });

  it('caps visible model options to the available dialog height', () => {
    renderComponent(
      { availableTerminalHeight: 20 },
      {
        getModel: vi.fn(() => 'model-1'),
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        getAllConfiguredModels: vi.fn(() =>
          Array.from({ length: 12 }, (_, i) => ({
            id: `model-${i + 1}`,
            label: `Model ${i + 1}`,
            description: '',
            authType: AuthType.USE_OPENAI,
          })),
        ),
      },
    );

    const props = mockedSelect.mock.calls[0][0];
    expect(props.items).toHaveLength(12);
    expect(props.maxItemsToShow).toBe(6);
    // The picker deliberately leaves the ▲/▼ scroll indicators off: they are
    // two always-rendered chrome rows better spent on two more entries.
    expect(props.showScrollArrows).toBeUndefined();
  });

  it('floors visible model options to 1 when the terminal is very short', () => {
    renderComponent(
      { availableTerminalHeight: 5 },
      {
        getModel: vi.fn(() => 'model-1'),
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        getAllConfiguredModels: vi.fn(() =>
          Array.from({ length: 12 }, (_, i) => ({
            id: `model-${i + 1}`,
            label: `Model ${i + 1}`,
            description: '',
            authType: AuthType.USE_OPENAI,
          })),
        ),
      },
    );

    const props = mockedSelect.mock.calls[0][0];
    expect(props.maxItemsToShow).toBe(1);
  });

  it('accounts for the taller two-row option height when descriptions are present', () => {
    renderComponent(
      { availableTerminalHeight: 20 },
      {
        getModel: vi.fn(() => 'model-1'),
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        getAllConfiguredModels: vi.fn(() =>
          Array.from({ length: 12 }, (_, i) => ({
            id: `model-${i + 1}`,
            label: `Model ${i + 1}`,
            description: `Description ${i + 1}`,
            authType: AuthType.USE_OPENAI,
          })),
        ),
      },
    );

    const props = mockedSelect.mock.calls[0][0];
    expect(props.maxItemsToShow).toBe(3);
  });

  it('falls back to the default max item count when no terminal height is given', () => {
    renderComponent(
      {},
      {
        getModel: vi.fn(() => 'model-1'),
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        getAllConfiguredModels: vi.fn(() =>
          Array.from({ length: 12 }, (_, i) => ({
            id: `model-${i + 1}`,
            label: `Model ${i + 1}`,
            description: '',
            authType: AuthType.USE_OPENAI,
          })),
        ),
      },
    );

    const props = mockedSelect.mock.calls[0][0];
    expect(props.maxItemsToShow).toBe(10);
  });

  it('clamps visible model options to the default max when the terminal is tall', () => {
    renderComponent(
      { availableTerminalHeight: 100 },
      {
        getModel: vi.fn(() => 'model-1'),
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        getAllConfiguredModels: vi.fn(() =>
          Array.from({ length: 12 }, (_, i) => ({
            id: `model-${i + 1}`,
            label: `Model ${i + 1}`,
            description: '',
            authType: AuthType.USE_OPENAI,
          })),
        ),
      },
    );

    // floor((100 - 14) / 1) = 86 rows of budget, clamped to the 10-item max.
    const props = mockedSelect.mock.calls[0][0];
    expect(props.maxItemsToShow).toBe(10);
  });

  it('shrinks visible model options to leave room for a displayed error message', async () => {
    const switchModel = vi.fn().mockRejectedValue(new Error('network down'));

    renderComponent(
      { availableTerminalHeight: 20 },
      {
        getModel: vi.fn(() => 'model-1'),
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        switchModel,
        getAllConfiguredModels: vi.fn(() =>
          Array.from({ length: 12 }, (_, i) => ({
            id: `model-${i + 1}`,
            label: `Model ${i + 1}`,
            description: '',
            authType: AuthType.USE_OPENAI,
          })),
        ),
      },
    );

    const initialProps = mockedSelect.mock.calls[0][0];
    expect(initialProps.maxItemsToShow).toBe(6);

    await act(async () => {
      await initialProps.onSelect(initialProps.items[0].value);
    });

    const propsAfterError =
      mockedSelect.mock.calls[mockedSelect.mock.calls.length - 1][0];
    // errorMessage = "Failed to switch model to 'model-1'.\n\nnetwork down"
    // (3 lines) -> errorMessageRows = 2 + 3 = 5 ->
    // max(1, floor((20 - 14 - 5) / 1)) = 1.
    expect(propsAfterError.maxItemsToShow).toBe(1);
  });

  it('hides discontinued qwen-oauth models for other auth types', () => {
    renderComponent(
      {},
      {
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        getAllConfiguredModels: vi.fn(() => [
          {
            id: DEFAULT_QWEN_MODEL,
            label: DEFAULT_QWEN_MODEL,
            authType: AuthType.QWEN_OAUTH,
          },
          {
            id: 'gpt-4',
            label: 'GPT-4',
            authType: AuthType.USE_OPENAI,
          },
        ]),
      },
    );

    const items = mockedSelect.mock.calls[0][0].items;
    expect(items).toHaveLength(1);
    expect(items[0].value).toBe(`${AuthType.USE_OPENAI}::gpt-4`);
  });

  it('initializes with the model from ConfigContext', () => {
    const mockGetModel = vi.fn(() => DEFAULT_QWEN_MODEL);
    renderComponent(
      {},
      {
        getModel: mockGetModel,
        getAvailableModelsForAuthType:
          createMockGetAvailableModelsForAuthType(),
      },
    );

    expect(mockGetModel).toHaveBeenCalled();
    // Calculate expected index dynamically based on model list
    const qwenModels = getFilteredQwenModels();
    const expectedIndex = qwenModels.findIndex(
      (m) => m.id === DEFAULT_QWEN_MODEL,
    );
    expect(mockedSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        initialIndex: expectedIndex,
      }),
      undefined,
    );
  });

  it('initializes with default coder model if context is not provided', () => {
    renderComponent({}, undefined);

    expect(mockedSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        initialIndex: 0,
      }),
      undefined,
    );
  });

  it('initializes with default coder model if getModel returns undefined', () => {
    const mockGetModel = vi.fn(() => undefined as unknown as string);
    renderComponent(
      {},
      {
        getModel: mockGetModel,
        getAvailableModelsForAuthType:
          createMockGetAvailableModelsForAuthType(),
      },
    );

    expect(mockGetModel).toHaveBeenCalled();

    // When getModel returns undefined, preferredModel falls back to DEFAULT_QWEN_MODEL
    // which has index 0, so initialIndex should be 0
    expect(mockedSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        initialIndex: 0,
      }),
      undefined,
    );
    expect(mockedSelect).toHaveBeenCalledTimes(1);
  });

  it('blocks qwen-oauth model selection with an error message (discontinued)', async () => {
    const { props, mockConfig } = renderComponent(
      {},
      {
        getAvailableModelsForAuthType: vi.fn((t: AuthType) => {
          if (t === AuthType.QWEN_OAUTH) {
            return getFilteredQwenModels().map((m) => ({
              id: m.id,
              label: m.label,
              authType: AuthType.QWEN_OAUTH,
            }));
          }
          return [];
        }),
      },
    );

    const childOnSelect = mockedSelect.mock.calls[0][0].onSelect;
    expect(childOnSelect).toBeDefined();

    await childOnSelect(`${AuthType.QWEN_OAUTH}::${DEFAULT_QWEN_MODEL}`);

    // qwen-oauth is discontinued — switchModel should NOT be called
    expect(mockConfig?.switchModel).not.toHaveBeenCalled();
    // Dialog should NOT close (user stays in the dialog to see the error)
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('calls config.switchModel and onClose when selecting a non-OAuth model', async () => {
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const getAuthType = vi.fn(() => AuthType.USE_OPENAI);
    const getAvailableModelsForAuthType = vi.fn((t: AuthType) => {
      if (t === AuthType.USE_OPENAI) {
        return [{ id: 'gpt-4', label: 'GPT-4', authType: t }];
      }
      if (t === AuthType.QWEN_OAUTH) {
        return getFilteredQwenModels().map((m) => ({
          id: m.id,
          label: m.label,
          authType: AuthType.QWEN_OAUTH,
        }));
      }
      return [];
    });

    const { props, mockSettings } = renderComponent({}, {
      getModel: vi.fn(() => 'gpt-4'),
      getAuthType,
      switchModel,
      getAvailableModelsForAuthType,
      getAllConfiguredModels: vi.fn(() => [
        ...getFilteredQwenModels().map((m) => ({
          id: m.id,
          label: m.label,
          description: m.description || '',
          authType: AuthType.QWEN_OAUTH,
        })),
        {
          id: 'gpt-4',
          label: 'GPT-4',
          description: 'GPT-4 model',
          authType: AuthType.USE_OPENAI,
        },
      ]),
      getContentGeneratorConfig: vi.fn(() => ({
        authType: AuthType.USE_OPENAI,
        model: 'gpt-4',
      })),
    } as unknown as Partial<Config>);

    const childOnSelect = mockedSelect.mock.calls[0][0].onSelect;
    expect(childOnSelect).toBeDefined();

    // Select a non-OAuth model (USE_OPENAI)
    await childOnSelect(`${AuthType.USE_OPENAI}::gpt-4`);

    expect(switchModel).toHaveBeenCalledWith(AuthType.USE_OPENAI, 'gpt-4', {
      baseUrl: undefined,
    });
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'model.name',
      'gpt-4',
    );
    // The selected provider has no baseUrl, so the disambiguator must be
    // cleared with an empty-string tombstone (overrides any lower-scope value).
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'model.baseUrl',
      '',
    );
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'security.auth.selectedType',
      AuthType.USE_OPENAI,
    );
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('persists model.baseUrl alongside model.name when the selected provider has a baseUrl', async () => {
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const { props, mockSettings } = renderComponent({}, {
      getModel: vi.fn(() => 'qwen3.7-max'),
      getAuthType: vi.fn(() => AuthType.USE_OPENAI),
      switchModel,
      getAllConfiguredModels: vi.fn(() => [
        {
          id: 'qwen3.7-max',
          label: '[Token Plan] qwen3.7-max',
          description: '',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://token-plan.example.com/v1',
          envKey: 'TOKEN_PLAN_KEY',
        },
        {
          id: 'qwen3.7-max',
          label: '[IdeaLab] qwen3.7-max',
          description: '',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://idealab.example.com/v1',
          envKey: 'IDEALAB_KEY',
        },
      ]),
      getContentGeneratorConfig: vi.fn(() => ({
        authType: AuthType.USE_OPENAI,
        model: 'qwen3.7-max',
        baseUrl: 'https://idealab.example.com/v1',
      })),
    } as unknown as Partial<Config>);

    const childOnSelect = mockedSelect.mock.calls[0][0].onSelect;
    // Select the IdeaLab entry (second provider with the same id).
    await childOnSelect(
      `${AuthType.USE_OPENAI}::qwen3.7-max\0https://idealab.example.com/v1`,
    );

    expect(switchModel).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      'qwen3.7-max',
      {
        baseUrl: 'https://idealab.example.com/v1',
      },
    );
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'model.name',
      'qwen3.7-max',
    );
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'model.baseUrl',
      'https://idealab.example.com/v1',
    );
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('falls back to the picker entry baseUrl when switchModel does not propagate it', async () => {
    // Regression guard for the `after?.baseUrl ?? selectedEntry?.model.baseUrl`
    // fallback: if switchModel succeeds but getContentGeneratorConfig returns a
    // config WITHOUT baseUrl, the disambiguator must still be persisted from the
    // selected picker entry's baseUrl — otherwise an empty-string tombstone would
    // be written and the wrong same-id provider would resolve on next launch.
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const { props, mockSettings } = renderComponent({}, {
      getModel: vi.fn(() => 'qwen3.7-max'),
      getAuthType: vi.fn(() => AuthType.USE_OPENAI),
      switchModel,
      getAllConfiguredModels: vi.fn(() => [
        {
          id: 'qwen3.7-max',
          label: '[Token Plan] qwen3.7-max',
          description: '',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://token-plan.example.com/v1',
          envKey: 'TOKEN_PLAN_KEY',
        },
        {
          id: 'qwen3.7-max',
          label: '[IdeaLab] qwen3.7-max',
          description: '',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://idealab.example.com/v1',
          envKey: 'IDEALAB_KEY',
        },
      ]),
      // Resolved config has NO baseUrl, so `after?.baseUrl` is undefined and the
      // `?? selectedEntry?.model.baseUrl` fallback must supply the disambiguator.
      getContentGeneratorConfig: vi.fn(() => ({
        authType: AuthType.USE_OPENAI,
        model: 'qwen3.7-max',
      })),
    } as unknown as Partial<Config>);

    const childOnSelect = mockedSelect.mock.calls[0][0].onSelect;
    // Select the IdeaLab entry (second provider with the same id).
    await childOnSelect(
      `${AuthType.USE_OPENAI}::qwen3.7-max\0https://idealab.example.com/v1`,
    );

    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'model.name',
      'qwen3.7-max',
    );
    // baseUrl comes from the picker entry, not the (baseUrl-less) resolved config.
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'model.baseUrl',
      'https://idealab.example.com/v1',
    );
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('shows MiniMax-M3 image + video modality and 1M context details', () => {
    const { getByText } = renderComponent({}, {
      getModel: vi.fn(() => 'MiniMax-M3'),
      getAuthType: vi.fn(() => AuthType.USE_OPENAI),
      getAllConfiguredModels: vi.fn(() => [
        {
          id: 'MiniMax-M3',
          label: '[MiniMax] MiniMax-M3',
          description: '',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://api.minimaxi.com/v1',
          envKey: 'MINIMAX_API_KEY',
          modalities: { image: true, video: true },
          contextWindowSize: 1000000,
        },
      ]),
      getModelsConfig: vi.fn(() => ({
        getGenerationConfig: vi.fn(() => ({
          baseUrl: 'https://api.minimaxi.com/v1',
        })),
      })),
    } as unknown as Partial<Config>);

    expect(getByText('Modality:')).toBeDefined();
    expect(getByText('text · image · video')).toBeDefined();
    expect(getByText('Context Window:')).toBeDefined();
    expect(getByText('1,000,000 tokens')).toBeDefined();
  });

  it('hydrates provider API key env from settings.env before switching', async () => {
    const previousMinimaxKey = process.env['MINIMAX_API_KEY'];
    delete process.env['MINIMAX_API_KEY'];

    try {
      const switchModel = vi.fn().mockImplementation(async () => {
        expect(process.env['MINIMAX_API_KEY']).toBe('sk-minimax-from-settings');
      });

      renderComponent(
        {},
        {
          getModel: vi.fn(() => 'MiniMax-M2.7'),
          getAuthType: vi.fn(() => AuthType.USE_OPENAI),
          switchModel,
          getAllConfiguredModels: vi.fn(() => [
            {
              id: 'MiniMax-M3',
              label: '[MiniMax] MiniMax-M3',
              description: '',
              authType: AuthType.USE_OPENAI,
              baseUrl: 'https://api.minimaxi.com/v1',
              envKey: 'MINIMAX_API_KEY',
              modalities: { image: true, video: true },
              contextWindowSize: 1000000,
            },
          ]),
          getModelsConfig: vi.fn(() => ({
            getGenerationConfig: vi.fn(() => ({
              baseUrl: 'https://api.minimaxi.com/v1',
            })),
          })),
          getContentGeneratorConfig: vi.fn(() => ({
            authType: AuthType.USE_OPENAI,
            model: 'MiniMax-M3',
            apiKey: 'sk-minimax-from-settings',
            baseUrl: 'https://api.minimaxi.com/v1',
          })),
        } as unknown as Partial<Config>,
        {
          merged: {
            env: { MINIMAX_API_KEY: 'sk-minimax-from-settings' },
          },
        } as unknown as Partial<LoadedSettings>,
      );

      const selected = mockedSelect.mock.calls[0][0].items[0].value;
      await mockedSelect.mock.calls[0][0].onSelect(selected);

      expect(switchModel).toHaveBeenCalledWith(
        AuthType.USE_OPENAI,
        'MiniMax-M3',
        { baseUrl: 'https://api.minimaxi.com/v1' },
      );
    } finally {
      if (previousMinimaxKey === undefined) {
        delete process.env['MINIMAX_API_KEY'];
      } else {
        process.env['MINIMAX_API_KEY'] = previousMinimaxKey;
      }
    }
  });

  it('stores authType-qualified selectors in fast model mode', async () => {
    const setFastModel = vi.fn();
    const { props, mockSettings, recordSlashCommand } = renderComponent(
      { isFastModelMode: true },
      {
        getAuthType: vi.fn(() => AuthType.USE_ANTHROPIC),
        getModel: vi.fn(() => 'claude-opus-4-7'),
        getAllConfiguredModels: vi.fn(() => [
          {
            id: 'deepseek-v4-flash',
            label: 'deepseek-v4-flash',
            authType: AuthType.USE_OPENAI,
          },
          {
            id: 'claude-opus-4-7',
            label: 'claude-opus-4-7',
            authType: AuthType.USE_ANTHROPIC,
          },
        ]),
        getContentGeneratorConfig: vi.fn(() => ({
          authType: AuthType.USE_ANTHROPIC,
          model: 'claude-opus-4-7',
        })),
        setFastModel,
      } as unknown as Partial<Config>,
    );

    const childOnSelect = mockedSelect.mock.calls[0][0].onSelect;
    await childOnSelect(`${AuthType.USE_OPENAI}::deepseek-v4-flash`);

    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'fastModel',
      'openai:deepseek-v4-flash',
    );
    expect(setFastModel).toHaveBeenCalledWith('openai:deepseek-v4-flash');
    expect(recordSlashCommand).toHaveBeenCalledWith({
      phase: 'result',
      rawCommand: '/model',
      outputHistoryItems: [
        { type: 'success', text: 'Fast Model: openai:deepseek-v4-flash' },
      ],
    });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('stores authType-qualified selectors in vision model mode without switching models', async () => {
    const switchModel = vi.fn();
    const setVisionModel = vi.fn();
    const { props, mockSettings, recordSlashCommand } = renderComponent(
      { isVisionModelMode: true },
      {
        getAuthType: vi.fn(() => AuthType.USE_ANTHROPIC),
        getModel: vi.fn(() => 'claude-opus-4-7'),
        switchModel,
        getAllConfiguredModels: vi.fn(() => [
          {
            id: 'qwen-vl-max',
            label: 'qwen-vl-max',
            authType: AuthType.USE_OPENAI,
          },
          {
            id: 'claude-opus-4-7',
            label: 'claude-opus-4-7',
            authType: AuthType.USE_ANTHROPIC,
          },
        ]),
        getContentGeneratorConfig: vi.fn(() => ({
          authType: AuthType.USE_ANTHROPIC,
          model: 'claude-opus-4-7',
        })),
        isCurrentPrimaryModel: (m: { id: string; authType?: string }) =>
          m.id === 'claude-opus-4-7' && m.authType === AuthType.USE_ANTHROPIC,
        setVisionModel,
      } as unknown as Partial<Config>,
    );

    const childOnSelect = mockedSelect.mock.calls[0][0].onSelect;
    await childOnSelect(`${AuthType.USE_OPENAI}::qwen-vl-max`);

    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'visionModel',
      'openai:qwen-vl-max',
    );
    expect(setVisionModel).toHaveBeenCalledWith('openai:qwen-vl-max');
    expect(recordSlashCommand).toHaveBeenCalledWith({
      phase: 'result',
      rawCommand: '/model',
      outputHistoryItems: [
        { type: 'success', text: 'Vision Model: openai:qwen-vl-max' },
      ],
    });
    expect(switchModel).not.toHaveBeenCalled();
    expect(mockSettings.setValue).not.toHaveBeenCalledWith(
      SettingScope.User,
      'model.name',
      expect.any(String),
    );
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('stores compaction model selector without switching models', async () => {
    const switchModel = vi.fn();
    const setCompactionModel = vi.fn();
    const { props, mockSettings, recordSlashCommand } = renderComponent(
      { isCompactionModelMode: true },
      {
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        getModel: vi.fn(() => 'gpt-4'),
        switchModel,
        getAllConfiguredModels: vi.fn(() => [
          {
            id: 'compaction-model',
            label: 'compaction-model',
            authType: AuthType.USE_OPENAI,
          },
          {
            id: 'gpt-4',
            label: 'gpt-4',
            authType: AuthType.USE_OPENAI,
          },
        ]),
        getContentGeneratorConfig: vi.fn(() => ({
          authType: AuthType.USE_OPENAI,
          model: 'gpt-4',
        })),
        isCurrentPrimaryModel: (m: { id: string; authType?: string }) =>
          m.id === 'gpt-4' && m.authType === AuthType.USE_OPENAI,
        setCompactionModel,
      } as unknown as Partial<Config>,
    );

    const childOnSelect = mockedSelect.mock.calls[0][0].onSelect;
    await childOnSelect(`${AuthType.USE_OPENAI}::compaction-model`);

    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'compactionModel',
      'openai:compaction-model',
    );
    expect(setCompactionModel).toHaveBeenCalledWith('openai:compaction-model');
    expect(recordSlashCommand).toHaveBeenCalledWith({
      phase: 'result',
      rawCommand: '/model',
      outputHistoryItems: [
        {
          type: 'success',
          text: 'Compaction Model: openai:compaction-model',
        },
      ],
    });
    expect(switchModel).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('shows only image-generation models and stores the exact provider route', async () => {
    const setImageModel = vi.fn().mockResolvedValue(undefined);
    const baseUrl = 'https://images.example.com/api/v1';
    const persisted = `openai:dual-role-model\0${baseUrl}`;
    const { props, mockSettings, getByText, recordSlashCommand } =
      renderComponent({ isImageModelMode: true }, {
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        getAllConfiguredModels: vi.fn(() => [
          {
            id: 'qwen-plus',
            label: 'Qwen Plus',
            authType: AuthType.USE_OPENAI,
          },
          {
            id: 'dual-role-model',
            label: 'Dual-role model',
            authType: AuthType.USE_OPENAI,
            baseUrl,
            envKey: 'IMAGE_API_KEY',
            supportsImageGeneration: true,
          },
          {
            id: 'qwen-image-2.0',
            label: 'Qwen Image 2.0',
            authType: AuthType.USE_OPENAI,
            baseUrl: 'https://legacy-images.example.com/api/v1',
            envKey: 'IMAGE_API_KEY',
            imageOnly: true,
          },
          {
            id: 'vision-only-model',
            label: 'Vision-only model',
            authType: AuthType.USE_OPENAI,
            baseUrl: 'https://vision.example.com/api/v1',
            envKey: 'IMAGE_API_KEY',
            visionOnly: true,
            imageOnly: true,
          },
          {
            id: 'image-without-credentials',
            label: 'Image without credentials',
            authType: AuthType.USE_OPENAI,
            baseUrl: 'https://invalid.example.com/api/v1',
            imageOnly: true,
          },
        ]),
        resolveImageGenerationModel: vi.fn((selector: string) => {
          if (selector === persisted) {
            return {
              model: 'dual-role-model',
              baseUrl,
              apiKeyEnv: 'IMAGE_API_KEY',
            };
          }
          if (selector.includes('qwen-image-2.0')) {
            return {
              model: 'qwen-image-2.0',
              baseUrl: 'https://legacy-images.example.com/api/v1',
              apiKeyEnv: 'IMAGE_API_KEY',
            };
          }
          if (selector.includes('vision-only-model')) {
            return {
              model: 'vision-only-model',
              baseUrl: 'https://vision.example.com/api/v1',
              apiKeyEnv: 'IMAGE_API_KEY',
            };
          }
          return undefined;
        }),
        setImageModel,
      } as unknown as Partial<Config>);

    expect(getByText('Select Image Model')).toBeDefined();
    const selectProps = mockedSelect.mock.calls[0][0];
    expect(selectProps.items).toHaveLength(3);
    expect(selectProps.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: expect.stringContaining('vision-only-model'),
        }),
      ]),
    );
    await selectProps.onSelect(
      `${AuthType.USE_OPENAI}::dual-role-model\0${baseUrl}`,
    );

    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'imageModel',
      persisted,
    );
    expect(setImageModel).toHaveBeenCalledWith(persisted);
    expect(recordSlashCommand).toHaveBeenCalledWith({
      phase: 'result',
      rawCommand: '/model',
      outputHistoryItems: [
        { type: 'success', text: 'Image Model: openai:dual-role-model' },
      ],
    });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps dual-role models in the main dialog and excludes legacy image-only models', () => {
    renderComponent({}, {
      getAuthType: vi.fn(() => AuthType.USE_OPENAI),
      getAllConfiguredModels: vi.fn(() => [
        {
          id: 'dual-role-model',
          label: 'Dual-role model',
          authType: AuthType.USE_OPENAI,
          supportsImageGeneration: true,
        },
        {
          id: 'qwen-image-2.0',
          label: 'Qwen Image 2.0',
          authType: AuthType.USE_OPENAI,
          imageOnly: true,
        },
      ]),
    } as unknown as Partial<Config>);

    const items = mockedSelect.mock.calls[0][0].items;
    expect(items).toHaveLength(1);
    expect(items[0].value).toBe(`${AuthType.USE_OPENAI}::dual-role-model`);
  });

  it.each([
    ['fast', { isFastModelMode: true }],
    ['voice', { isVoiceModelMode: true }],
    ['vision', { isVisionModelMode: true }],
    ['compaction', { isCompactionModelMode: true }],
  ] as const)('keeps dual-role models in the %s dialog', (_mode, modeProps) => {
    renderComponent(modeProps, {
      getAuthType: vi.fn(() => AuthType.USE_OPENAI),
      getAllConfiguredModels: vi.fn(() => [
        {
          id: 'dual-role-model',
          label: 'Dual-role model',
          authType: AuthType.USE_OPENAI,
          supportsImageGeneration: true,
        },
        {
          id: 'qwen-image-2.0',
          label: 'Qwen Image 2.0',
          authType: AuthType.USE_OPENAI,
          imageOnly: true,
        },
      ]),
    } as unknown as Partial<Config>);

    const items = mockedSelect.mock.calls[0][0].items;
    expect(items).toHaveLength(1);
    expect(items[0].value).toBe(`${AuthType.USE_OPENAI}::dual-role-model`);
  });

  it('ignores duplicate input while an image model selection is in flight', async () => {
    let resolveSetImageModel: (() => void) | undefined;
    const setImageModel = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSetImageModel = resolve;
        }),
    );
    const baseUrl = 'https://images.example.com/api/v1';
    const persisted = `openai:qwen-image-2.0\0${baseUrl}`;
    const { props, mockSettings, mockHistoryManager, recordSlashCommand } =
      renderComponent({ isImageModelMode: true }, {
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        getAllConfiguredModels: vi.fn(() => [
          {
            id: 'qwen-image-2.0',
            label: 'Qwen Image 2.0',
            authType: AuthType.USE_OPENAI,
            baseUrl,
            envKey: 'IMAGE_API_KEY',
            imageOnly: true,
          },
        ]),
        resolveImageGenerationModel: vi.fn(() => ({
          model: 'qwen-image-2.0',
          baseUrl,
          apiKeyEnv: 'IMAGE_API_KEY',
        })),
        setImageModel,
      } as unknown as Partial<Config>);

    const onSelect = mockedSelect.mock.calls[0][0].onSelect;
    const selection = onSelect(
      `${AuthType.USE_OPENAI}::qwen-image-2.0\0${baseUrl}`,
    );
    await onSelect(`${AuthType.USE_OPENAI}::qwen-image-2.0\0${baseUrl}`);
    mockedUseKeypress.mock.calls[0][0]({
      name: 'escape',
      ctrl: false,
      meta: false,
      shift: false,
      paste: false,
      sequence: '',
    });

    expect(setImageModel).toHaveBeenCalledTimes(1);
    expect(mockSettings.setValue).toHaveBeenCalledTimes(1);
    expect(mockHistoryManager.addItem).not.toHaveBeenCalled();
    expect(recordSlashCommand).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();

    resolveSetImageModel?.();
    await selection;

    expect(setImageModel).toHaveBeenCalledTimes(1);
    expect(mockSettings.setValue).toHaveBeenCalledTimes(1);
    expect(mockHistoryManager.addItem).toHaveBeenCalledTimes(1);
    expect(recordSlashCommand).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'imageModel',
      persisted,
    );
  });

  it('keeps the selected baseUrl for same-provider duplicate vision model ids', async () => {
    const switchModel = vi.fn();
    const setVisionModel = vi.fn();
    const selectedBaseUrl = 'https://token-plan.example.com/v1';
    const { props, mockSettings } = renderComponent(
      { isVisionModelMode: true },
      {
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        getModel: vi.fn(() => 'qwen3.7-max'),
        switchModel,
        getAllConfiguredModels: vi.fn(() => [
          {
            id: 'qwen3.7-plus',
            label: '[ModelStudio Standard] qwen3.7-plus',
            authType: AuthType.USE_OPENAI,
            baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
            modalities: { image: true, video: true },
          },
          {
            id: 'qwen3.7-plus',
            label: '[ModelStudio Token Plan] qwen3.7-plus',
            authType: AuthType.USE_OPENAI,
            baseUrl: selectedBaseUrl,
            modalities: { image: true, video: true },
          },
        ]),
        getContentGeneratorConfig: vi.fn(() => ({
          authType: AuthType.USE_OPENAI,
          model: 'qwen3.7-max',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        })),
        isCurrentPrimaryModel: (m: { id: string }) => m.id === 'qwen3.7-max',
        setVisionModel,
      } as unknown as Partial<Config>,
    );

    const childOnSelect = mockedSelect.mock.calls[0][0].onSelect;
    await childOnSelect(
      `${AuthType.USE_OPENAI}::qwen3.7-plus\0${selectedBaseUrl}`,
    );

    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'visionModel',
      `openai:qwen3.7-plus\0${selectedBaseUrl}`,
    );
    expect(setVisionModel).toHaveBeenCalledWith(
      `openai:qwen3.7-plus\0${selectedBaseUrl}`,
    );
    expect(switchModel).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('warns in the history when a pinned vision model is not image-capable', async () => {
    // qwen-plus is text-only by name default, so the pin is honored but flagged.
    // The primary is a different model so the pin isn't rejected as the primary.
    const setVisionModel = vi.fn();
    const { mockHistoryManager } = renderComponent(
      { isVisionModelMode: true },
      {
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        getModel: vi.fn(() => 'qwen3.7-max'),
        getAllConfiguredModels: vi.fn(() => [
          {
            id: 'qwen-plus',
            label: 'qwen-plus',
            authType: AuthType.USE_OPENAI,
          },
        ]),
        getContentGeneratorConfig: vi.fn(() => ({
          authType: AuthType.USE_OPENAI,
          model: 'qwen3.7-max',
        })),
        isCurrentPrimaryModel: (m: { id: string }) => m.id === 'qwen3.7-max',
        setVisionModel,
      } as unknown as Partial<Config>,
    );

    const childOnSelect = mockedSelect.mock.calls[0][0].onSelect;
    await childOnSelect(`${AuthType.USE_OPENAI}::qwen-plus`);

    expect(setVisionModel).toHaveBeenCalledWith('openai:qwen-plus');
    expect(mockHistoryManager.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'success',
        text: expect.stringContaining('not a known image-capable model'),
      }),
      expect.any(Number),
    );
  });

  it('stores the plain model id in voice model mode without switching models', async () => {
    const switchModel = vi.fn();
    const setFastModel = vi.fn();
    const { props, mockSettings, recordSlashCommand } = renderComponent(
      { isVoiceModelMode: true },
      {
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        getModel: vi.fn(() => 'qwen3.7-max'),
        switchModel,
        getAllConfiguredModels: vi.fn(() => [
          {
            id: 'qwen3-asr-flash',
            label: 'qwen3-asr-flash',
            authType: AuthType.USE_OPENAI,
            baseUrl: 'https://dashscope.example/v1',
          },
          {
            id: 'qwen3.7-max',
            label: 'qwen3.7-max',
            authType: AuthType.USE_OPENAI,
          },
        ]),
        getContentGeneratorConfig: vi.fn(() => ({
          authType: AuthType.USE_OPENAI,
          model: 'qwen3.7-max',
        })),
        setFastModel,
      } as unknown as Partial<Config>,
    );

    const selectProps = mockedSelect.mock.calls[0][0];
    await selectProps.onSelect(selectProps.items[0].value);

    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'voiceModel',
      'qwen3-asr-flash',
    );
    expect(switchModel).not.toHaveBeenCalled();
    expect(setFastModel).not.toHaveBeenCalled();
    expect(recordSlashCommand).toHaveBeenCalledWith({
      phase: 'result',
      rawCommand: '/model',
      outputHistoryItems: [
        { type: 'success', text: 'Voice Model: qwen3-asr-flash' },
      ],
    });
    expect(mockSettings.setValue).not.toHaveBeenCalledWith(
      SettingScope.User,
      'model.name',
      expect.any(String),
    );
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('does not store a voice model without a transcription baseUrl', async () => {
    const switchModel = vi.fn();
    const { props, mockSettings } = renderComponent(
      { isVoiceModelMode: true },
      {
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        getModel: vi.fn(() => 'qwen3.7-max'),
        switchModel,
        getAllConfiguredModels: vi.fn(() => [
          {
            id: 'qwen3-coder',
            label: 'qwen3-coder',
            authType: AuthType.USE_OPENAI,
          },
        ]),
        getContentGeneratorConfig: vi.fn(() => ({
          authType: AuthType.USE_OPENAI,
          model: 'qwen3.7-max',
        })),
      } as unknown as Partial<Config>,
    );

    const childOnSelect = mockedSelect.mock.calls[0][0].onSelect;
    await childOnSelect(`${AuthType.USE_OPENAI}::qwen3-coder`);

    expect(mockSettings.setValue).not.toHaveBeenCalled();
    expect(switchModel).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('highlights the cross-auth row for a bare fast-model setting', () => {
    // `/model --fast deepseek-v4-flash` validates across all providers and
    // persists the bare model id. When the dialog re-opens, it must locate
    // the right row even though the setting carries no authType prefix —
    // otherwise the highlight falls back to the current auth's first row
    // and Enter would silently overwrite the setting.
    const mockSettings = {
      isTrusted: true,
      user: { settings: {} },
      workspace: { settings: {} },
      merged: { fastModel: 'deepseek-v4-flash' },
      setValue: vi.fn(),
    } as unknown as LoadedSettings;

    const allModels = [
      {
        id: 'claude-opus-4-7',
        label: 'claude-opus-4-7',
        description: '',
        authType: AuthType.USE_ANTHROPIC,
      },
      {
        id: 'deepseek-v4-flash',
        label: 'deepseek-v4-flash',
        description: '',
        authType: AuthType.USE_OPENAI,
      },
    ];

    render(
      <SettingsContext.Provider value={mockSettings}>
        <ConfigContext.Provider
          value={
            {
              getModel: vi.fn(() => 'claude-opus-4-7'),
              getAuthType: vi.fn(() => AuthType.USE_ANTHROPIC),
              getAllConfiguredModels: vi.fn(() => allModels),
              getContentGeneratorConfig: vi.fn(() => ({
                authType: AuthType.USE_ANTHROPIC,
                model: 'claude-opus-4-7',
              })),
              getModelsConfig: vi.fn(() => ({
                getGenerationConfig: vi.fn(() => ({ baseUrl: undefined })),
              })),
              getActiveRuntimeModelSnapshot: vi.fn(() => undefined),
              getUsageStatisticsEnabled: vi.fn(() => false),
              getSessionId: vi.fn(() => 'session'),
              getDebugMode: vi.fn(() => false),
              getUseModelRouter: vi.fn(() => false),
              getProxy: vi.fn(() => undefined),
            } as unknown as Config
          }
        >
          <ModelDialog onClose={vi.fn()} isFastModelMode={true} />
        </ConfigContext.Provider>
      </SettingsContext.Provider>,
    );

    const items = mockedSelect.mock.calls[0][0].items;
    const deepseekIndex = items.findIndex((item) =>
      String(item.value).includes('deepseek-v4-flash'),
    );
    expect(deepseekIndex).toBeGreaterThanOrEqual(0);
    expect(mockedSelect.mock.calls[0][0].initialIndex).toBe(deepseekIndex);
  });

  it('highlights the cross-auth row for a bare vision-model setting', () => {
    // `/model --vision qwen-vl-max` validates across all providers and persists
    // the bare model id. When the dialog re-opens in vision mode, the
    // preferred-entry resolution must locate that row even though the setting
    // carries no authType prefix — otherwise the highlight falls back to the
    // current auth's first row and Enter would silently overwrite the setting.
    const mockSettings = {
      isTrusted: true,
      user: { settings: {} },
      workspace: { settings: {} },
      merged: { visionModel: 'qwen-vl-max' },
      setValue: vi.fn(),
    } as unknown as LoadedSettings;

    const allModels = [
      {
        id: 'claude-opus-4-7',
        label: 'claude-opus-4-7',
        description: '',
        authType: AuthType.USE_ANTHROPIC,
      },
      {
        id: 'qwen-vl-max',
        label: 'qwen-vl-max',
        description: '',
        authType: AuthType.USE_OPENAI,
      },
    ];

    render(
      <SettingsContext.Provider value={mockSettings}>
        <ConfigContext.Provider
          value={
            {
              getModel: vi.fn(() => 'claude-opus-4-7'),
              getAuthType: vi.fn(() => AuthType.USE_ANTHROPIC),
              getAllConfiguredModels: vi.fn(() => allModels),
              getContentGeneratorConfig: vi.fn(() => ({
                authType: AuthType.USE_ANTHROPIC,
                model: 'claude-opus-4-7',
              })),
              getModelsConfig: vi.fn(() => ({
                getGenerationConfig: vi.fn(() => ({ baseUrl: undefined })),
              })),
              getActiveRuntimeModelSnapshot: vi.fn(() => undefined),
              getUsageStatisticsEnabled: vi.fn(() => false),
              getSessionId: vi.fn(() => 'session'),
              getDebugMode: vi.fn(() => false),
              getUseModelRouter: vi.fn(() => false),
              getProxy: vi.fn(() => undefined),
            } as unknown as Config
          }
        >
          <ModelDialog onClose={vi.fn()} isVisionModelMode={true} />
        </ConfigContext.Provider>
      </SettingsContext.Provider>,
    );

    const items = mockedSelect.mock.calls[0][0].items;
    const visionIndex = items.findIndex((item) =>
      String(item.value).includes('qwen-vl-max'),
    );
    expect(visionIndex).toBeGreaterThanOrEqual(0);
    expect(mockedSelect.mock.calls[0][0].initialIndex).toBe(visionIndex);
  });

  it('highlights the matching baseUrl for duplicate vision-model settings', () => {
    const selectedBaseUrl = 'https://token-plan.example.com/v1';
    const mockSettings = {
      isTrusted: true,
      user: { settings: {} },
      workspace: { settings: {} },
      merged: {
        visionModel: `openai:qwen3.7-plus\0${selectedBaseUrl}`,
      },
      setValue: vi.fn(),
    } as unknown as LoadedSettings;

    const allModels = [
      {
        id: 'qwen3.7-plus',
        label: '[ModelStudio Standard] qwen3.7-plus',
        description: '',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      },
      {
        id: 'qwen3.7-plus',
        label: '[ModelStudio Token Plan] qwen3.7-plus',
        description: '',
        authType: AuthType.USE_OPENAI,
        baseUrl: selectedBaseUrl,
      },
    ];

    render(
      <SettingsContext.Provider value={mockSettings}>
        <ConfigContext.Provider
          value={
            {
              getModel: vi.fn(() => 'qwen3.7-max'),
              getAuthType: vi.fn(() => AuthType.USE_OPENAI),
              getAllConfiguredModels: vi.fn(() => allModels),
              getContentGeneratorConfig: vi.fn(() => ({
                authType: AuthType.USE_OPENAI,
                model: 'qwen3.7-max',
                baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
              })),
              getModelsConfig: vi.fn(() => ({
                getGenerationConfig: vi.fn(() => ({
                  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
                })),
              })),
              getActiveRuntimeModelSnapshot: vi.fn(() => undefined),
              getUsageStatisticsEnabled: vi.fn(() => false),
              getSessionId: vi.fn(() => 'session'),
              getDebugMode: vi.fn(() => false),
              getUseModelRouter: vi.fn(() => false),
              getProxy: vi.fn(() => undefined),
            } as unknown as Config
          }
        >
          <ModelDialog onClose={vi.fn()} isVisionModelMode={true} />
        </ConfigContext.Provider>
      </SettingsContext.Provider>,
    );

    const items = mockedSelect.mock.calls[0][0].items;
    const visionIndex = items.findIndex(
      (item) =>
        String(item.value).includes('qwen3.7-plus') &&
        String(item.value).includes(selectedBaseUrl),
    );
    expect(visionIndex).toBeGreaterThanOrEqual(0);
    expect(mockedSelect.mock.calls[0][0].initialIndex).toBe(visionIndex);
  });

  it('passes onHighlight to DescriptiveRadioButtonSelect', () => {
    renderComponent();

    const childOnHighlight = mockedSelect.mock.calls[0][0].onHighlight;
    expect(childOnHighlight).toBeDefined();
    expect(typeof childOnHighlight).toBe('function');
  });

  it('reports the unchanged model when "escape" closes the primary picker', () => {
    const { props, mockHistoryManager } = renderComponent();

    expect(mockedUseKeypress).toHaveBeenCalled();

    const keyPressHandler = mockedUseKeypress.mock.calls[0][0];
    const options = mockedUseKeypress.mock.calls[0][1];

    expect(options).toEqual({ isActive: true });

    keyPressHandler({
      name: 'escape',
      ctrl: false,
      meta: false,
      shift: false,
      paste: false,
      sequence: '',
    });
    expect(mockHistoryManager.addItem).toHaveBeenCalledWith(
      {
        type: 'info',
        text: `Kept model as ${DEFAULT_QWEN_MODEL}`,
      },
      expect.any(Number),
    );
    expect(props.onClose).toHaveBeenCalledTimes(1);

    // A second Escape byte in the same stdin chunk must not double-report.
    keyPressHandler({
      name: 'escape',
      ctrl: false,
      meta: false,
      shift: false,
      paste: false,
      sequence: '',
    });
    expect(mockHistoryManager.addItem).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledTimes(1);

    keyPressHandler({
      name: 'a',
      ctrl: false,
      meta: false,
      shift: false,
      paste: false,
      sequence: '',
    });
    expect(mockHistoryManager.addItem).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('records dismissal feedback for resumed history', () => {
    const recordSlashCommand = vi.fn();
    const { mockHistoryManager } = renderComponent({}, {
      getChatRecordingService: vi.fn(() => ({ recordSlashCommand })),
    } as unknown as Partial<Config>);

    const keyPressHandler = mockedUseKeypress.mock.calls[0][0];
    keyPressHandler({
      name: 'escape',
      ctrl: false,
      meta: false,
      shift: false,
      paste: false,
      sequence: '',
    });

    expect(mockHistoryManager.addItem).toHaveBeenCalledTimes(1);
    expect(recordSlashCommand).toHaveBeenCalledWith({
      phase: 'result',
      rawCommand: '/model',
      outputHistoryItems: [
        { type: 'info', text: `Kept model as ${DEFAULT_QWEN_MODEL}` },
      ],
    });
  });

  it('does not close the primary picker on "left"', () => {
    const { props, mockHistoryManager } = renderComponent();

    const keyPressHandler = mockedUseKeypress.mock.calls[0][0];
    keyPressHandler({
      name: 'left',
      ctrl: false,
      meta: false,
      shift: false,
      paste: false,
      sequence: '',
    });

    expect(mockHistoryManager.addItem).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it.each([
    [{ isFastModelMode: true }, 'escape'],
    [{ isVoiceModelMode: true }, 'escape'],
    [{ isVisionModelMode: true }, 'escape'],
    [{ isCompactionModelMode: true }, 'escape'],
    [{ isImageModelMode: true }, 'escape'],
    [{ isFastModelMode: true }, 'left'],
    [{ isVoiceModelMode: true }, 'left'],
    [{ isVisionModelMode: true }, 'left'],
    [{ isCompactionModelMode: true }, 'left'],
    [{ isImageModelMode: true }, 'left'],
  ])(
    'does not report the primary model when closing an auxiliary picker (%j, %s)',
    (modeProps, keyName) => {
      const { props, mockHistoryManager } = renderComponent(modeProps);

      const keyPressHandler = mockedUseKeypress.mock.calls[0][0];
      keyPressHandler({
        name: keyName,
        ctrl: false,
        meta: false,
        shift: false,
        paste: false,
        sequence: '',
      });

      expect(mockHistoryManager.addItem).not.toHaveBeenCalled();
      expect(props.onClose).toHaveBeenCalledTimes(1);
    },
  );

  it('reports the active runtime model when closing the primary picker', () => {
    const { mockHistoryManager } = renderComponent({}, {
      getModel: vi.fn(() => 'configured-model'),
      getActiveRuntimeModelSnapshot: vi.fn(() => ({
        id: '$runtime|qwen-oauth|runtime-model',
        authType: AuthType.QWEN_OAUTH,
        modelId: 'runtime-model',
      })),
    } as unknown as Partial<Config>);

    const keyPressHandler = mockedUseKeypress.mock.calls[0][0];
    keyPressHandler({
      name: 'escape',
      ctrl: false,
      meta: false,
      shift: false,
      paste: false,
      sequence: '',
    });

    expect(mockHistoryManager.addItem).toHaveBeenCalledWith(
      { type: 'info', text: 'Kept model as runtime-model' },
      expect.any(Number),
    );
  });

  it('does not report the unchanged model when a selection is made', async () => {
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const { props, mockHistoryManager } = renderComponent({}, {
      getModel: vi.fn(() => 'gpt-4'),
      getAuthType: vi.fn(() => AuthType.USE_OPENAI),
      switchModel,
      getAllConfiguredModels: vi.fn(() => [
        {
          id: 'gpt-4',
          label: 'GPT-4',
          description: 'GPT-4 model',
          authType: AuthType.USE_OPENAI,
        },
      ]),
      getContentGeneratorConfig: vi.fn(() => ({
        authType: AuthType.USE_OPENAI,
        model: 'gpt-4',
      })),
    } as unknown as Partial<Config>);

    const childOnSelect = mockedSelect.mock.calls[0][0].onSelect;
    await childOnSelect(`${AuthType.USE_OPENAI}::gpt-4`);

    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(mockHistoryManager.addItem).not.toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Kept model as'),
      }),
      expect.any(Number),
    );

    const keyPressHandler = mockedUseKeypress.mock.calls[0][0];
    keyPressHandler({
      name: 'escape',
      ctrl: false,
      meta: false,
      shift: false,
      paste: false,
      sequence: '',
    });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('records successful model-switch feedback for resumed history', async () => {
    const recordSlashCommand = vi.fn();
    const { mockHistoryManager } = renderComponent({}, {
      getModel: vi.fn(() => 'gpt-4'),
      getAuthType: vi.fn(() => AuthType.USE_OPENAI),
      switchModel: vi.fn().mockResolvedValue(undefined),
      getAllConfiguredModels: vi.fn(() => [
        {
          id: 'gpt-4',
          label: 'GPT-4',
          authType: AuthType.USE_OPENAI,
        },
      ]),
      getContentGeneratorConfig: vi.fn(() => ({
        authType: AuthType.USE_OPENAI,
        model: 'gpt-4',
      })),
      getChatRecordingService: vi.fn(() => ({ recordSlashCommand })),
    } as unknown as Partial<Config>);

    await act(async () => {
      await mockedSelect.mock.calls[0][0].onSelect(
        `${AuthType.USE_OPENAI}::gpt-4`,
      );
    });

    const feedbackItem = vi.mocked(mockHistoryManager.addItem).mock.calls[0][0];
    expect(feedbackItem.text).toContain('Using model: gpt-4');
    expect(recordSlashCommand).toHaveBeenCalledWith({
      phase: 'result',
      rawCommand: '/model',
      outputHistoryItems: [feedbackItem],
    });
  });

  it('remains dismissible after a failed model switch', async () => {
    const { props, mockHistoryManager } = renderComponent({}, {
      getModel: vi.fn(() => 'gpt-4'),
      getAuthType: vi.fn(() => AuthType.USE_OPENAI),
      switchModel: vi.fn().mockRejectedValue(new Error('network down')),
      getAllConfiguredModels: vi.fn(() => [
        {
          id: 'gpt-4',
          label: 'GPT-4',
          authType: AuthType.USE_OPENAI,
        },
      ]),
    } as unknown as Partial<Config>);

    await act(async () => {
      await mockedSelect.mock.calls[0][0].onSelect(
        `${AuthType.USE_OPENAI}::gpt-4`,
      );
    });
    expect(props.onClose).not.toHaveBeenCalled();

    mockedUseKeypress.mock.calls[0][0]({
      name: 'escape',
      ctrl: false,
      meta: false,
      shift: false,
      paste: false,
      sequence: '',
    });

    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(mockHistoryManager.addItem).toHaveBeenCalledWith(
      { type: 'info', text: 'Kept model as gpt-4' },
      expect.any(Number),
    );
  });

  it('ignores escape while a model selection is in flight', async () => {
    let resolveSwitch: (() => void) | undefined;
    const switchModel = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSwitch = resolve;
        }),
    );
    const { props, mockHistoryManager } = renderComponent({}, {
      getModel: vi.fn(() => 'gpt-4'),
      getAuthType: vi.fn(() => AuthType.USE_OPENAI),
      switchModel,
      getAllConfiguredModels: vi.fn(() => [
        {
          id: 'gpt-4',
          label: 'GPT-4',
          description: 'GPT-4 model',
          authType: AuthType.USE_OPENAI,
        },
      ]),
      getContentGeneratorConfig: vi.fn(() => ({
        authType: AuthType.USE_OPENAI,
        model: 'gpt-4',
      })),
    } as unknown as Partial<Config>);

    const selection = mockedSelect.mock.calls[0][0].onSelect(
      `${AuthType.USE_OPENAI}::gpt-4`,
    );
    const keyPressHandler = mockedUseKeypress.mock.calls[0][0];
    keyPressHandler({
      name: 'escape',
      ctrl: false,
      meta: false,
      shift: false,
      paste: false,
      sequence: '',
    });

    expect(mockHistoryManager.addItem).not.toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Kept model as'),
      }),
      expect.any(Number),
    );
    expect(props.onClose).not.toHaveBeenCalled();

    resolveSwitch?.();
    await selection;
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores a second selection while a model switch is in flight', async () => {
    let resolveSwitch: (() => void) | undefined;
    const switchModel = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSwitch = resolve;
        }),
    );
    const { props, mockHistoryManager, recordSlashCommand } = renderComponent(
      {},
      {
        getModel: vi.fn(() => 'gpt-4'),
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        switchModel,
        getAllConfiguredModels: vi.fn(() => [
          {
            id: 'gpt-4',
            label: 'GPT-4',
            description: 'GPT-4 model',
            authType: AuthType.USE_OPENAI,
          },
        ]),
        getContentGeneratorConfig: vi.fn(() => ({
          authType: AuthType.USE_OPENAI,
          model: 'gpt-4',
        })),
      } as unknown as Partial<Config>,
    );

    const onSelect = mockedSelect.mock.calls[0][0].onSelect;
    const firstSelection = onSelect(`${AuthType.USE_OPENAI}::gpt-4`);
    await onSelect(`${AuthType.USE_OPENAI}::gpt-4`);

    expect(switchModel).toHaveBeenCalledTimes(1);

    resolveSwitch?.();
    await firstSelection;

    expect(switchModel).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(mockHistoryManager.addItem).toHaveBeenCalledTimes(1);
    expect(recordSlashCommand).toHaveBeenCalledTimes(1);
  });

  it('does not retry or report an unchanged model after persistence fails', async () => {
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const setValue = vi.fn(() => {
      const error = new Error('settings are read-only');
      Object.assign(error, { code: 'EACCES' });
      throw error;
    });
    const { props, getByText, mockHistoryManager, recordSlashCommand } =
      renderComponent(
        {},
        {
          getModel: vi.fn(() => 'old-model'),
          getAuthType: vi.fn(() => AuthType.USE_OPENAI),
          switchModel,
          getAllConfiguredModels: vi.fn(() => [
            {
              id: 'gpt-4',
              label: 'GPT-4',
              description: 'GPT-4 model',
              authType: AuthType.USE_OPENAI,
            },
          ]),
          getContentGeneratorConfig: vi.fn(() => ({
            authType: AuthType.USE_OPENAI,
            model: 'gpt-4',
          })),
        } as unknown as Partial<Config>,
        { setValue },
      );

    const onSelect = mockedSelect.mock.calls[0][0].onSelect;
    await act(async () => {
      await onSelect(`${AuthType.USE_OPENAI}::gpt-4`);
    });

    expect(
      getByText((text) =>
        text.includes('Model switched, but the selection could not be saved.'),
      ),
    ).toBeDefined();

    await onSelect(`${AuthType.USE_OPENAI}::gpt-4`);
    mockedUseKeypress.mock.calls[0][0]({
      name: 'escape',
      ctrl: false,
      meta: false,
      shift: false,
      paste: false,
      sequence: '',
    });

    expect(switchModel).toHaveBeenCalledTimes(1);
    expect(setValue).toHaveBeenCalledTimes(1);
    expect(mockHistoryManager.addItem).not.toHaveBeenCalled();
    expect(recordSlashCommand).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('updates initialIndex when config context changes', () => {
    const mockGetModel = vi.fn(() => DEFAULT_QWEN_MODEL);
    const mockGetAuthType = vi.fn(() => 'qwen-oauth');
    const mockGetModelsConfig = vi.fn(() => ({
      getGenerationConfig: vi.fn(() => ({ baseUrl: undefined })),
    }));
    const mockGetActiveRuntimeModelSnapshot = vi.fn(() => undefined);
    const mockSettings = {
      isTrusted: true,
      user: { settings: {} },
      workspace: { settings: {} },
      setValue: vi.fn(),
    } as unknown as LoadedSettings;
    const { rerender } = render(
      <SettingsContext.Provider value={mockSettings}>
        <ConfigContext.Provider
          value={
            {
              getModel: mockGetModel,
              getAuthType: mockGetAuthType,
              getAvailableModelsForAuthType:
                createMockGetAvailableModelsForAuthType(),
              getAllConfiguredModels: vi.fn(() =>
                getFilteredQwenModels().map((m) => ({
                  id: m.id,
                  label: m.label,
                  description: m.description || '',
                  authType: AuthType.QWEN_OAUTH,
                })),
              ),
              getModelsConfig: mockGetModelsConfig,
              getActiveRuntimeModelSnapshot: mockGetActiveRuntimeModelSnapshot,
            } as unknown as Config
          }
        >
          <ModelDialog onClose={vi.fn()} />
        </ConfigContext.Provider>
      </SettingsContext.Provider>,
    );

    // DEFAULT_QWEN_MODEL (coder-model) is at index 0
    expect(mockedSelect.mock.calls[0][0].initialIndex).toBe(0);

    mockGetModel.mockReturnValue(DEFAULT_QWEN_MODEL);
    const newMockConfig = {
      getModel: mockGetModel,
      getAuthType: mockGetAuthType,
      getAvailableModelsForAuthType: createMockGetAvailableModelsForAuthType(),
      getAllConfiguredModels: vi.fn(() =>
        getFilteredQwenModels().map((m) => ({
          id: m.id,
          label: m.label,
          description: m.description || '',
          authType: AuthType.QWEN_OAUTH,
        })),
      ),
      getModelsConfig: mockGetModelsConfig,
      getActiveRuntimeModelSnapshot: mockGetActiveRuntimeModelSnapshot,
    } as unknown as Config;

    rerender(
      <SettingsContext.Provider value={mockSettings}>
        <ConfigContext.Provider value={newMockConfig}>
          <ModelDialog onClose={vi.fn()} />
        </ConfigContext.Provider>
      </SettingsContext.Provider>,
    );

    // Should be called at least twice: initial render + re-render after context change
    expect(mockedSelect).toHaveBeenCalledTimes(2);
    // Calculate expected index for DEFAULT_QWEN_MODEL dynamically
    const qwenModels = getFilteredQwenModels();
    const expectedCoderIndex = qwenModels.findIndex(
      (m) => m.id === DEFAULT_QWEN_MODEL,
    );
    expect(mockedSelect.mock.calls[1][0].initialIndex).toBe(expectedCoderIndex);
  });

  // --- Modality provenance badge + "Test image support" action (#10309) ---

  const pressT = async () => {
    // The dialog registers two useKeypress handlers per render: escape/left
    // first, then the gated 't' probe action. Handlers accumulate across
    // re-renders and remounts, so always fire the LATEST registered one —
    // its closure holds the current mount's props and state.
    const calls = mockedUseKeypress.mock.calls;
    await act(async () => {
      calls[calls.length - 1][0]({
        name: 't',
        ctrl: false,
        meta: false,
        shift: false,
        paste: false,
        sequence: 't',
      });
      // The probe handler is fire-and-forget async; flush its microtasks
      // inside act so the verdict state updates land in this batch.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  const patternSourceModel = {
    id: 'pattern-model',
    label: 'Pattern Model',
    description: '',
    authType: AuthType.USE_OPENAI,
    baseUrl: 'https://api.example.com/v1',
    envKey: 'MODEL_DIALOG_PROBE_TEST_KEY',
    modalitiesSource: 'pattern',
  };

  it('badges pattern-guessed modalities as auto-detected and offers the t action', () => {
    const { getByText } = renderComponent({}, {
      getModel: vi.fn(() => 'pattern-model'),
      getAuthType: vi.fn(() => AuthType.USE_OPENAI),
      getAllConfiguredModels: vi.fn(() => [patternSourceModel]),
      getModelsConfig: vi.fn(() => ({
        getGenerationConfig: vi.fn(() => ({
          baseUrl: 'https://api.example.com/v1',
        })),
      })),
    } as unknown as Partial<Config>);

    expect(getByText('text-only · auto-detected')).toBeDefined();
    expect(getByText('t: test image support')).toBeDefined();
  });

  it('badges probe-tested modalities without offering the t action again', () => {
    const { getByText, queryByText } = renderComponent({}, {
      getModel: vi.fn(() => 'vl-model'),
      getAuthType: vi.fn(() => AuthType.USE_OPENAI),
      getAllConfiguredModels: vi.fn(() => [
        {
          id: 'vl-model',
          label: 'VL Model',
          description: '',
          authType: AuthType.USE_OPENAI,
          modalities: { image: true },
          modalitiesSource: 'probe',
        },
      ]),
    } as unknown as Partial<Config>);

    expect(getByText('text · image · probe-tested')).toBeDefined();
    expect(queryByText('t: test image support')).toBeNull();
  });

  it('prefers a settings-persisted probe verdict over the registry pattern cache', () => {
    // The registry cached modalitiesSource at registration time and a plain
    // settings.setValue does not refresh it — but the dialog reads the live
    // settings store, so the persisted verdict must drive BOTH the badge and
    // the t-action gating even while the entry still says 'pattern'.
    const { getByText, queryByText } = renderComponent(
      {},
      {
        getModel: vi.fn(() => 'pattern-model'),
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        getAllConfiguredModels: vi.fn(() => [patternSourceModel]),
        getModelsConfig: vi.fn(() => ({
          getGenerationConfig: vi.fn(() => ({
            baseUrl: 'https://api.example.com/v1',
          })),
        })),
      } as unknown as Partial<Config>,
      {
        merged: {
          probeResults: {
            'openai|pattern-model|https://api.example.com/v1': {
              verdict: 'text_only',
              probedAt: '2026-01-01T00:00:00.000Z',
            },
          },
        },
      } as unknown as Partial<LoadedSettings>,
    );

    expect(getByText('text-only · probe-tested')).toBeDefined();
    expect(queryByText('t: test image support')).toBeNull();
  });

  it('shows a hand-written explicit declaration over a stale persisted probe record', () => {
    // A wrong verdict was persisted earlier; the phase-1 remediation is to
    // hand-write modelProviders modalities and reload the registry, which
    // stamps the entry 'explicit'. The live probe read must not shadow
    // that: badge shows manual with the hand-written value.
    const { getByText, queryByText } = renderComponent(
      {},
      {
        getModel: vi.fn(() => 'explicit-model'),
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        getAllConfiguredModels: vi.fn(() => [
          {
            id: 'explicit-model',
            label: 'Explicit Model',
            description: '',
            authType: AuthType.USE_OPENAI,
            baseUrl: 'https://api.example.com/v1',
            envKey: 'MODEL_DIALOG_PROBE_TEST_KEY',
            modalities: { image: true },
            modalitiesSource: 'explicit',
          },
        ]),
        getModelsConfig: vi.fn(() => ({
          getGenerationConfig: vi.fn(() => ({
            baseUrl: 'https://api.example.com/v1',
          })),
        })),
      } as unknown as Partial<Config>,
      {
        merged: {
          probeResults: {
            // Stale text_only verdict under the SAME key the dialog's live
            // read would use — it must not flip the hand-written value.
            'openai|explicit-model|https://api.example.com/v1': {
              verdict: 'text_only',
              probedAt: '2026-01-01T00:00:00.000Z',
            },
          },
        },
      } as unknown as Partial<LoadedSettings>,
    );

    expect(getByText('text · image · manual')).toBeDefined();
    expect(queryByText('text-only · probe-tested')).toBeNull();
    // Explicit entries never offer the t action, record or not.
    expect(queryByText('t: test image support')).toBeNull();
  });

  it('badges explicitly declared modalities as manual', () => {
    const { getByText } = renderComponent({}, {
      getModel: vi.fn(() => 'explicit-model'),
      getAuthType: vi.fn(() => AuthType.USE_OPENAI),
      getAllConfiguredModels: vi.fn(() => [
        {
          id: 'explicit-model',
          label: 'Explicit Model',
          description: '',
          authType: AuthType.USE_OPENAI,
          modalities: { image: true },
          modalitiesSource: 'explicit',
        },
      ]),
    } as unknown as Partial<Config>);

    expect(getByText('text · image · manual')).toBeDefined();
  });

  it('does not run the probe for non-pattern modality sources', async () => {
    const { mockSettings } = renderComponent({}, {
      getModel: vi.fn(() => 'explicit-model'),
      getAuthType: vi.fn(() => AuthType.USE_OPENAI),
      getAllConfiguredModels: vi.fn(() => [
        {
          id: 'explicit-model',
          label: 'Explicit Model',
          description: '',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://api.example.com/v1',
          envKey: 'MODEL_DIALOG_PROBE_TEST_KEY',
          modalities: { image: true },
          modalitiesSource: 'explicit',
        },
      ]),
      getModelsConfig: vi.fn(() => ({
        getGenerationConfig: vi.fn(() => ({
          baseUrl: 'https://api.example.com/v1',
        })),
      })),
    } as unknown as Partial<Config>);

    await pressT();

    expect(mockedProbeImageSupport).not.toHaveBeenCalled();
    expect(mockSettings.setValue).not.toHaveBeenCalled();
  });

  it('probes a pattern-source entry on t and persists the whole probeResults map', async () => {
    const previousKey = process.env['MODEL_DIALOG_PROBE_TEST_KEY'];
    process.env['MODEL_DIALOG_PROBE_TEST_KEY'] = 'sk-probe-test';
    try {
      mockedProbeImageSupport.mockResolvedValue({
        verdict: 'image',
        httpStatus: 200,
        snippet: 'ok',
      });
      const existingRecord = {
        verdict: 'text_only' as const,
        probedAt: '2026-01-01T00:00:00.000Z',
      };
      // Scope-targeted read: the write must start from the TARGET scope's
      // own map (preserving its records) — not from the merged view.
      const userSettingsFile = {
        settings: {
          probeResults: {
            'openai|older-model|https://older.example.com/v1': existingRecord,
          },
        },
      };

      const { getByText, mockSettings } = renderComponent(
        {},
        {
          getModel: vi.fn(() => 'pattern-model'),
          getAuthType: vi.fn(() => AuthType.USE_OPENAI),
          getAllConfiguredModels: vi.fn(() => [patternSourceModel]),
          getModelsConfig: vi.fn(() => ({
            getGenerationConfig: vi.fn(() => ({
              baseUrl: 'https://api.example.com/v1',
            })),
          })),
        } as unknown as Partial<Config>,
        {
          forScope: () => userSettingsFile,
        } as unknown as Partial<LoadedSettings>,
      );

      await pressT();

      expect(mockedProbeImageSupport).toHaveBeenCalledTimes(1);
      expect(mockedProbeImageSupport).toHaveBeenCalledWith({
        model: 'pattern-model',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-probe-test',
      });
      expect(mockSettings.setValue).toHaveBeenCalledTimes(1);
      expect(mockSettings.setValue).toHaveBeenCalledWith(
        SettingScope.User,
        'probeResults',
        {
          'openai|older-model|https://older.example.com/v1': existingRecord,
          'openai|pattern-model|https://api.example.com/v1': {
            verdict: 'image',
            probedAt: expect.any(String),
          },
        },
      );
      // Registry entries are not reloaded mid-dialog: BOTH the badge and the
      // modality value flip to the verdict-consistent presentation from
      // local dialog state.
      expect(getByText('text · image · probe-tested')).toBeDefined();
      expect(getByText('accepts images')).toBeDefined();
    } finally {
      if (previousKey === undefined) {
        delete process.env['MODEL_DIALOG_PROBE_TEST_KEY'];
      } else {
        process.env['MODEL_DIALOG_PROBE_TEST_KEY'] = previousKey;
      }
    }
  });

  it('hides the t action once a verdict concludes and keeps it after unknown', async () => {
    const previousKey = process.env['MODEL_DIALOG_PROBE_TEST_KEY'];
    process.env['MODEL_DIALOG_PROBE_TEST_KEY'] = 'sk-probe-test';
    const renderPatternDialog = () =>
      renderComponent(
        {},
        {
          getModel: vi.fn(() => 'pattern-model'),
          getAuthType: vi.fn(() => AuthType.USE_OPENAI),
          getAllConfiguredModels: vi.fn(() => [patternSourceModel]),
          getModelsConfig: vi.fn(() => ({
            getGenerationConfig: vi.fn(() => ({
              baseUrl: 'https://api.example.com/v1',
            })),
          })),
        } as unknown as Partial<Config>,
        {
          forScope: () => ({ settings: {} }),
        } as unknown as Partial<LoadedSettings>,
      );
    try {
      // Concluded verdict: the t action must disappear. Note the mocked
      // setValue does NOT refresh settings.merged, so the live-settings
      // lookup still misses — only the local verdict state gates the action
      // here, which is exactly the fallback under test.
      mockedProbeImageSupport.mockResolvedValue({
        verdict: 'image',
        httpStatus: 200,
        snippet: 'ok',
      });
      const first = renderPatternDialog();

      await pressT();

      expect(first.getByText('text · image · probe-tested')).toBeDefined();
      expect(first.queryByText('t: test image support')).toBeNull();
      first.unmount();

      // Unknown verdict: nothing was written and no conclusion exists, so
      // retry stays available (phase 1 has no other re-probe entry point).
      mockedProbeImageSupport.mockResolvedValue({
        verdict: 'unknown',
        httpStatus: 429,
        snippet: 'rate limited',
      });
      const second = renderPatternDialog();

      await pressT();

      expect(
        second.getByText(
          'inconclusive (auth/rate-limit/timeout) — nothing written',
        ),
      ).toBeDefined();
      expect(second.getByText('t: test image support')).toBeDefined();
      second.unmount();
    } finally {
      if (previousKey === undefined) {
        delete process.env['MODEL_DIALOG_PROBE_TEST_KEY'];
      } else {
        process.env['MODEL_DIALOG_PROBE_TEST_KEY'] = previousKey;
      }
    }
  });

  it('writes nothing when the probe verdict is unknown', async () => {
    const previousKey = process.env['MODEL_DIALOG_PROBE_TEST_KEY'];
    process.env['MODEL_DIALOG_PROBE_TEST_KEY'] = 'sk-probe-test';
    try {
      mockedProbeImageSupport.mockResolvedValue({
        verdict: 'unknown',
        httpStatus: 401,
        snippet: 'unauthorized',
      });

      const { getByText, mockSettings } = renderComponent({}, {
        getModel: vi.fn(() => 'pattern-model'),
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        getAllConfiguredModels: vi.fn(() => [patternSourceModel]),
        getModelsConfig: vi.fn(() => ({
          getGenerationConfig: vi.fn(() => ({
            baseUrl: 'https://api.example.com/v1',
          })),
        })),
      } as unknown as Partial<Config>);

      await pressT();

      expect(mockedProbeImageSupport).toHaveBeenCalledTimes(1);
      expect(mockSettings.setValue).not.toHaveBeenCalled();
      expect(
        getByText('inconclusive (auth/rate-limit/timeout) — nothing written'),
      ).toBeDefined();
    } finally {
      if (previousKey === undefined) {
        delete process.env['MODEL_DIALOG_PROBE_TEST_KEY'];
      } else {
        process.env['MODEL_DIALOG_PROBE_TEST_KEY'] = previousKey;
      }
    }
  });

  it('reports inconclusive without probing when the API key env is unset', async () => {
    const previousKey = process.env['MODEL_DIALOG_PROBE_TEST_KEY'];
    // No key in the environment: the handler must bail out BEFORE any
    // network attempt and write nothing.
    delete process.env['MODEL_DIALOG_PROBE_TEST_KEY'];
    try {
      const { getByText, mockSettings } = renderComponent({}, {
        getModel: vi.fn(() => 'pattern-model'),
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        getAllConfiguredModels: vi.fn(() => [patternSourceModel]),
        getModelsConfig: vi.fn(() => ({
          getGenerationConfig: vi.fn(() => ({
            baseUrl: 'https://api.example.com/v1',
          })),
        })),
      } as unknown as Partial<Config>);

      await pressT();

      expect(mockedProbeImageSupport).not.toHaveBeenCalled();
      expect(mockSettings.setValue).not.toHaveBeenCalled();
      expect(
        getByText('inconclusive (auth/rate-limit/timeout) — nothing written'),
      ).toBeDefined();
    } finally {
      if (previousKey === undefined) {
        delete process.env['MODEL_DIALOG_PROBE_TEST_KEY'];
      } else {
        process.env['MODEL_DIALOG_PROBE_TEST_KEY'] = previousKey;
      }
    }
  });

  it('hydrates a settings-backed API key before probing', async () => {
    const previousKey = process.env['MODEL_DIALOG_PROBE_TEST_KEY'];
    // The key exists only in settings.env — NOT in process.env — so the
    // probe only works if the handler hydrates the env first.
    delete process.env['MODEL_DIALOG_PROBE_TEST_KEY'];
    try {
      mockedProbeImageSupport.mockResolvedValue({
        verdict: 'text_only',
        httpStatus: 400,
        snippet: 'does not support images',
      });

      const { getByText, mockSettings } = renderComponent(
        {},
        {
          getModel: vi.fn(() => 'pattern-model'),
          getAuthType: vi.fn(() => AuthType.USE_OPENAI),
          getAllConfiguredModels: vi.fn(() => [patternSourceModel]),
          getModelsConfig: vi.fn(() => ({
            getGenerationConfig: vi.fn(() => ({
              baseUrl: 'https://api.example.com/v1',
            })),
          })),
        } as unknown as Partial<Config>,
        {
          merged: {
            env: { MODEL_DIALOG_PROBE_TEST_KEY: 'sk-from-settings-env' },
          },
          forScope: () => ({ settings: {} }),
        } as unknown as Partial<LoadedSettings>,
      );

      await pressT();

      expect(mockedProbeImageSupport).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: 'sk-from-settings-env' }),
      );
      expect(mockSettings.setValue).toHaveBeenCalledTimes(1);
      expect(getByText('text only')).toBeDefined();
    } finally {
      if (previousKey === undefined) {
        delete process.env['MODEL_DIALOG_PROBE_TEST_KEY'];
      } else {
        process.env['MODEL_DIALOG_PROBE_TEST_KEY'] = previousKey;
      }
    }
  });

  it('displaces the verdict display when the highlight moves to another entry', async () => {
    const previousKey = process.env['MODEL_DIALOG_PROBE_TEST_KEY'];
    process.env['MODEL_DIALOG_PROBE_TEST_KEY'] = 'sk-probe-test';
    try {
      mockedProbeImageSupport.mockResolvedValue({
        verdict: 'image',
        httpStatus: 200,
        snippet: 'ok',
      });

      const { getByText, queryByText } = renderComponent(
        {},
        {
          getModel: vi.fn(() => 'pattern-model'),
          getAuthType: vi.fn(() => AuthType.USE_OPENAI),
          getAllConfiguredModels: vi.fn(() => [
            patternSourceModel,
            {
              id: 'pattern-model-b',
              label: 'Pattern Model B',
              description: '',
              authType: AuthType.USE_OPENAI,
              modalitiesSource: 'pattern',
            },
          ]),
          getModelsConfig: vi.fn(() => ({
            getGenerationConfig: vi.fn(() => ({
              baseUrl: 'https://api.example.com/v1',
            })),
          })),
        } as unknown as Partial<Config>,
        {
          forScope: () => ({ settings: {} }),
        } as unknown as Partial<LoadedSettings>,
      );

      await pressT();
      // Entry A (highlighted) shows the verdict.
      expect(getByText('text · image · probe-tested')).toBeDefined();
      // Move the highlight to entry B: B shows its OWN pattern badge and
      // none of A's verdict display leaks onto it.
      const selectProps = mockedSelect.mock.calls[0][0];
      const entryB = selectProps.items[1].value;
      act(() => {
        selectProps.onHighlight?.(entryB);
      });
      expect(getByText('text-only · auto-detected')).toBeDefined();
      expect(queryByText('accepts images')).toBeNull();
      expect(queryByText('text · image · probe-tested')).toBeNull();

      // Moving back to A re-shows A's (uncorrupted) verdict display.
      act(() => {
        selectProps.onHighlight?.(selectProps.items[0].value);
      });
      expect(getByText('text · image · probe-tested')).toBeDefined();
      expect(getByText('accepts images')).toBeDefined();
    } finally {
      if (previousKey === undefined) {
        delete process.env['MODEL_DIALOG_PROBE_TEST_KEY'];
      } else {
        process.env['MODEL_DIALOG_PROBE_TEST_KEY'] = previousKey;
      }
    }
  });

  it('surfaces a settings-write failure instead of unhandled success', async () => {
    const previousKey = process.env['MODEL_DIALOG_PROBE_TEST_KEY'];
    process.env['MODEL_DIALOG_PROBE_TEST_KEY'] = 'sk-probe-test';
    const setValue = vi.fn(() => {
      const error = new Error('settings are read-only');
      Object.assign(error, { code: 'EACCES' });
      throw error;
    });
    try {
      mockedProbeImageSupport.mockResolvedValue({
        verdict: 'image',
        httpStatus: 200,
        snippet: 'ok',
      });

      const { getByText, queryByText } = renderComponent(
        {},
        {
          getModel: vi.fn(() => 'pattern-model'),
          getAuthType: vi.fn(() => AuthType.USE_OPENAI),
          getAllConfiguredModels: vi.fn(() => [patternSourceModel]),
          getModelsConfig: vi.fn(() => ({
            getGenerationConfig: vi.fn(() => ({
              baseUrl: 'https://api.example.com/v1',
            })),
          })),
        } as unknown as Partial<Config>,
        {
          setValue,
          forScope: () => ({ settings: {} }),
        } as unknown as Partial<LoadedSettings>,
      );

      await pressT();

      expect(setValue).toHaveBeenCalledTimes(1);
      // The failure surfaces through the dialog's error channel...
      expect(
        getByText((text) =>
          text.includes('Image probe verdict could not be saved.'),
        ),
      ).toBeDefined();
      // ...and no success feedback or verdict badge is shown (nothing was
      // persisted, so the entry's own pattern source stays on display and
      // the t action remains available for a retry).
      expect(queryByText('accepts images')).toBeNull();
      expect(queryByText('text · image · probe-tested')).toBeNull();
      expect(getByText('text-only · auto-detected')).toBeDefined();
      expect(getByText('t: test image support')).toBeDefined();
    } finally {
      if (previousKey === undefined) {
        delete process.env['MODEL_DIALOG_PROBE_TEST_KEY'];
      } else {
        process.env['MODEL_DIALOG_PROBE_TEST_KEY'] = previousKey;
      }
    }
  });
});

describe('encodeAuxModelSelector', () => {
  it('encodes the "authType::modelId" key, dropping the baseUrl', () => {
    expect(
      encodeAuxModelSelector('openai::gpt-4o\0https://api.example.com'),
    ).toBe('openai:gpt-4o');
    expect(encodeAuxModelSelector('openai::gpt-4o')).toBe('openai:gpt-4o');
  });

  it('encodes the "$runtime|authType|modelId" key by positional split', () => {
    expect(encodeAuxModelSelector('$runtime|openai|gpt-4o')).toBe(
      'openai:gpt-4o',
    );
  });

  it('passes a bare id (and a malformed runtime key) through unchanged', () => {
    expect(encodeAuxModelSelector('gpt-4o')).toBe('gpt-4o');
    expect(encodeAuxModelSelector('$runtime|openai')).toBe('$runtime|openai');
  });
});
