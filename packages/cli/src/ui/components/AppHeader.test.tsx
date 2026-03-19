/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { AppHeader } from './AppHeader.js';
import { ConfigContext } from '../contexts/ConfigContext.js';
import { SettingsContext } from '../contexts/SettingsContext.js';
import { type UIState, UIStateContext } from '../contexts/UIStateContext.js';
import { VimModeProvider } from '../contexts/VimModeContext.js';
import * as useTerminalSize from '../hooks/useTerminalSize.js';
import type { LoadedSettings } from '../../config/settings.js';

vi.mock('../hooks/useTerminalSize.js');
const useTerminalSizeMock = vi.mocked(useTerminalSize.useTerminalSize);

const createSettings = (options?: { hideTips?: boolean }): LoadedSettings =>
  ({
    merged: {
      ui: {
        hideTips: options?.hideTips ?? true,
      },
    },
  }) as never;

const createMockConfig = (overrides = {}) => ({
  getContentGeneratorConfig: vi.fn(() => ({ authType: undefined })),
  getModel: vi.fn(() => 'gemini-pro'),
  getTargetDir: vi.fn(() => '/projects/qwen-code'),
  getMcpServers: vi.fn(() => ({})),
  getBlockedMcpServers: vi.fn(() => []),
  getDebugMode: vi.fn(() => false),
  getScreenReader: vi.fn(() => false),
  ...overrides,
});

const createMockUIState = (overrides: Partial<UIState> = {}): UIState =>
  ({
    branchName: 'main',
    nightly: false,
    debugMessage: '',
    currentModel: 'gemini-pro',
    sessionStats: {
      lastPromptTokenCount: 0,
    },
    ...overrides,
  }) as UIState;

const renderWithProviders = (
  uiState: UIState,
  settings = createSettings(),
  config = createMockConfig(),
) => {
  useTerminalSizeMock.mockReturnValue({ columns: 120, rows: 24 });
  return render(
    <ConfigContext.Provider value={config as never}>
      <SettingsContext.Provider value={settings}>
        <VimModeProvider settings={settings}>
          <UIStateContext.Provider value={uiState}>
            <AppHeader version="1.2.3" />
          </UIStateContext.Provider>
        </VimModeProvider>
      </SettingsContext.Provider>
    </ConfigContext.Provider>,
  );
};

describe('<AppHeader />', () => {
  it('shows the working directory', () => {
    const { lastFrame } = renderWithProviders(createMockUIState());
    expect(lastFrame()).toContain('/projects/qwen-code');
  });

  it('hides the header when screen reader is enabled', () => {
    const { lastFrame } = renderWithProviders(
      createMockUIState(),
      createSettings(),
      createMockConfig({ getScreenReader: vi.fn(() => true) }),
    );
    // When screen reader is enabled, header is not rendered
    expect(lastFrame()).not.toContain('/projects/qwen-code');
    expect(lastFrame()).not.toContain('Qwen Code');
  });

  it('shows the header with all info when banner is visible', () => {
    const { lastFrame } = renderWithProviders(createMockUIState());
    expect(lastFrame()).toContain('>_ Qwen Code');
    expect(lastFrame()).toContain('gemini-pro');
    expect(lastFrame()).toContain('/projects/qwen-code');
  });
});
