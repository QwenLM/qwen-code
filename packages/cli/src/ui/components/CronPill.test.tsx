/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../test-utils/render.js';
import { CronPill } from './CronPill.js';

describe('CronPill', () => {
  it('renders nothing when there are no scheduled tasks', () => {
    const { lastFrame, unmount } = renderWithProviders(<CronPill count={0} />);
    expect(lastFrame()).toBe('');
    unmount();
  });

  it('renders the active scheduled task count', () => {
    const { lastFrame, unmount } = renderWithProviders(<CronPill count={2} />);
    expect(lastFrame()).toContain('◎\uFE0E 2 scheduled tasks');
    unmount();
  });
});
