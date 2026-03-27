/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  extractFollowupSuggestionContext,
  extractModifiedFileFromTool,
} from './followupHistory.js';
import type {
  HistoryItem,
  IndividualToolCallDisplay,
  ToolCallStatus,
} from './types.js';
import { ToolCallStatus as UIToolCallStatus } from './types.js';

function createTool(
  overrides: Partial<IndividualToolCallDisplay>,
): IndividualToolCallDisplay {
  return {
    callId: 'tool-call-id',
    name: 'Edit',
    description: 'src/app.ts: before => after',
    resultDisplay: undefined,
    status: UIToolCallStatus.Success,
    confirmationDetails: undefined,
    ...overrides,
  };
}

function createToolGroup(
  tools: IndividualToolCallDisplay[],
): Extract<HistoryItem, { type: 'tool_group' }> {
  return {
    type: 'tool_group',
    tools,
  };
}

describe('extractModifiedFileFromTool', () => {
  it('treats WriteFile overwrite results conservatively as edited files', () => {
    const modifiedFile = extractModifiedFileFromTool(
      createTool({
        name: 'WriteFile',
        description: 'Writing to src/app.ts',
        resultDisplay: 'Successfully overwrote file: /tmp/src/app.ts.',
      }),
    );

    expect(modifiedFile).toEqual({
      path: 'src/app.ts',
      type: 'edited',
    });
  });

  it('treats WriteFile creation messages as created files when explicitly available', () => {
    const modifiedFile = extractModifiedFileFromTool(
      createTool({
        name: 'WriteFile',
        description: 'Writing to src/new-file.ts',
        resultDisplay:
          'Successfully created and wrote to new file: /tmp/src/new-file.ts.',
      }),
    );

    expect(modifiedFile).toEqual({
      path: 'src/new-file.ts',
      type: 'created',
    });
  });
});

describe('extractFollowupSuggestionContext', () => {
  it('uses only tool calls and assistant content from the most recent turn', () => {
    const context = extractFollowupSuggestionContext([
      { type: 'user', text: 'old turn' },
      { type: 'gemini', text: 'I created an old file' },
      createToolGroup([
        createTool({
          name: 'WriteFile',
          description: 'Writing to src/old.ts',
          resultDisplay:
            'Successfully created and wrote to new file: /tmp/src/old.ts.',
        }),
      ]),
      { type: 'user', text: 'current turn' },
      { type: 'gemini', text: 'I fixed the current bug' },
      createToolGroup([
        createTool({
          name: 'Edit',
          description: 'src/current.ts: before => after',
          status: UIToolCallStatus.Success,
        }),
      ]),
    ] satisfies HistoryItem[]);

    expect(context).not.toBeNull();
    expect(context?.lastMessage).toBe('I fixed the current bug');
    expect(context?.toolCalls).toEqual([
      { name: 'Edit', input: {}, status: 'success' },
    ]);
    expect(context?.modifiedFiles).toEqual([
      { path: 'src/current.ts', type: 'edited' },
    ]);
  });

  it('returns null when the current turn has no tool calls', () => {
    const context = extractFollowupSuggestionContext([
      { type: 'user', text: 'old turn' },
      { type: 'gemini', text: 'I edited a file earlier' },
      createToolGroup([
        createTool({
          name: 'Edit',
          description: 'src/old.ts: before => after',
        }),
      ]),
      { type: 'user', text: 'current turn' },
      { type: 'gemini', text: 'No tool calls this time' },
    ] satisfies HistoryItem[]);

    expect(context).toBeNull();
  });

  it('maps tool statuses for followup generation', () => {
    const history: HistoryItem[] = [
      { type: 'user', text: 'current turn' },
      { type: 'gemini', text: 'The shell command failed' },
      createToolGroup([
        createTool({
          name: 'Shell',
          description: 'Running npm test',
          status: UIToolCallStatus.Error as ToolCallStatus,
        }),
      ]),
    ];

    const context = extractFollowupSuggestionContext(history);

    expect(context?.toolCalls).toEqual([
      { name: 'Shell', input: {}, status: 'error' },
    ]);
    expect(context?.hasError).toBe(true);
    expect(context?.wasCancelled).toBe(false);
  });
});
