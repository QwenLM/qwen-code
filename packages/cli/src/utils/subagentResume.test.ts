/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  LoadedSubagentTranscript,
  Message,
} from '@qwen-code/core';
import * as core from '@qwen-code/core';
import { modelMessageToAssistantPayload } from '@qwen-code/core';
import {
  buildResumedSubagentToolCall,
  loadResumedSubagentHistory,
} from './subagentResume.js';

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    loadAllSubagentTranscripts: vi.fn(),
    reconcileAgentTaskRecords: vi.fn(),
  };
});

describe('loadResumedSubagentHistory', () => {
  it('loads transcript-backed subagent traces for tool-group resume', async () => {
    const transcriptMessages: Message[] = [
      {
        type: 'user',
        uuid: 'user-1',
        timestamp: new Date().toISOString(),
        parent_tool_use_id: 'toolu-agent-1',
        message: {
          role: 'user',
          content: 'Inspect the repository root',
        },
      },
      {
        type: 'assistant',
        uuid: 'assistant-tools',
        timestamp: new Date().toISOString(),
        message: modelMessageToAssistantPayload({
          messageId: 'resp-tools',

          model: 'test-model',
          stopReason: 'tool_use',

          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          },
          blocks: [
            {
              type: 'tool_use',
              id: 'tool-read',
              name: 'Read',
              input: { file_path: 'package.json', offset: 10, limit: 5 },
            },
            {
              type: 'tool_use',
              id: 'tool-grep',
              name: 'Grep',
              input: { pattern: 'render', path: 'src', glob: '*.ts' },
            },
          ],
        }),
      },
      {
        type: 'user',
        uuid: 'user-tools',
        timestamp: new Date().toISOString(),
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-grep',
              content: 'src/render.ts',
              is_error: false,
            },
            {
              type: 'tool_result',
              tool_use_id: 'tool-read',
              content: 'file contents',
              is_error: false,
            },
          ],
        },
      },
      {
        type: 'assistant',
        uuid: 'assistant-1',
        timestamp: new Date().toISOString(),
        message: modelMessageToAssistantPayload({
          messageId: 'resp-1',

          model: 'test-model',
          stopReason: 'end_turn',

          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          },
          blocks: [
            {
              type: 'text',
              text: 'Repository root inspected.',
            },
          ],
        }),
      },
    ];

    const transcripts: LoadedSubagentTranscript[] = [
      {
        agentId: 'agent-test',
        metadata: {
          agentType: 'research',
          invocationName: 'repo-check',
        },
        messages: transcriptMessages,
        leafUuid: transcriptMessages.at(-1)!.uuid,
      },
    ];

    vi.mocked(core.loadAllSubagentTranscripts).mockResolvedValueOnce(
      transcripts,
    );
    vi.mocked(core.reconcileAgentTaskRecords).mockResolvedValueOnce([
      {
        taskId: 'agent-test',
        sessionId: 'session-1',
        agentId: 'agent-test',
        agentType: 'research',
        description: 'Inspect the repository root',
        status: 'completed',
        result: 'Repository root inspected.',
        createdAt: 1,
        updatedAt: 2,
      },
    ]);

    const items = await loadResumedSubagentHistory('/tmp/project', 'session-1');

    const expectedActivities = [
      {
        id: 'tool-read',
        type: 'tool_call',
        content: 'Read',
        displayName: 'Read',
        description: 'package.json · lines 11-15',
        args: JSON.stringify({
          description: 'package.json · lines 11-15',
        }),
        status: 'completed',
      },
      {
        id: 'tool-grep',
        type: 'tool_call',
        content: 'Grep',
        displayName: 'Grep',
        description: "'render' in *.ts within src",
        args: JSON.stringify({
          description: "'render' in *.ts within src",
        }),
        status: 'completed',
      },
    ];
    expect(items).toEqual([
      {
        agentName: 'repo-check',
        parentToolUseId: 'toolu-agent-1',
        progress: {
          isSubagentProgress: true,
          agentName: 'repo-check',
          agentId: 'agent-test',
          color: undefined,
          toolUseCount: 2,
          recentActivity: expectedActivities,
          state: 'completed',
          result: 'Repository root inspected.',
        },
      },
    ]);
  });
});

describe('buildResumedSubagentToolCall', () => {
  it('projects transcript-backed subagent progress through the shared tool display path', () => {
    const toolCall = buildResumedSubagentToolCall({
      agentName: 'repo-check',
      parentToolUseId: 'toolu-agent-1',
      progress: {
        isSubagentProgress: true,
        agentName: 'repo-check',
        recentActivity: [
          {
            id: 'activity-1',
            type: 'thought',
            content: 'Inspected repository root.',
            status: 'completed',
          },
        ],
        state: 'completed',
        result: 'Repository root inspected.',
      },
    });

    expect(toolCall).toEqual(
      expect.objectContaining({
        callId: 'toolu-agent-1',
        name: 'repo-check',
        description: '',
        status: core.CoreToolCallStatus.Success,
        kind: core.Kind.Agent,
      }),
    );
    expect(toolCall.resultDisplay).toEqual(
      expect.objectContaining({
        isSubagentProgress: true,
        agentName: 'repo-check',
      }),
    );
    expect(toolCall.subagentHistory).toHaveLength(1);
  });
});
