/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderWithI18n } from '../../test-utils/render.js';
import { RawMarkdownIndicator } from './RawMarkdownIndicator.js';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createMockSettings } from '../../test-utils/settings.js';

describe('RawMarkdownIndicator', () => {
  const originalPlatform = process.platform;

  beforeEach(() => vi.stubEnv('FORCE_GENERIC_KEYBINDING_HINTS', ''));

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
    });
    vi.unstubAllEnvs();
  });

  it('renders correct key binding for darwin', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
    });
    const { lastFrame, unmount } = await renderWithI18n(
      <RawMarkdownIndicator />,
    );
    expect(lastFrame()).toContain('raw markdown mode');
    expect(lastFrame()).toContain('Option+M to toggle');
    unmount();
  });

  it('renders correct key binding for other platforms', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'linux',
    });
    const { lastFrame, unmount } = await renderWithI18n(
      <RawMarkdownIndicator />,
    );
    expect(lastFrame()).toContain('raw markdown mode');
    expect(lastFrame()).toContain('Alt+M to toggle');
    unmount();
  });

  it('localizes the mode label while preserving the formatted shortcut', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'linux',
    });
    const settings = createMockSettings({
      user: {
        path: '/read-only/settings.json',
        settings: { ui: { language: 'zh-CN' } },
        originalSettings: { ui: { language: 'zh-CN' } },
        readOnly: true,
      },
    });
    const { lastFrame, unmount } = await renderWithI18n(
      <RawMarkdownIndicator />,
      undefined,
      1000,
      settings,
    );
    expect(lastFrame()).toContain('原始 Markdown 模式');
    expect(lastFrame()).toContain('Alt+M');
    unmount();
  });
});
