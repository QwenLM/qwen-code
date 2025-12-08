/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, it, expect, vi } from 'vitest';
import { ToolStatsDisplay } from './ToolStatsDisplay.js';
import * as SessionContext from '../contexts/SessionContext.js';

// Mock the context to provide controlled data for testing
vi.mock('../contexts/SessionContext.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionContext>();
  return {
    ...actual,
    useSessionStats: vi.fn(),
  };
});

const useSessionStatsMock = vi.mocked(SessionContext.useSessionStats);

const renderWithMockedStats = () => {
  useSessionStatsMock.mockReturnValue({
    stats: {
      sessionStartTime: new Date(),
      sessionId: 'test-session',
      promptCount: 5,
    },

    getPromptCount: () => 5,
    startNewPrompt: vi.fn(),
  });

  return render(<ToolStatsDisplay />);
};

describe('<ToolStatsDisplay />', () => {
  it('should render disabled message', () => {
    const { lastFrame } = renderWithMockedStats();

    expect(lastFrame()).toContain('Tool stats are disabled in this build.');
  });
});
