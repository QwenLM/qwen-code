/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderWithProviders as render } from '../../../test-utils/render.js';
import { describe, it, expect } from 'vitest';
import { SessionBrowserLoading } from './SessionBrowserLoading.js';
import { SessionBrowserError } from './SessionBrowserError.js';
import { SessionBrowserEmpty } from './SessionBrowserEmpty.js';
import type { SessionBrowserState } from '../SessionBrowser.js';
import { createMockSettings } from '../../../test-utils/settings.js';

describe('SessionBrowser UI States', () => {
  it('SessionBrowserLoading renders correctly', async () => {
    const { lastFrame } = await render(<SessionBrowserLoading />);
    expect(lastFrame()).toMatchSnapshot();
  });

  it('SessionBrowserError renders correctly', async () => {
    const mockState = { error: 'Test error message' } as SessionBrowserState;
    const { lastFrame } = await render(
      <SessionBrowserError state={mockState} />,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('localizes the error prefix but preserves raw error detail', async () => {
    const mockState = {
      error: 'EACCES /raw/session.json',
    } as SessionBrowserState;
    const { lastFrame } = await render(
      <SessionBrowserError state={mockState} />,
      { settings: createMockSettings({ ui: { language: 'zh-CN' } }) },
    );

    expect(lastFrame()).toContain('错误：');
    expect(lastFrame()).toContain('EACCES /raw/session.json');
  });

  it('SessionBrowserEmpty renders correctly', async () => {
    const { lastFrame } = await render(<SessionBrowserEmpty />);
    expect(lastFrame()).toMatchSnapshot();
  });

  it('SessionBrowserEmpty renders a concise scoped empty state', async () => {
    const { lastFrame } = await render(
      <SessionBrowserEmpty canShowAllWorktrees />,
    );
    expect(lastFrame()).toContain('No sessions found in the current worktree.');
    expect(lastFrame()).not.toContain('Ctrl+W');
  });
});
