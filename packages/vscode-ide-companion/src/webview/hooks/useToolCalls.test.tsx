/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useToolCalls } from './useToolCalls.js';
import type { ToolCallUpdate } from '../../types/chatTypes.js';

type HookSnapshot = ReturnType<typeof useToolCalls>;

let latestSnapshot: HookSnapshot | null = null;

function HookHarness() {
  latestSnapshot = useToolCalls();
  return null;
}

describe('useToolCalls', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(<HookHarness />);
    });
  });

  afterEach(() => {
    latestSnapshot = null;
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
  });

  it('stores structured rawOutput for agent tool calls across updates', () => {
    const startUpdate = {
      type: 'tool_call',
      toolCallId: 'agent-1',
      kind: 'other',
      title: 'Launch agent',
      status: 'in_progress',
      rawOutput: {
        type: 'task_execution',
        subagentName: 'Explore',
        taskDescription: 'Explore auth logic',
        taskPrompt: 'Inspect auth flow implementation',
        status: 'running',
      },
    } as ToolCallUpdate & { rawOutput: unknown };

    act(() => {
      latestSnapshot?.handleToolCallUpdate(startUpdate);
    });

    expect(latestSnapshot?.toolCalls.get('agent-1')).toMatchObject({
      toolCallId: 'agent-1',
      kind: 'other',
      title: 'Launch agent',
      status: 'in_progress',
      rawOutput: {
        type: 'task_execution',
        taskDescription: 'Explore auth logic',
      },
    });

    const completionUpdate = {
      type: 'tool_call_update',
      toolCallId: 'agent-1',
      status: 'completed',
      rawOutput: {
        type: 'task_execution',
        subagentName: 'Explore',
        taskDescription: 'Explore auth logic',
        taskPrompt: 'Inspect auth flow implementation',
        status: 'completed',
        executionSummary: {
          totalToolCalls: 3,
          totalTokens: 1234,
          totalDurationMs: 2200,
        },
      },
    } as ToolCallUpdate & { rawOutput: unknown };

    act(() => {
      latestSnapshot?.handleToolCallUpdate(completionUpdate);
    });

    expect(latestSnapshot?.toolCalls.get('agent-1')).toMatchObject({
      status: 'completed',
      rawOutput: {
        type: 'task_execution',
        status: 'completed',
        executionSummary: {
          totalToolCalls: 3,
          totalTokens: 1234,
          totalDurationMs: 2200,
        },
      },
    });
  });
});
