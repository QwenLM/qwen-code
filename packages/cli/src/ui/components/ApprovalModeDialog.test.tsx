/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { ApprovalMode } from '@qwen-code/qwen-code-core';
import { LoadedSettings } from '../../config/settings.js';
import type { SettingScope } from '../../config/settings.js';
import { renderWithProviders } from '../../test-utils/render.js';
import { ApprovalModeDialog } from './ApprovalModeDialog.js';

function createSettings(): LoadedSettings {
  return new LoadedSettings(
    { path: '', settings: {}, originalSettings: {} },
    { path: '', settings: {}, originalSettings: {} },
    { path: '', settings: {}, originalSettings: {} },
    { path: '', settings: {}, originalSettings: {} },
    true,
    new Set(),
  );
}

function frameHeight(frame: string): number {
  return frame.length === 0 ? 0 : frame.split('\n').length;
}

describe('ApprovalModeDialog', () => {
  it.each([6, 8, 10, 12])(
    'keeps the mode picker within %i rows',
    (availableTerminalHeight) => {
      const { lastFrame } = renderWithProviders(
        <ApprovalModeDialog
          settings={createSettings()}
          currentMode={ApprovalMode.DEFAULT}
          availableTerminalHeight={availableTerminalHeight}
          onSelect={vi.fn<
            (mode: ApprovalMode | undefined, scope: SettingScope) => void
          >()}
        />,
      );

      expect(frameHeight(lastFrame() ?? '')).toBeLessThanOrEqual(
        availableTerminalHeight,
      );
    },
  );

  it('keeps the current mode visible when the constrained picker scrolls', () => {
    const { lastFrame } = renderWithProviders(
      <ApprovalModeDialog
        settings={createSettings()}
        currentMode={ApprovalMode.YOLO}
        availableTerminalHeight={8}
        onSelect={vi.fn<
          (mode: ApprovalMode | undefined, scope: SettingScope) => void
        >()}
      />,
    );

    expect(lastFrame() ?? '').toContain('Automatically approve all tools');
  });
});
