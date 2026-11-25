/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderWithI18n } from '../../test-utils/render.js';
import { ShellModeIndicator } from './ShellModeIndicator.js';
import { describe, it, expect } from 'vitest';
import { createMockSettings } from '../../test-utils/settings.js';

describe('ShellModeIndicator', () => {
  it('renders correctly', async () => {
    const { lastFrame, unmount } = await renderWithI18n(<ShellModeIndicator />);
    expect(lastFrame()).toContain('Shell mode enabled');
    expect(lastFrame()).toContain('esc to disable');
    unmount();
  });

  it('renders the fixed label in Chinese while preserving the key name', async () => {
    const settings = createMockSettings({
      user: {
        path: '/read-only/settings.json',
        settings: { ui: { language: 'zh-CN' } },
        originalSettings: { ui: { language: 'zh-CN' } },
        readOnly: true,
      },
    });
    const { lastFrame, unmount } = await renderWithI18n(
      <ShellModeIndicator />,
      undefined,
      1000,
      settings,
    );
    expect(lastFrame()).toContain('Shell 模式已启用');
    expect(lastFrame()).toContain('esc');
    unmount();
  });
});
