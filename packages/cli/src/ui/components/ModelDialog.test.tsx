/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render, cleanup } from '@testing-library/react';
import process from 'node:process';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ModelDialog } from './ModelDialog.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { DescriptiveRadioButtonSelect } from './shared/DescriptiveRadioButtonSelect.js';
import { ConfigContext } from '../contexts/ConfigContext.js';
import { SettingsContext } from '../contexts/SettingsContext.js';
import type { Config } from '@qwen-code/qwen-code-core';
import { AuthType, DEFAULT_QWEN_MODEL } from '@qwen-code/qwen-code-core';
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

  const renderResult = render(
    <SettingsContext.Provider value={mockSettings}>
      <ConfigContext.Provider value={mockConfig}>
        <ModelDialog {...combinedProps} />
      </ConfigContext.Provider>
    </SettingsContext.Provider>,
  );

  return {
    ...renderResult,
    props: combinedProps,
    mockConfig,
    mockSettings,
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
    const { props, mockSettings } = renderComponent({ isFastModelMode: true }, {
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
    } as unknown as Partial<Config>);

    const childOnSelect = mockedSelect.mock.calls[0][0].onSelect;
    await childOnSelect(`${AuthType.USE_OPENAI}::deepseek-v4-flash`);

    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'fastModel',
      'openai:deepseek-v4-flash',
    );
    expect(setFastModel).toHaveBeenCalledWith('openai:deepseek-v4-flash');
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('stores the plain model id in voice model mode without switching models', async () => {
    const switchModel = vi.fn();
    const setFastModel = vi.fn();
    const { props, mockSettings } = renderComponent(
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

  it('passes onHighlight to DescriptiveRadioButtonSelect', () => {
    renderComponent();

    const childOnHighlight = mockedSelect.mock.calls[0][0].onHighlight;
    expect(childOnHighlight).toBeDefined();
    expect(typeof childOnHighlight).toBe('function');
  });

  it('calls onClose prop when "escape" key is pressed', () => {
    const { props } = renderComponent();

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
    expect(props.onClose).toHaveBeenCalledTimes(1);

    keyPressHandler({
      name: 'a',
      ctrl: false,
      meta: false,
      shift: false,
      paste: false,
      sequence: '',
    });
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
});
