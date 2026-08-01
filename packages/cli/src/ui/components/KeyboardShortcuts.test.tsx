/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { KeyboardShortcuts } from './KeyboardShortcuts.js';
import { SettingsContext } from '../contexts/SettingsContext.js';
import type { LoadedSettings } from '../../config/settings.js';
import * as useTerminalSize from '../hooks/useTerminalSize.js';

vi.mock('../hooks/useTerminalSize.js');
const useTerminalSizeMock = vi.mocked(useTerminalSize.useTerminalSize);

const originalPlatform = process.platform;

function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

function createSettings(toggleModel?: string): LoadedSettings {
  return {
    merged: {
      model: {
        name: 'default-model',
        ...(toggleModel ? { toggleModel } : {}),
      },
    },
  } as unknown as LoadedSettings;
}

function renderShortcuts(toggleModel?: string) {
  useTerminalSizeMock.mockReturnValue({ columns: 40, rows: 24 });
  return render(
    <SettingsContext.Provider value={createSettings(toggleModel)}>
      <KeyboardShortcuts />
    </SettingsContext.Provider>,
  );
}

describe('KeyboardShortcuts', () => {
  afterEach(() => {
    stubPlatform(originalPlatform);
  });

  it('should NOT show model toggle shortcut when toggleModel is not configured', () => {
    const { lastFrame } = renderShortcuts();
    const frame = lastFrame();
    expect(frame).not.toContain('ctrl+f');
    expect(frame).not.toContain('to toggle model');
  });

  it('should show model toggle shortcut when toggleModel is configured', () => {
    const { lastFrame } = renderShortcuts('model-b');
    const frame = lastFrame();
    expect(frame).toContain('ctrl+f');
    expect(frame).toContain('to toggle model');
  });

  // Regression: column-split sums must equal shortcuts.length, otherwise the
  // trailing shortcut ("for external editor") is sliced off and never rendered.
  it('should render the last shortcut when toggleModel is not configured', () => {
    const { lastFrame } = renderShortcuts();
    const frame = lastFrame();
    expect(frame).toContain('ctrl+x');
    expect(frame).toContain('for external editor');
  });

  it('should render the last shortcut when toggleModel is configured', () => {
    const { lastFrame } = renderShortcuts('model-b');
    const frame = lastFrame();
    expect(frame).toContain('ctrl+x');
    expect(frame).toContain('for external editor');
  });

  it.each([
    ['darwin', 'ctrl+v / option+v to paste images', ['alt+v']],
    ['win32', 'alt+v to paste images', ['option+v']],
    ['linux', 'ctrl+v to paste images', ['option+v', 'alt+v']],
  ] as const)(
    'advertises the %s image-paste key',
    (platform, expectedPasteCell, absentKeys) => {
      stubPlatform(platform);
      const { lastFrame } = renderShortcuts();
      const frame = lastFrame() ?? '';
      expect(frame).toContain(expectedPasteCell);
      for (const absent of absentKeys) {
        expect(frame).not.toContain(absent);
      }
    },
  );
});
