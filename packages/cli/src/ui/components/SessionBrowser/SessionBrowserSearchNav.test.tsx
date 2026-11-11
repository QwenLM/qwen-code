/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderWithProviders as render } from '../../../test-utils/render.js';
import { describe, it, expect } from 'vitest';
import { SearchModeDisplay, NoResultsDisplay } from './SessionBrowserNav.js';
import { SessionListHeader } from './SessionListHeader.js';
import type { SessionBrowserState } from '../SessionBrowser.js';

describe('SessionBrowser Search and Navigation Components', () => {
  it('SearchModeDisplay renders correctly with query', async () => {
    const mockState = { searchQuery: 'test query' } as SessionBrowserState;
    const { lastFrame } = await render(<SearchModeDisplay state={mockState} />);
    expect(lastFrame()).toMatchSnapshot();
  });

  it('SessionListHeader renders correctly', async () => {
    const mockState = {
      totalSessions: 10,
      searchQuery: '',
      sortOrder: 'date',
      sortReverse: false,
      worktreeScope: 'current',
    } as SessionBrowserState;
    const { lastFrame } = await render(<SessionListHeader state={mockState} />);
    expect(lastFrame()).toMatchSnapshot();
  });

  it('SessionListHeader renders correctly with filter', async () => {
    const mockState = {
      totalSessions: 5,
      searchQuery: 'test',
      sortOrder: 'name',
      sortReverse: true,
      worktreeScope: 'all',
    } as SessionBrowserState;
    const { lastFrame } = await render(<SessionListHeader state={mockState} />);
    expect(lastFrame()).toMatchSnapshot();
  });

  it('NoResultsDisplay renders correctly', async () => {
    const mockState = {
      searchQuery: 'no match',
      worktreeScope: 'current',
    } as SessionBrowserState;
    const { lastFrame } = await render(<NoResultsDisplay state={mockState} />);
    expect(lastFrame()).toMatchSnapshot();
  });
});
