/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, it, expect, vi } from 'vitest';
import { StatsDisplay } from './StatsDisplay.js';
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
      sessionId: 'test-session-id',
      sessionStartTime: new Date(),
      promptCount: 5,
    },

    getPromptCount: () => 5,
    startNewPrompt: vi.fn(),
  });

  return render(<StatsDisplay duration="1s" />);
};

describe('<StatsDisplay />', () => {
  it('renders disabled message and title', () => {
    const { lastFrame } = renderWithMockedStats();
    const output = lastFrame();

    expect(output).toContain('Session stats are disabled in this build.');
    expect(output).toContain('Session Stats'); // Default title
  });

  it('renders custom title', () => {
    useSessionStatsMock.mockReturnValue({
      stats: {
        sessionId: 'test-session-id',
        sessionStartTime: new Date(),
        promptCount: 5,
      },

      getPromptCount: () => 5,
      startNewPrompt: vi.fn(),
    });

    const { lastFrame } = render(
      <StatsDisplay duration="1s" title="Agent powering down. Goodbye!" />,
    );
    const output = lastFrame();
    expect(output).toContain('Agent powering down. Goodbye!');
  });
});
