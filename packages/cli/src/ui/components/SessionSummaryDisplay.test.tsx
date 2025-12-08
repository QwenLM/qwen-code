/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, it, expect, vi } from 'vitest';
import { SessionSummaryDisplay } from './SessionSummaryDisplay.js';
import * as SessionContext from '../contexts/SessionContext.js';

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

  return render(<SessionSummaryDisplay duration="1h 23m 45s" />);
};

describe('<SessionSummaryDisplay />', () => {
  it('renders the summary display with a title', () => {
    const { lastFrame } = renderWithMockedStats();
    const output = lastFrame();

    expect(output).toContain('Agent powering down. Goodbye!');
    expect(output).toContain('Session stats are disabled in this build.');
  });
});
