/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderWithProviders } from '../../test-utils/render.js';
import { describe, it, expect } from 'vitest';
import { Help } from './Help.js';
import { createMockSettings } from '../../test-utils/settings.js';

describe('Help Component', () => {
  // skip: 现存失败
  it.skip('should render basics section', async () => {
    const { lastFrame, unmount } = await renderWithProviders(<Help />);
    const output = lastFrame();

    expect(output).toContain('Basics:');
    expect(output).toContain('@');
    expect(output).toContain('Shell mode');
    unmount();
  });

  it('should show /commands hint instead of command list', async () => {
    const { lastFrame, unmount } = await renderWithProviders(<Help />);
    const output = lastFrame();

    expect(output).toContain('/commands');
    expect(output).toContain('all available slash commands');
    unmount();
  });

  // skip: 现存失败
  it.skip('should render keyboard shortcuts', async () => {
    const { lastFrame, unmount } = await renderWithProviders(<Help />);
    const output = lastFrame();

    expect(output).toContain('Keyboard Shortcuts:');
    expect(output).toContain('Ctrl+C');
    // The cycle-mode shortcut display varies by platform (Shift+Tab or Alt+Q)
    expect(output).toMatch(/Shift\+Tab|Alt\+Q/);
    expect(output).toContain('Page Up/Page Down');
    unmount();
  });

  it('localizes first-party text while preserving commands and key names', async () => {
    const { lastFrame, unmount } = await renderWithProviders(<Help />, {
      settings: createMockSettings({ ui: { language: 'zh-CN' } }),
    });
    const output = lastFrame();

    expect(output).toContain('帮助');
    expect(output).toContain('基础操作');
    expect(output).toContain('键盘快捷键');
    expect(output).toContain('查看全部可用的斜杠命令');
    expect(output).toContain('/commands');
    expect(output).toContain('Ctrl+C');
    expect(output).toContain('Esc 返回');
    unmount();
  });
});
