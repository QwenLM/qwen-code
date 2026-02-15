/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ModelDialog } from './ModelDialog.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { DescriptiveRadioButtonSelect } from './shared/DescriptiveRadioButtonSelect.js';
import { ConfigContext } from '../contexts/ConfigContext.js';
import { SettingsContext } from '../contexts/SettingsContext.js';
import type { Config } from '@qwen-code/qwen-code-core';
import { AuthType } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { SettingScope } from '../../config/settings.js';
import {
  getFilteredQwenModels,
  MAINLINE_CODER,
  MAINLINE_VLM,
} from '../models/availableModels.js';

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
      return getFilteredQwenModels(true).map((m) => ({
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
  } as unknown as LoadedSettings;

  const mockConfig = {
    // --- Functions used by ModelDialog ---
    getModel: vi.fn(() => MAINLINE_CODER),
    setModel: vi.fn().mockResolvedValue(undefined),
    switchModel: vi.fn().mockResolvedValue(undefined),
    getAuthType: vi.fn(() => 'qwen-oauth'),
    getAllConfiguredModels: vi.fn(() =>
      getFilteredQwenModels(true).map((m) => ({
        id: m.id,
        label: m.label,
        description: m.description || '',
        authType: AuthType.QWEN_OAUTH,
      })),
    ),

    // --- Functions used by ClearcutLogger ---
    getUsageStatisticsEnabled: vi.fn(() => true),
    getSessionId: vi.fn(() => 'mock-session-id'),
    getDebugMode: vi.fn(() => false),
    getContentGeneratorConfig: vi.fn(() => ({
      authType: AuthType.QWEN_OAUTH,
      model: MAINLINE_CODER,
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

  it('renders the title and help text', () => {
    const { getByText } = renderComponent();
    expect(getByText('Select Model')).toBeDefined();
    expect(getByText('(Press Esc to close)')).toBeDefined();
  });

  it('passes all model options to DescriptiveRadioButtonSelect', () => {
    renderComponent();
    expect(mockedSelect).toHaveBeenCalledTimes(1);

    const props = mockedSelect.mock.calls[0][0];
    expect(props.items).toHaveLength(getFilteredQwenModels(true).length);
    expect(props.items[0].value).toBe(
      `${AuthType.QWEN_OAUTH}::${MAINLINE_CODER}`,
    );
    // Find vision model in the list (it's not necessarily at index 1 anymore)
    const visionModelItem = props.items.find(
      (item) =>
        typeof item.value === 'string' &&
        item.value.endsWith(`::${MAINLINE_VLM}`),
    );
    expect(visionModelItem).toBeDefined();
    expect(props.showNumbers).toBe(true);
  });

  it('initializes with the model from ConfigContext', () => {
    const mockGetModel = vi.fn(() => MAINLINE_VLM);
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
    const qwenModels = getFilteredQwenModels(true);
    const expectedIndex = qwenModels.findIndex((m) => m.id === MAINLINE_VLM);
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

    // When getModel returns undefined, preferredModel falls back to MAINLINE_CODER
    // which has index 0, so initialIndex should be 0
    expect(mockedSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        initialIndex: 0,
      }),
      undefined,
    );
    expect(mockedSelect).toHaveBeenCalledTimes(1);
  });

  it('calls config.switchModel and onClose when DescriptiveRadioButtonSelect.onSelect is triggered', async () => {
    const { props, mockConfig, mockSettings } = renderComponent(
      {},
      {
        getAvailableModelsForAuthType: vi.fn((t: AuthType) => {
          if (t === AuthType.QWEN_OAUTH) {
            return getFilteredQwenModels(true).map((m) => ({
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

    await childOnSelect(`${AuthType.QWEN_OAUTH}::${MAINLINE_CODER}`);

    expect(mockConfig?.switchModel).toHaveBeenCalledWith(
      AuthType.QWEN_OAUTH,
      MAINLINE_CODER,
      undefined,
    );
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'model.name',
      MAINLINE_CODER,
    );
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'security.auth.selectedType',
      AuthType.QWEN_OAUTH,
    );
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('calls config.switchModel and persists authType+model when selecting a different authType', async () => {
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const getAuthType = vi.fn(() => AuthType.USE_OPENAI);
    const getAvailableModelsForAuthType = vi.fn((t: AuthType) => {
      if (t === AuthType.USE_OPENAI) {
        return [{ id: 'gpt-4', label: 'GPT-4', authType: t }];
      }
      if (t === AuthType.QWEN_OAUTH) {
        return getFilteredQwenModels(true).map((m) => ({
          id: m.id,
          label: m.label,
          authType: AuthType.QWEN_OAUTH,
        }));
      }
      return [];
    });

    const mockConfigWithSwitchAuthType = {
      getAuthType,
      getModel: vi.fn(() => 'gpt-4'),
      getContentGeneratorConfig: vi.fn(() => ({
        authType: AuthType.QWEN_OAUTH,
        model: MAINLINE_CODER,
      })),
      // Add switchModel to the mock object (not the type)
      switchModel,
      getAvailableModelsForAuthType,
    };

    const { props, mockSettings } = renderComponent(
      {},
      // Cast to Config to bypass type checking, matching the runtime behavior
      mockConfigWithSwitchAuthType as unknown as Partial<Config>,
    );

    const childOnSelect = mockedSelect.mock.calls[0][0].onSelect;
    await childOnSelect(`${AuthType.QWEN_OAUTH}::${MAINLINE_CODER}`);

    expect(switchModel).toHaveBeenCalledWith(
      AuthType.QWEN_OAUTH,
      MAINLINE_CODER,
      { requireCachedCredentials: true },
    );
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'model.name',
      MAINLINE_CODER,
    );
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'security.auth.selectedType',
      AuthType.QWEN_OAUTH,
    );
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('does not pass onHighlight to DescriptiveRadioButtonSelect', () => {
    renderComponent();

    const childOnHighlight = mockedSelect.mock.calls[0][0].onHighlight;
    expect(childOnHighlight).toBeUndefined();
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
    const mockGetModel = vi.fn(() => MAINLINE_CODER);
    const mockGetAuthType = vi.fn(() => 'qwen-oauth');
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
                getFilteredQwenModels(true).map((m) => ({
                  id: m.id,
                  label: m.label,
                  description: m.description || '',
                  authType: AuthType.QWEN_OAUTH,
                })),
              ),
            } as unknown as Config
          }
        >
          <ModelDialog onClose={vi.fn()} />
        </ConfigContext.Provider>
      </SettingsContext.Provider>,
    );

    // MAINLINE_CODER (qwen3-coder-next) is at index 0
    expect(mockedSelect.mock.calls[0][0].initialIndex).toBe(0);

    mockGetModel.mockReturnValue(MAINLINE_VLM);
    const newMockConfig = {
      getModel: mockGetModel,
      getAuthType: mockGetAuthType,
      getAvailableModelsForAuthType: createMockGetAvailableModelsForAuthType(),
      getAllConfiguredModels: vi.fn(() =>
        getFilteredQwenModels(true).map((m) => ({
          id: m.id,
          label: m.label,
          description: m.description || '',
          authType: AuthType.QWEN_OAUTH,
        })),
      ),
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
    // Calculate expected index for MAINLINE_VLM dynamically
    const qwenModels = getFilteredQwenModels(true);
    const expectedVlmIndex = qwenModels.findIndex((m) => m.id === MAINLINE_VLM);
    expect(mockedSelect.mock.calls[1][0].initialIndex).toBe(expectedVlmIndex);
  });
});
