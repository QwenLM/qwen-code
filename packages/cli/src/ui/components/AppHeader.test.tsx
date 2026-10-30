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

const createSettings = (options?: {
  hideTips?: boolean;
  hideBanner?: boolean;
  customBannerTitle?: string;
  customBannerSubtitle?: string;
  customAsciiArt?: unknown;
}): LoadedSettings => {
  const ui = {
    hideTips: options?.hideTips ?? true,
    hideBanner: options?.hideBanner,
    customBannerTitle: options?.customBannerTitle,
    customBannerSubtitle: options?.customBannerSubtitle,
    customAsciiArt: options?.customAsciiArt,
  };
  return {
    merged: { ui },
    system: { settings: {}, originalSettings: {}, path: '' },
    systemDefaults: { settings: {}, originalSettings: {}, path: '' },
    user: {
      settings: { ui },
      originalSettings: { ui },
      path: '/home/u/.qwen/settings.json',
    },
    workspace: { settings: {}, originalSettings: {}, path: '' },
  } as never;
};

const createMockConfig = (overrides = {}) => ({
  getContentGeneratorConfig: vi.fn(() => ({ authType: undefined })),
  getSubscriptionPlan: () => undefined,
  getModel: vi.fn(() => 'gemini-pro'),
  getModelDisplayName: vi.fn(() => 'Gemini Pro'),
  getModelsConfig: () => ({ getModelDisplayName: () => 'Gemini Pro' }),
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
  it('keeps the selected executor model while an advisor runtime is active', () => {
    const getModelDisplayName = vi.fn((model: string) => model);
    const { lastFrame } = renderWithProviders(
      createMockUIState({ currentModel: 'executor-model' }),
      createSettings(),
      createMockConfig({
        getModelDisplayName: () => 'advisor-model',
        getModelsConfig: () => ({ getModelDisplayName }),
      }),
    );
    expect(lastFrame()).toContain('executor-model');
    expect(lastFrame()).not.toContain('advisor-model');
    expect(getModelDisplayName).toHaveBeenCalledWith('executor-model');
  });

  it.each(['plus', 'pro'] as const)(
    'uses the real %s plan in the subscription header',
    (plan) => {
      const ui = renderWithProviders(
        createMockUIState({ currentModel: 'qwen3.8-max' }),
        createSettings(),
        createMockConfig({
          getContentGeneratorConfig: () => ({ authType: 'qwen-subscription' }),
          getSubscriptionPlan: () => plan,
          getModelsConfig: () => ({
            getModelDisplayName: (model: string) => model,
          }),
        }),
      );
      expect(ui.lastFrame()).toContain(
        `Qwen ${plan === 'pro' ? 'Pro' : 'Plus'} | [Qwen Subscription] qwen3.8-max`,
      );
      ui.unmount();
    },
  );

  it('hides a stale plan when the active authentication is no longer subscription', () => {
    const ui = renderWithProviders(
      createMockUIState(),
      createSettings(),
      createMockConfig({
        getContentGeneratorConfig: () => ({ authType: undefined }),
        getSubscriptionPlan: () => 'pro',
      }),
    );
    expect(ui.lastFrame()).not.toContain('Qwen Pro');
    expect(ui.lastFrame()).not.toContain('[Qwen Subscription]');
    ui.unmount();
  });

  it('shows the fixed subscription usage tip instead of a random startup tip', () => {
    const ui = renderWithProviders(
      createMockUIState(),
      createSettings({ hideTips: false }),
      createMockConfig({
        getContentGeneratorConfig: () => ({ authType: 'qwen-subscription' }),
      }),
    );
    expect(ui.lastFrame()).toContain('Tip: Run /usage to see your plan usage.');
    expect(ui.lastFrame()).not.toContain('Tips:');
    ui.unmount();
  });

  it.each([
    { hideTips: true, screenReader: false },
    { hideTips: false, screenReader: true },
  ])(
    'hides the subscription usage tip when requested (%j)',
    ({ hideTips, screenReader }) => {
      const ui = renderWithProviders(
        createMockUIState(),
        createSettings({ hideTips }),
        createMockConfig({
          getContentGeneratorConfig: () => ({ authType: 'qwen-subscription' }),
          getScreenReader: () => screenReader,
        }),
      );
      expect(ui.lastFrame()).not.toContain(
        'Tip: Run /usage to see your plan usage.',
      );
      ui.unmount();
    },
  );

  it('retains the normal startup tip for other providers', () => {
    const ui = renderWithProviders(
      createMockUIState(),
      createSettings({ hideTips: false }),
    );
    expect(ui.lastFrame()).toContain('Tips:');
    expect(ui.lastFrame()).not.toContain(
      'Tip: Run /usage to see your plan usage.',
    );
    ui.unmount();
  });

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
    expect(lastFrame()).toContain('Gemini Pro');
    expect(lastFrame()).toContain('/projects/qwen-code');
  });

  it('hides the banner when ui.hideBanner is set, but keeps tips intact', () => {
    const { lastFrame } = renderWithProviders(
      createMockUIState(),
      createSettings({ hideTips: false, hideBanner: true }),
    );
    expect(lastFrame()).not.toContain('>_ Qwen Code');
    expect(lastFrame()).not.toContain('██╔═══██╗');
  });

  it('renders the custom subtitle end-to-end through resolveCustomBanner (replaces the blank spacer between title and auth line)', () => {
    const { lastFrame } = renderWithProviders(
      createMockUIState(),
      createSettings({
        customBannerTitle: 'DataWorks DataAgent',
        customBannerSubtitle: 'Built-in DataWorks Official Skills',
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('DataWorks DataAgent');
    expect(frame).toContain('Built-in DataWorks Official Skills');
    const titleIdx = frame.indexOf('DataWorks DataAgent');
    const subtitleIdx = frame.indexOf('Built-in DataWorks Official Skills');
    expect(titleIdx).toBeLessThan(subtitleIdx);
  });

  it('renders custom banner title and inline ASCII art end-to-end through resolveCustomBanner', () => {
    const { lastFrame } = renderWithProviders(
      createMockUIState(),
      createSettings({
        customBannerTitle: 'Acme CLI',
        customAsciiArt: '   ACME\n   ----',
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Acme CLI');
    expect(frame).not.toContain('>_ Qwen Code');
    expect(frame).toContain('ACME');
    // Default Qwen logo must NOT bleed through when the user supplied art.
    expect(frame).not.toContain('██╔═══██╗');
  });
});
