/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { persistentStateMock } from '../../test-utils/render.js';
import { createMockSettings } from '../../test-utils/settings.js';
import { AppHeader } from './AppHeader.js';
import { makeFakeConfig } from '@qwen-code/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { _clearTipsShownForTest } from '../hooks/useTips.js';
import { createTuiFixture } from '../../test-utils/tuiFixture.js';

const { renderWithProviders } = createTuiFixture();
vi.mock('../utils/terminalSetup.js', () => ({
  getTerminalProgram: () => null,
}));

describe('<AppHeader />', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    persistentStateMock.reset();
    _clearTipsShownForTest();
  });

  it.each([false, true])(
    'shows the session agent once when hideBanner=%s',
    async (hideBanner) => {
      const config = makeFakeConfig();
      vi.spyOn(config, 'getSessionAgent').mockReturnValue('reviewer');
      const rendered = await renderWithProviders(
        <AppHeader version="1.0.0" />,
        {
          config,
          settings: createMockSettings({ ui: { hideBanner, hideTips: true } }),
        },
      );
      try {
        await rendered.waitUntilReady();
        const frame = rendered.lastFrame({ allowEmpty: hideBanner }) ?? '';
        expect(frame.match(/@reviewer/g) ?? []).toHaveLength(
          hideBanner ? 0 : 1,
        );
        if (!hideBanner)
          expect(frame.indexOf('@reviewer')).toBeGreaterThan(
            frame.indexOf('v1.0.0'),
          );
      } finally {
        rendered.unmount();
      }
    },
  );

  it('should render Tips when tipsShown is less than 10', async () => {
    persistentStateMock.setData({ tipsShown: 5 });
    const rendered = await renderWithProviders(<AppHeader version="1.0.0" />, {
      uiState: { history: [] },
    });
    try {
      await rendered.waitUntilReady();
      expect(rendered.lastFrame()).toContain('Tips');
      expect(persistentStateMock.set).toHaveBeenCalledWith('tipsShown', 6);
    } finally {
      rendered.unmount();
    }
  });

  it('should NOT render Tips when tipsShown is 10 or more', async () => {
    persistentStateMock.setData({ tipsShown: 10 });
    const rendered = await renderWithProviders(<AppHeader version="1.0.0" />);
    try {
      await rendered.waitUntilReady();
      expect(rendered.lastFrame()).not.toContain('Tips');
    } finally {
      rendered.unmount();
    }
  });

  it('should show tips until they have been shown 10 times (persistence flow)', async () => {
    persistentStateMock.setData({ tipsShown: 9 });
    const session1 = await renderWithProviders(<AppHeader version="1.0.0" />, {
      uiState: { history: [] },
    });
    try {
      await session1.waitUntilReady();
      expect(session1.lastFrame()).toContain('Tips');
      expect(persistentStateMock.get('tipsShown')).toBe(10);
    } finally {
      session1.unmount();
    }

    const session2 = await renderWithProviders(<AppHeader version="1.0.0" />);
    try {
      await session2.waitUntilReady();
      expect(session2.lastFrame()).not.toContain('Tips');
    } finally {
      session2.unmount();
    }
  });

  it('should NOT render Tips when ui.hideTips is true', async () => {
    const rendered = await renderWithProviders(<AppHeader version="1.0.0" />, {
      settings: createMockSettings({ ui: { hideTips: true } }),
    });
    try {
      await rendered.waitUntilReady();
      expect(rendered.lastFrame()).not.toContain('Tips');
      expect(persistentStateMock.set).not.toHaveBeenCalled();
    } finally {
      rendered.unmount();
    }
  });

  it('localizes tips while preserving technical tokens', async () => {
    const settings = createMockSettings({
      user: {
        path: '/read-only/settings.json',
        settings: { ui: { language: 'zh-CN' } },
        originalSettings: { ui: { language: 'zh-CN' } },
        readOnly: true,
      },
    });
    const rendered = await renderWithProviders(<AppHeader version="1.2.3" />, {
      settings,
      width: 140,
    });
    try {
      await rendered.waitUntilReady();
      const output = rendered.lastFrame();
      expect(output).toContain('快速入门提示');
      expect(output).toContain('/help');
      expect(output).toContain('AGENTS.md');
      expect(output).toContain('v1.2.3');
    } finally {
      rendered.unmount();
    }
  });
});
