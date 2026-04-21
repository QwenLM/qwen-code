/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentStatus,
  ArenaSessionStatus,
  type ArenaManager,
  type Config,
} from '@qwen-code/qwen-code-core';
import { renderWithProviders } from '../../../test-utils/render.js';
import { ArenaSelectDialog } from './ArenaSelectDialog.js';

describe('ArenaSelectDialog', () => {
  it('toggles quick preview and detailed diff for the highlighted agent', async () => {
    const result = {
      sessionId: 'arena-1',
      task: 'Update auth',
      status: ArenaSessionStatus.IDLE,
      agents: [
        {
          agentId: 'model-1',
          model: { modelId: 'model-1', authType: 'openai' },
          status: AgentStatus.IDLE,
          worktree: {
            id: 'w1',
            name: 'model-1',
            path: '/tmp/model-1',
            branch: 'arena/model-1',
            isActive: true,
            createdAt: 1,
          },
          stats: {
            rounds: 1,
            totalTokens: 1000,
            inputTokens: 700,
            outputTokens: 300,
            durationMs: 2000,
            toolCalls: 2,
            successfulToolCalls: 2,
            failedToolCalls: 0,
          },
          diff: `diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1 +1 @@
-old
+new`,
          diffSummary: {
            files: [{ path: 'src/auth.ts', additions: 1, deletions: 1 }],
            additions: 1,
            deletions: 1,
          },
          modifiedFiles: ['src/auth.ts'],
          approachSummary: 'Updated the auth implementation inline.',
          startedAt: 1,
        },
      ],
      startedAt: 1,
      wasRepoInitialized: false,
    };

    const manager = {
      getResult: vi.fn(() => result),
      getAgentStates: vi.fn(() => [
        {
          agentId: 'model-1',
          model: { modelId: 'model-1', authType: 'openai' },
          status: AgentStatus.IDLE,
          stats: result.agents[0]!.stats,
        },
      ]),
      getAgentState: vi.fn(),
      applyAgentResult: vi.fn(),
    } as unknown as ArenaManager;

    const config = {
      getArenaManager: () => manager,
      cleanupArenaRuntime: vi.fn(),
      getChatRecordingService: () => undefined,
    } as unknown as Config;

    const { lastFrame, stdin } = renderWithProviders(
      <ArenaSelectDialog
        manager={manager}
        config={config}
        addItem={vi.fn()}
        closeArenaDialog={vi.fn()}
      />,
    );

    stdin.write('p');
    await waitFor(() => {
      expect(lastFrame()).toContain('Quick Preview · model-1');
    });
    expect(lastFrame()).toContain('Updated the auth implementation inline.');

    stdin.write('d');
    await waitFor(() => {
      expect(lastFrame()).toContain('Detailed Diff · model-1');
    });
    expect(lastFrame()).toContain('diff --git a/src/auth.ts b/src/auth.ts');
  });
});
