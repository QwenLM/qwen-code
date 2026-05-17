/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  AgentStatus,
  ArenaEventType,
  AuthType,
} from '@qwen-code/qwen-code-core';
import { arenaCommand } from './arenaCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

const arenaManagerMocks = vi.hoisted(() => ({
  instances: [] as Array<{
    emitter: EventEmitter;
    start: ReturnType<typeof vi.fn>;
    setLifecyclePromise: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();

  class MockArenaManager {
    emitter = new EventEmitter();
    start = vi.fn().mockResolvedValue(undefined);
    setLifecyclePromise = vi.fn();

    constructor() {
      arenaManagerMocks.instances.push(this);
    }

    getEventEmitter() {
      return this.emitter;
    }
  }

  return {
    ...actual,
    ArenaManager: MockArenaManager,
  };
});

beforeEach(() => {
  arenaManagerMocks.instances.length = 0;
});

describe('arenaCommand agent completion history', () => {
  it('preserves arena result metadata needed by completion cards', async () => {
    const chatRecorder = {
      recordSlashCommand: vi.fn(),
    };
    const config = {
      getArenaManager: vi.fn(() => null),
      setArenaManager: vi.fn(),
      getContentGeneratorConfig: vi.fn(() => ({
        authType: AuthType.USE_OPENAI,
      })),
      getModelsConfig: vi.fn(() => ({
        getAvailableModelsForAuthType: vi.fn(() => []),
      })),
      getApprovalMode: vi.fn(() => 'default'),
      getGeminiClient: vi.fn(() => ({
        getHistory: vi.fn(() => []),
      })),
      getChatRecordingService: vi.fn(() => chatRecorder),
    };
    const context = createMockCommandContext({
      services: {
        config: config as never,
      },
    });
    const startCommand = arenaCommand.subCommands?.find(
      (command) => command.name === 'start',
    );

    if (!startCommand?.action) {
      throw new Error('The arena start command must have an action.');
    }

    await startCommand.action!(
      context,
      '--models model-a,model-b "implement auth"',
    );

    const manager = arenaManagerMocks.instances[0];
    expect(manager).toBeDefined();

    const diffSummary = {
      files: [{ path: 'src/auth.ts', additions: 12, deletions: 3 }],
      additions: 12,
      deletions: 3,
    };
    manager!.emitter.emit(ArenaEventType.AGENT_COMPLETE, {
      agentId: 'agent-1',
      result: {
        agentId: 'agent-1',
        model: { modelId: 'model-a' },
        status: AgentStatus.COMPLETED,
        stats: {
          durationMs: 2500,
          totalTokens: 400,
          inputTokens: 250,
          outputTokens: 150,
          toolCalls: 3,
          successfulToolCalls: 3,
          failedToolCalls: 0,
          rounds: 2,
        },
        diff: 'diff --git a/src/auth.ts b/src/auth.ts',
        diffSummary,
        modifiedFiles: ['src/auth.ts'],
        approachSummary: 'Refactored auth flow.',
      },
    });

    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'arena_agent_complete',
        agent: expect.objectContaining({
          diffSummary,
          modifiedFiles: ['src/auth.ts'],
          approachSummary: 'Refactored auth flow.',
        }),
      }),
      expect.any(Number),
    );
    expect(chatRecorder.recordSlashCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        outputHistoryItems: [
          expect.objectContaining({
            type: 'arena_agent_complete',
            agent: expect.objectContaining({
              diffSummary,
              modifiedFiles: ['src/auth.ts'],
              approachSummary: 'Refactored auth flow.',
            }),
          }),
        ],
      }),
    );
  });
});
