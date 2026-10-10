/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text, useIsScreenReaderEnabled } from 'ink';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { App } from './App.js';
import { SettingsCorruptedDialog } from './components/SettingsCorruptedDialog.js';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import { UIStateContext, type UIState } from './contexts/UIStateContext.js';
import {
  UIActionsContext,
  type UIActions,
} from './contexts/UIActionsContext.js';
import { AgentViewProvider } from './contexts/AgentViewContext.js';
import { SettingsContext } from './contexts/SettingsContext.js';
import type { LoadedSettings } from '../config/settings.js';
import { StreamingState } from './types.js';

vi.mock('ink', async (importOriginal) => {
  const original = await importOriginal<typeof import('ink')>();
  return {
    ...original,
    useIsScreenReaderEnabled: vi.fn(),
  };
});

vi.mock('./components/MainContent.js', () => ({
  MainContent: () => <Text>MainContent</Text>,
}));

vi.mock('./components/DialogManager.js', () => ({
  DialogManager: () => <Text>DialogManager</Text>,
}));

vi.mock('./components/Composer.js', () => ({
  Composer: () => <Text>Composer</Text>,
}));

vi.mock('./components/Notifications.js', () => ({
  Notifications: () => <Text>Notifications</Text>,
}));

vi.mock('./components/QuittingDisplay.js', () => ({
  QuittingDisplay: () => <Text>Quitting...</Text>,
}));

vi.mock('./components/SettingsCorruptedDialog.js', () => ({
  SettingsCorruptedDialog: vi.fn(() => <Text>Settings corrupted</Text>),
}));

vi.mock('../utils/stdioHelpers.js', () => ({
  writeStderrLine: vi.fn(),
}));

vi.mock('./components/Footer.js', () => ({
  Footer: () => <Text>Footer</Text>,
}));

vi.mock('./components/agent-view/AgentTabBar.js', () => ({
  AgentTabBar: () => null,
}));

describe('App', () => {
  const mockUIState: Partial<UIState> = {
    streamingState: StreamingState.Idle,
    quittingMessages: null,
    dialogsVisible: false,
    stickyTodos: null,
    mainControlsRef: { current: null },
    historyManager: {
      addItem: vi.fn(),
      history: [],
      updateItem: vi.fn(),
      clearItems: vi.fn(),
      loadHistory: vi.fn(),
      truncateToItem: vi.fn(),
    },
  };

  const mockSettings = {
    merged: {},
    corruptedPath: undefined,
    wasRecovered: false,
  } as LoadedSettings;

  const mockUIActions = {
    refreshStatic: vi.fn(),
  } as unknown as UIActions;

  const renderWithProviders = (
    uiState: UIState,
    settings: LoadedSettings = mockSettings,
  ) =>
    render(
      <UIActionsContext.Provider value={mockUIActions}>
        <AgentViewProvider>
          <UIStateContext.Provider value={uiState}>
            <SettingsContext.Provider value={settings}>
              <App />
            </SettingsContext.Provider>
          </UIStateContext.Provider>
        </AgentViewProvider>
      </UIActionsContext.Provider>,
    );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0).each([
    {
      name: 'identical 0400 original',
      mode: 0o400,
      original: '{broken',
      failed: false,
    },
    {
      name: 'identical 0444 original',
      mode: 0o444,
      original: '{broken',
      failed: false,
    },
    {
      name: 'different read-only original',
      mode: 0o444,
      original: '{changed',
      failed: true,
    },
    {
      name: 'unreadable original',
      mode: 0o000,
      original: '{broken',
      failed: true,
    },
    {
      name: 'different writable original',
      mode: 0o600,
      original: '{changed',
      failed: false,
    },
  ])('handles Exit/restore for $name', ({ mode, original, failed }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-recovery-'));
    const settingsPath = path.join(root, 'settings.json');
    const corruptedPath = `${settingsPath}.corrupted`;
    fs.writeFileSync(settingsPath, original, { mode });
    fs.writeFileSync(corruptedPath, '{broken', { mode: 0o444 });
    const originalInode = fs.statSync(settingsPath).ino;
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    vi.mocked(writeStderrLine).mockClear();
    vi.mocked(SettingsCorruptedDialog).mockClear();
    const { unmount } = renderWithProviders(
      mockUIState as UIState,
      {
        ...mockSettings,
        corruptedPath,
      } as LoadedSettings,
    );

    try {
      vi.mocked(SettingsCorruptedDialog).mock.calls[0][0].onExit();

      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(fs.statSync(settingsPath).mode & 0o777).toBe(
        mode === 0o600 ? 0o444 : mode,
      );
      expect(fs.statSync(settingsPath).ino).toBe(originalInode);
      if (failed) {
        expect(writeStderrLine).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining('Failed to restore corrupted file: EACCES'),
        );
        expect(fs.readFileSync(corruptedPath, 'utf8')).toBe('{broken');
        expect(fs.statSync(corruptedPath).mode & 0o777).toBe(0o444);
      } else {
        expect(writeStderrLine).not.toHaveBeenCalled();
        expect(fs.existsSync(corruptedPath)).toBe(false);
      }
      if (mode === 0) fs.chmodSync(settingsPath, 0o600);
      expect(fs.readFileSync(settingsPath, 'utf8')).toBe(
        failed ? original : '{broken',
      );
    } finally {
      unmount();
      exit.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('should render main content and composer when not quitting', () => {
    const { lastFrame } = renderWithProviders(mockUIState as UIState);

    expect(lastFrame()).toContain('MainContent');
    expect(lastFrame()).toContain('Composer');
  });

  it('should render quitting display when quittingMessages is set', () => {
    const quittingUIState = {
      ...mockUIState,
      quittingMessages: [{ id: 1, type: 'user', text: 'test' }],
    } as UIState;

    const { lastFrame } = renderWithProviders(quittingUIState);

    expect(lastFrame()).toContain('Quitting...');
  });

  it('should render dialog manager when dialogs are visible', () => {
    const dialogUIState = {
      ...mockUIState,
      dialogsVisible: true,
    } as UIState;

    const { lastFrame } = renderWithProviders(dialogUIState);

    expect(lastFrame()).toContain('MainContent');
    expect(lastFrame()).toContain('DialogManager');
  });

  it('should show Ctrl+C exit prompt when dialogs are visible and ctrlCPressedOnce is true', () => {
    const ctrlCUIState = {
      ...mockUIState,
      dialogsVisible: true,
      ctrlCPressedOnce: true,
    } as UIState;

    const { lastFrame } = renderWithProviders(ctrlCUIState);

    expect(lastFrame()).toContain('Press Ctrl+C again to exit.');
  });

  it('should show Ctrl+D exit prompt when dialogs are visible and ctrlDPressedOnce is true', () => {
    const ctrlDUIState = {
      ...mockUIState,
      dialogsVisible: true,
      ctrlDPressedOnce: true,
    } as UIState;

    const { lastFrame } = renderWithProviders(ctrlDUIState);

    expect(lastFrame()).toContain('Press Ctrl+D again to exit.');
  });

  it('should render ScreenReaderAppLayout when screen reader is enabled', () => {
    (useIsScreenReaderEnabled as vi.Mock).mockReturnValue(true);

    const { lastFrame } = renderWithProviders(mockUIState as UIState);

    expect(lastFrame()).toContain(
      'Notifications\nFooter\nMainContent\nComposer',
    );
  });

  it('should render DefaultAppLayout when screen reader is not enabled', () => {
    (useIsScreenReaderEnabled as vi.Mock).mockReturnValue(false);

    const { lastFrame } = renderWithProviders(mockUIState as UIState);

    expect(lastFrame()).toContain('MainContent\nComposer');
  });
});
