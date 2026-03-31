/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, it, expect, vi } from 'vitest';
import { Footer } from './Footer.js';
import * as useTerminalSize from '../hooks/useTerminalSize.js';
import { type UIState, UIStateContext } from '../contexts/UIStateContext.js';
import { ConfigContext } from '../contexts/ConfigContext.js';
import { VimModeProvider } from '../contexts/VimModeContext.js';
import { VerboseModeProvider } from '../contexts/VerboseModeContext.js';
import type { LoadedSettings } from '../../config/settings.js';

vi.mock('../hooks/useTerminalSize.js');
const useTerminalSizeMock = vi.mocked(useTerminalSize.useTerminalSize);

const defaultProps = {
  model: 'gemini-pro',
};

const createMockConfig = (overrides = {}) => ({
  getModel: vi.fn(() => defaultProps.model),
  getDebugMode: vi.fn(() => false),
  getContentGeneratorConfig: vi.fn(() => ({ contextWindowSize: 131072 })),
  getMcpServers: vi.fn(() => ({})),
  getBlockedMcpServers: vi.fn(() => []),
  ...overrides,
});

const createMockUIState = (overrides: Partial<UIState> = {}): UIState =>
  ({
    sessionStats: {
      lastPromptTokenCount: 100,
    },
    geminiMdFileCount: 0,
    contextFileNames: [],
    showToolDescriptions: false,
    ideContextState: undefined,
    ...overrides,
  }) as UIState;

const createMockSettings = (): LoadedSettings =>
  ({
    merged: {
      general: {
        vimMode: false,
      },
    },
  }) as LoadedSettings;

const renderWithWidth = (width: number, uiState: UIState) => {
  useTerminalSizeMock.mockReturnValue({ columns: width, rows: 24 });
  return render(
    <ConfigContext.Provider value={createMockConfig() as never}>
      <VimModeProvider settings={createMockSettings()}>
        <UIStateContext.Provider value={uiState}>
          <Footer />
        </UIStateContext.Provider>
      </VimModeProvider>
    </ConfigContext.Provider>,
  );
};

describe('<Footer />', () => {
  it('renders the component', () => {
    const { lastFrame } = renderWithWidth(120, createMockUIState());
    expect(lastFrame()).toBeDefined();
  });

  it('does not display the working directory or branch name', () => {
    const { lastFrame } = renderWithWidth(120, createMockUIState());
    expect(lastFrame()).not.toMatch(/\(.*\*\)/);
  });

  it('displays the context percentage', () => {
    const { lastFrame } = renderWithWidth(120, createMockUIState());
    expect(lastFrame()).toMatch(/\d+(\.\d+)?% context used/);
  });

  it('displays the abbreviated context percentage on narrow terminal', () => {
    const { lastFrame } = renderWithWidth(99, createMockUIState());
    expect(lastFrame()).toMatch(/\d+%/);
  });

  describe('footer rendering (golden snapshots)', () => {
    it('renders complete footer on wide terminal', () => {
      const { lastFrame } = renderWithWidth(120, createMockUIState());
      expect(lastFrame()).toMatchSnapshot('complete-footer-wide');
    });

    it('renders complete footer on narrow terminal', () => {
      const { lastFrame } = renderWithWidth(79, createMockUIState());
      expect(lastFrame()).toMatchSnapshot('complete-footer-narrow');
    });
  });

  describe('verbose mode indicator', () => {
    it('shows verbose label when verboseMode=true', () => {
      useTerminalSizeMock.mockReturnValue({ columns: 120, rows: 24 });
      const { lastFrame } = render(
        <VerboseModeProvider
          value={{ verboseMode: true, frozenSnapshot: null }}
        >
          <ConfigContext.Provider value={createMockConfig() as never}>
            <VimModeProvider settings={createMockSettings()}>
              <UIStateContext.Provider value={createMockUIState()}>
                <Footer />
              </UIStateContext.Provider>
            </VimModeProvider>
          </ConfigContext.Provider>
        </VerboseModeProvider>,
      );
      expect(lastFrame()).toContain('verbose');
    });

    it('hides verbose label when verboseMode=false', () => {
      useTerminalSizeMock.mockReturnValue({ columns: 120, rows: 24 });
      const { lastFrame } = render(
        <VerboseModeProvider
          value={{ verboseMode: false, frozenSnapshot: null }}
        >
          <ConfigContext.Provider value={createMockConfig() as never}>
            <VimModeProvider settings={createMockSettings()}>
              <UIStateContext.Provider value={createMockUIState()}>
                <Footer />
              </UIStateContext.Provider>
            </VimModeProvider>
          </ConfigContext.Provider>
        </VerboseModeProvider>,
      );
      expect(lastFrame()).not.toContain('verbose');
    });
  });
});
