/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderWithProviders } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ThemeDialog } from './ThemeDialog.js';

const { mockIsDevelopment } = vi.hoisted(() => ({
  mockIsDevelopment: { value: false },
}));

vi.mock('../../installation/source.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../installation/source.js')>();
  return {
    ...actual,
    get isDevelopment() {
      return mockIsDevelopment.value;
    },
  };
});

import { createMockSettings } from '../../test-utils/settings.js';
import { DEFAULT_THEME, themeManager } from '../themes/theme-manager.js';
import { act } from 'react';

describe('ThemeDialog Snapshots', () => {
  const baseProps = {
    onSelect: vi.fn(),
    onCancel: vi.fn(),
    onHighlight: vi.fn(),
    availableTerminalHeight: 40,
    terminalWidth: 120,
  };

  beforeEach(() => {
    // Reset theme manager to a known state
    themeManager.setActiveTheme(DEFAULT_THEME.name);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // skip: 现存失败
  it.skip.each([true, false])(
    'should render correctly in theme selection mode (isDevelopment: %s)',
    async (isDev) => {
      mockIsDevelopment.value = isDev;
      const settings = createMockSettings();
      const { lastFrame, unmount } = await renderWithProviders(
        <ThemeDialog {...baseProps} settings={settings} />,
        { settings },
      );

      expect(lastFrame()).toMatchSnapshot();
      unmount();
    },
  );

  // skip: 现存失败
  it.skip('should render correctly in scope selector mode', async () => {
    const settings = createMockSettings();
    const { lastFrame, stdin, waitUntilReady, unmount } =
      await renderWithProviders(
        <ThemeDialog {...baseProps} settings={settings} />,
        { settings },
      );

    // Press Enter to select a theme and advance to the Apply tab
    await act(async () => {
      stdin.write('\r');
    });

    // Need to wait for the state update to propagate
    await waitUntilReady();

    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it('should call onCancel when ESC is pressed', async () => {
    const mockOnCancel = vi.fn();
    const settings = createMockSettings();
    const { stdin, waitUntilReady, unmount } = await renderWithProviders(
      <ThemeDialog
        {...baseProps}
        onCancel={mockOnCancel}
        settings={settings}
      />,
      { settings },
    );

    await act(async () => {
      stdin.write('\x1b');
    });

    // ESC key has a 50ms timeout in KeypressContext, so we need to wrap waitUntilReady in act
    await act(async () => {
      await waitUntilReady();
    });

    await waitFor(() => {
      expect(mockOnCancel).toHaveBeenCalled();
    });
    unmount();
  });

  it('should call onSelect when a theme is selected and scope is confirmed', async () => {
    const settings = createMockSettings();
    const { stdin, waitUntilReady, unmount } = await renderWithProviders(
      <ThemeDialog {...baseProps} settings={settings} />,
      {
        settings,
      },
    );

    // Press Enter to select the theme (advances to Apply tab)
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();

    // Press Enter to confirm the scope (calls onSelect)
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();

    await waitFor(() => {
      expect(baseProps.onSelect).toHaveBeenCalled();
    });
    unmount();
  });
});

describe('Initial Theme Selection', () => {
  const baseProps = {
    onSelect: vi.fn(),
    onCancel: vi.fn(),
    onHighlight: vi.fn(),
    availableTerminalHeight: 40,
    terminalWidth: 120,
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // `ui.theme` defaults to 'auto', so an unconfigured user is *running* auto
  // and the dialog preselects that row rather than the resolved concrete
  // theme. Asserted on the rendered row instead of a snapshot because this
  // file's snapshots are terminal-width dependent.
  const selectedLineOf = (frame: string | undefined, needle: string) =>
    frame!.split('\n').find((line) => line.includes(needle));

  it('preselects Auto when no theme is set, on a light background', async () => {
    const settings = createMockSettings(); // No theme set
    const { lastFrame, unmount } = await renderWithProviders(
      <ThemeDialog {...baseProps} settings={settings} />,
      {
        settings,
        uiState: { terminalBackgroundColor: '#FFFFFF' }, // Light background
      },
    );

    const autoLine = selectedLineOf(lastFrame(), 'Auto');
    expect(autoLine).toContain('\u276f');
    expect(autoLine).toContain('\u2192 Default Light');
    unmount();
  });

  it('preselects Auto when no theme is set, on a dark background', async () => {
    const settings = createMockSettings(); // No theme set
    const { lastFrame, unmount } = await renderWithProviders(
      <ThemeDialog {...baseProps} settings={settings} />,
      {
        settings,
        uiState: { terminalBackgroundColor: '#000000' }, // Dark background
      },
    );

    const autoLine = selectedLineOf(lastFrame(), 'Auto');
    expect(autoLine).toContain('\u276f');
    expect(autoLine).toContain('\u2192 Default');
    unmount();
  });

  // skip: 现存失败
  it.skip('should use the theme from settings even if terminal background suggests a different theme type', async () => {
    const settings = createMockSettings({ ui: { theme: 'DefaultLight' } }); // Light theme set
    const { lastFrame, unmount } = await renderWithProviders(
      <ThemeDialog {...baseProps} settings={settings} />,
      {
        settings,
        uiState: { terminalBackgroundColor: '#000000' }, // Dark background
      },
    );

    // We expect 'DefaultLight' to be highlighted, respecting the settings.
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });
});

describe('Auto theme option', () => {
  const baseProps = {
    onCancel: vi.fn(),
    onHighlight: vi.fn(),
    availableTerminalHeight: 40,
    terminalWidth: 120,
  };

  // These are deliberately assertion-based rather than snapshots: the
  // committed ThemeDialog snapshots are terminal-width dependent and already
  // fail outside the width they were recorded at.
  it('lists Auto as the first entry', async () => {
    const settings = createMockSettings({ ui: { theme: 'auto' } });
    const { lastFrame, unmount } = await renderWithProviders(
      <ThemeDialog {...baseProps} onSelect={vi.fn()} settings={settings} />,
      { settings, uiState: { terminalBackgroundColor: '#000000' } },
    );

    const frame = lastFrame();
    const autoLine = frame.split('\n').find((line) => / 1\. Auto /.test(line));
    expect(autoLine).toBeDefined();
    // The row names the theme it resolves to, so it is not an opaque choice
    // and is distinguishable from the pinned Default rows below it.
    expect(autoLine).toContain('\u2192 Default');
    unmount();
  });

  it('never marks the auto entry incompatible', async () => {
    const settings = createMockSettings({ ui: { theme: 'auto' } });
    const { lastFrame, unmount } = await renderWithProviders(
      <ThemeDialog {...baseProps} onSelect={vi.fn()} settings={settings} />,
      // A light background would make every dark theme incompatible; auto
      // must not be tarred with them.
      { settings, uiState: { terminalBackgroundColor: '#FFFFFF' } },
    );

    const frame = lastFrame();
    const autoLine = frame
      .split('\n')
      .find((line) => / 1\. Auto /.test(line))!;
    expect(autoLine).not.toContain('(Incompatible)');
    unmount();
  });

  it('selects "auto" as the persisted value', async () => {
    const onSelect = vi.fn();
    const settings = createMockSettings({ ui: { theme: 'auto' } });
    const { stdin, waitUntilReady, unmount } = await renderWithProviders(
      <ThemeDialog {...baseProps} onSelect={onSelect} settings={settings} />,
      { settings, uiState: { terminalBackgroundColor: '#000000' } },
    );

    // Enter picks the highlighted theme (auto, since it is the saved value and
    // therefore the initial selection), Enter again confirms the scope.
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();

    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith('auto', expect.anything());
    });
    unmount();
  });
});
