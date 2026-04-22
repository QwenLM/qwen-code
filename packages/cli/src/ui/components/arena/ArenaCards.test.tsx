/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AgentStatus } from '@qwen-code/qwen-code-core';
import { renderWithProviders } from '../../../test-utils/render.js';
import { ArenaSessionCard } from './ArenaCards.js';
import type { ArenaAgentCardData } from '../../types.js';

describe('ArenaSessionCard', () => {
  it('renders the comparison summary sections from agent results', () => {
    const agents: ArenaAgentCardData[] = [
      {
        label: 'qwen-coder-plus',
        status: AgentStatus.IDLE,
        durationMs: 12_000,
        totalTokens: 45_000,
        inputTokens: 30_000,
        outputTokens: 15_000,
        toolCalls: 12,
        successfulToolCalls: 12,
        failedToolCalls: 0,
        rounds: 3,
        diffSummary: {
          files: [
            { path: 'src/auth.ts', additions: 200, deletions: 80 },
            { path: 'tests/auth.test.ts', additions: 45, deletions: 9 },
          ],
          additions: 245,
          deletions: 89,
        },
        modifiedFiles: ['src/auth.ts', 'tests/auth.test.ts'],
        approachSummary: 'Refactored with JWT strategy pattern.',
      },
      {
        label: 'gpt-4o',
        status: AgentStatus.IDLE,
        durationMs: 10_000,
        totalTokens: 38_000,
        inputTokens: 25_000,
        outputTokens: 13_000,
        toolCalls: 8,
        successfulToolCalls: 8,
        failedToolCalls: 0,
        rounds: 2,
        diffSummary: {
          files: [
            { path: 'src/auth.ts', additions: 120, deletions: 40 },
            { path: 'src/middleware.ts', additions: 69, deletions: 27 },
          ],
          additions: 189,
          deletions: 67,
        },
        modifiedFiles: ['src/auth.ts', 'src/middleware.ts'],
        approachSummary: 'Made inline changes with validation layer.',
      },
    ];

    const { lastFrame } = renderWithProviders(
      <ArenaSessionCard
        sessionStatus="idle"
        task="Refactor authentication"
        totalDurationMs={12_000}
        agents={agents}
        width={100}
      />,
    );

    const output = lastFrame();
    expect(output).toContain('Arena Comparison Summary');
    expect(output).not.toContain('Status    Time    Tokens   Changes');
    expect(output).toContain('Status Summary:');
    expect(output).toContain('qwen-coder-plus: Idle');
    expect(output).toContain('gpt-4o: Idle');
    expect(output).toContain('Files Modified:');
    expect(output).toContain('common: src/auth.ts');
    expect(output).toContain('qwen-coder-plus-only: tests/auth.test.ts');
    expect(output).toContain('gpt-4o-only: src/middleware.ts');
    expect(output).toContain('Approach Summary:');
    expect(output).toContain('Refactored with JWT strategy pattern.');
    expect(output).toContain('Token Efficiency:');
    expect(output).toContain('45,000 tokens');
    expect(output).toContain('45,000 tokens · runtime 12.0s');
    expect(output).not.toContain('45,000 tokens · runtime 12.0s · 12 tools');
    expect(output).not.toContain('Quick Preview:');
    expect(output).not.toContain('[View Detailed Diff]');
    expect(output).not.toContain('[Select Winner →]');
  });

  it('hides empty per-agent unique file groups', () => {
    const agents: ArenaAgentCardData[] = [
      {
        label: 'gemma4:31b',
        status: AgentStatus.IDLE,
        durationMs: 10_000,
        totalTokens: 10_000,
        inputTokens: 7_000,
        outputTokens: 3_000,
        toolCalls: 2,
        successfulToolCalls: 2,
        failedToolCalls: 0,
        rounds: 1,
        diffSummary: {
          files: [{ path: 'reader.py', additions: 20, deletions: 0 }],
          additions: 20,
          deletions: 0,
        },
        modifiedFiles: ['reader.py'],
        approachSummary: 'Created a reader.',
      },
      {
        label: 'qwen2.5:14b',
        status: AgentStatus.IDLE,
        durationMs: 8_000,
        totalTokens: 8_000,
        inputTokens: 6_000,
        outputTokens: 2_000,
        toolCalls: 2,
        successfulToolCalls: 2,
        failedToolCalls: 0,
        rounds: 1,
        diffSummary: {
          files: [{ path: 'reader.py', additions: 22, deletions: 0 }],
          additions: 22,
          deletions: 0,
        },
        modifiedFiles: ['reader.py'],
        approachSummary: 'Created a reader.',
      },
    ];

    const { lastFrame } = renderWithProviders(
      <ArenaSessionCard
        sessionStatus="idle"
        task="Create a reader"
        totalDurationMs={10_000}
        agents={agents}
        width={100}
      />,
    );

    const output = lastFrame();
    expect(output).toContain('common: reader.py');
    expect(output).not.toContain('only gemma4:31b: none');
    expect(output).not.toContain('only qwen2.5:14b: none');
  });
});
