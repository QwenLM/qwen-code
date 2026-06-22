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
  type ArenaAgentResult,
  type Config,
} from '@qwen-code/qwen-code-core';
import { renderWithProviders } from '../../../test-utils/render.js';
import { ArenaSelectDialog } from './ArenaSelectDialog.js';

describe('ArenaSelectDialog', () => {
  it('toggles quick preview and detailed diff for the highlighted agent', async () => {
    const { manager, config } = createDialogHarness();

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

  it('closes without applying or cleaning up when Escape is pressed', async () => {
    const { manager, config, closeArenaDialog, applyAgentResult } =
      createDialogHarness();
    const cleanupArenaRuntime = config.cleanupArenaRuntime as ReturnType<
      typeof vi.fn
    >;

    const { stdin } = renderWithProviders(
      <ArenaSelectDialog
        manager={manager}
        config={config}
        addItem={vi.fn()}
        closeArenaDialog={closeArenaDialog}
      />,
    );

    stdin.write('\x1B');

    await waitFor(() => {
      expect(closeArenaDialog).toHaveBeenCalledTimes(1);
    });
    expect(applyAgentResult).not.toHaveBeenCalled();
    expect(cleanupArenaRuntime).not.toHaveBeenCalled();
  });

  it('discards results without applying changes when x is pressed', async () => {
    const { manager, config, closeArenaDialog, applyAgentResult } =
      createDialogHarness();
    const cleanupArenaRuntime = config.cleanupArenaRuntime as ReturnType<
      typeof vi.fn
    >;

    const { stdin } = renderWithProviders(
      <ArenaSelectDialog
        manager={manager}
        config={config}
        addItem={vi.fn()}
        closeArenaDialog={closeArenaDialog}
      />,
    );

    stdin.write('x');

    await waitFor(() => {
      expect(cleanupArenaRuntime).toHaveBeenCalledWith(true);
    });
    expect(closeArenaDialog).toHaveBeenCalledTimes(1);
    expect(applyAgentResult).not.toHaveBeenCalled();
  });

  it('applies the highlighted successful agent when Enter is pressed', async () => {
    const { manager, config, closeArenaDialog, applyAgentResult } =
      createDialogHarness();
    const cleanupArenaRuntime = config.cleanupArenaRuntime as ReturnType<
      typeof vi.fn
    >;

    const { stdin } = renderWithProviders(
      <ArenaSelectDialog
        manager={manager}
        config={config}
        addItem={vi.fn()}
        closeArenaDialog={closeArenaDialog}
      />,
    );

    stdin.write('\r');

    await waitFor(() => {
      expect(applyAgentResult).toHaveBeenCalledWith('model-1');
    });
    expect(closeArenaDialog).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(cleanupArenaRuntime).toHaveBeenCalledWith(true);
    });
  });

  it('ignores Enter when the highlighted agent is not selectable', async () => {
    const failedAgent = createAgentResult({
      agentId: 'model-1',
      status: AgentStatus.FAILED,
    });
    const { manager, config, closeArenaDialog, applyAgentResult } =
      createDialogHarness([failedAgent]);
    const cleanupArenaRuntime = config.cleanupArenaRuntime as ReturnType<
      typeof vi.fn
    >;

    const { stdin } = renderWithProviders(
      <ArenaSelectDialog
        manager={manager}
        config={config}
        addItem={vi.fn()}
        closeArenaDialog={closeArenaDialog}
      />,
    );

    stdin.write('\r');

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(applyAgentResult).not.toHaveBeenCalled();
    expect(closeArenaDialog).not.toHaveBeenCalled();
    expect(cleanupArenaRuntime).not.toHaveBeenCalled();
  });
});

function createDialogHarness(agents = [createAgentResult()]) {
  const result = {
    sessionId: 'arena-1',
    task: 'Update auth',
    status: ArenaSessionStatus.IDLE,
    agents,
    startedAt: 1,
    wasRepoInitialized: false,
  };

  const applyAgentResult = vi.fn().mockResolvedValue({ success: true });
  const manager = {
    getResult: vi.fn(() => result),
    getAgentStates: vi.fn(() =>
      agents.map((agent) => ({
        agentId: agent.agentId,
        model: agent.model,
        status: agent.status,
        stats: agent.stats,
      })),
    ),
    getAgentState: vi.fn((agentId: string) =>
      agents.find((agent) => agent.agentId === agentId),
    ),
    applyAgentResult,
  } as unknown as ArenaManager;

  const config = {
    getArenaManager: () => manager,
    cleanupArenaRuntime: vi.fn().mockResolvedValue(undefined),
    getChatRecordingService: () => undefined,
  } as unknown as Config;

  return {
    manager,
    config,
    closeArenaDialog: vi.fn(),
    applyAgentResult,
  };
}

function createAgentResult({
  agentId = 'model-1',
  status = AgentStatus.IDLE,
}: {
  agentId?: string;
  status?: AgentStatus;
} = {}): ArenaAgentResult {
  return {
    agentId,
    model: { modelId: agentId, authType: 'openai' },
    status,
    worktree: {
      id: `worktree-${agentId}`,
      name: agentId,
      path: `/tmp/${agentId}`,
      branch: `arena/${agentId}`,
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
  };
}
