/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { renderWithProviders } from '../../test-utils/render.js';
import { ShortcutsHelp } from './ShortcutsHelp.js';
import { createMockSettings } from '../../test-utils/settings.js';

describe('ShortcutsHelp', () => {
  const originalPlatform = process.platform;

  beforeEach(() => vi.stubEnv('FORCE_GENERIC_KEYBINDING_HINTS', ''));

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
    });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const testCases = [
    { name: 'wide', width: 100 },
    { name: 'narrow', width: 40 },
  ];

  const platforms = [
    { name: 'mac', value: 'darwin' },
    { name: 'linux', value: 'linux' },
  ] as const;

  it.each(
    platforms.flatMap((platform) =>
      testCases.map((testCase) => ({ ...testCase, platform })),
    ),
  )(
    'renders correctly in $name mode on $platform.name',
    async ({ width, platform }) => {
      Object.defineProperty(process, 'platform', {
        value: platform.value,
      });

      const { lastFrame, unmount } = await renderWithProviders(
        <ShortcutsHelp />,
        {
          width,
        },
      );
      expect(lastFrame()).toContain('shell mode');
      expect(lastFrame()).toMatchSnapshot();
      unmount();
    },
  );

  it('always shows the image paste shortcut', async () => {
    const rendered = await renderWithProviders(<ShortcutsHelp />);

    expect(rendered.lastFrame()).toContain('paste images');
    rendered.unmount();
  });

  it('localizes descriptions without changing shortcut keys', async () => {
    const rendered = await renderWithProviders(<ShortcutsHelp />, {
      settings: createMockSettings({ ui: { language: 'zh-CN' } }),
    });

    expect(rendered.lastFrame()).toContain('快捷键');
    expect(rendered.lastFrame()).toContain('Shell 模式');
    expect(rendered.lastFrame()).toContain('粘贴图片');
    expect(rendered.lastFrame()).toMatch(/Ctrl\+V|Option\+V/);
    expect(rendered.lastFrame()).toContain('/help');
    rendered.unmount();
  });
});
