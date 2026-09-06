/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { SkillStatsDisplay } from './SkillStatsDisplay.js';
import * as SessionContext from '../contexts/SessionContext.js';
import type { SessionMetrics } from '../contexts/SessionContext.js';

vi.mock('../contexts/SessionContext.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionContext>();
  return {
    ...actual,
    useSessionStats: vi.fn(),
  };
});

const useSessionStatsMock = vi.mocked(SessionContext.useSessionStats);

function renderWithMockedStats(metrics: SessionMetrics) {
  useSessionStatsMock.mockReturnValue({
    stats: {
      sessionId: 'session-1',
      sessionStartTime: new Date(),
      metrics,
      lastPromptTokenCount: 0,
      promptCount: 5,
    },
    getPromptCount: () => 5,
    startNewPrompt: vi.fn(),
    seedPromptCount: vi.fn(),
    startNewSession: vi.fn(),
  });

  return render(<SkillStatsDisplay />);
}

function createMetrics(skills: SessionMetrics['skills']): SessionMetrics {
  return {
    models: {},
    tools: {
      totalCalls: 0,
      totalSuccess: 0,
      totalFail: 0,
      totalDurationMs: 0,
      totalDecisions: {
        accept: 0,
        reject: 0,
        modify: 0,
        auto_accept: 0,
      },
      byName: {},
    },
    files: {
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
    },
    skills,
  };
}

describe('<SkillStatsDisplay />', () => {
  it('renders an empty state when no skills have been called', () => {
    const { lastFrame } = renderWithMockedStats(
      createMetrics({
        totalCalls: 0,
        totalSuccess: 0,
        totalFail: 0,
        byName: {},
      }),
    );

    expect(lastFrame()).toContain(
      'No skill calls have been made in this session.',
    );
  });

  it('renders per-skill call counts and outcomes', () => {
    const { lastFrame } = renderWithMockedStats(
      createMetrics({
        totalCalls: 3,
        totalSuccess: 2,
        totalFail: 1,
        byName: {
          review: { count: 2, success: 1, fail: 1 },
          testing: { count: 1, success: 1, fail: 0 },
        },
      }),
    );

    const output = lastFrame();
    expect(output).toContain('Skill Stats For Nerds');
    expect(output).toContain('review');
    expect(output).toContain('testing');
    expect(output).toContain('50.0%');
    expect(output).toContain('100.0%');
  });
});
