/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { SessionStatsProvider } from '../contexts/SessionContext.js';
import { SessionTab } from './StatsSessionTab.js';

// Deliberately no KeypressContext mock: the unscrolled tab is also rendered
// by the TUI parity script, which has no KeypressProvider.
describe('<SessionTab /> without a height budget', () => {
  it('renders without a KeypressProvider', () => {
    const { lastFrame } = render(
      <SessionStatsProvider>
        <SessionTab />
      </SessionStatsProvider>,
    );
    expect(lastFrame()).toContain('Session ID');
    expect(lastFrame()).not.toContain('useKeypressContext');
  });
});
