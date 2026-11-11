/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { AgentLoopContext } from '../../config/agent-loop-context.js';
import { uiTelemetryService, ToolCallDecision } from '../../services/session-stats.js';
import { ToolConfirmationOutcome } from '../../tools/tools.js';
import type { CompletedToolCall } from '../types.js';
import { CoreToolCallStatus, ROOT_TOOL_CALL_SCOPE_ID } from '../types.js';
import {
  recordToolCallStats,
  resolveToolCallScopeId,
} from './streaming-tool-executor.js';

function scopeFor(overrides: Record<string, unknown>): string {
  return resolveToolCallScopeId({
    promptId: 'session-1',
    config: { promptId: 'session-1' },
    ...overrides,
  } as unknown as AgentLoopContext);
}

describe('resolveToolCallScopeId', () => {
  it('keeps the main session on the root scope', () => {
    expect(scopeFor({})).toBe(ROOT_TOOL_CALL_SCOPE_ID);
  });

  it('scopes an internal fork by its own prompt id', () => {
    expect(scopeFor({ promptId: 'auto-dream-abcd' })).toBe('auto-dream-abcd');
  });

  it('keeps subagent isolation in the prompt/agent key', () => {
    expect(scopeFor({ promptId: 'turn-1', agentId: 'agent-1' })).toBe(
      'turn-1:agent-1',
    );
  });

  it('treats a missing context as root', () => {
    expect(resolveToolCallScopeId()).toBe(ROOT_TOOL_CALL_SCOPE_ID);
  });
});

function makeCompletedCall(
  overrides: Record<string, unknown> = {},
): CompletedToolCall {
  return {
    status: CoreToolCallStatus.Success,
    durationMs: 42,
    tool: { name: 'read_file' },
    request: { name: 'read_file', args: {}, callId: 'call-1', prompt_id: 'p-1' },
    response: { diffStat: undefined },
    ...overrides,
  } as unknown as CompletedToolCall;
}

describe('recordToolCallStats', () => {
  it('keeps tool counts, duration and decisions in local session stats', () => {
    uiTelemetryService.clear('tool-stats-test');

    recordToolCallStats(
      // Native calls are keyed by the requested name, not the tool instance.
      makeCompletedCall({
        tool: { name: 'ReadFile' },
        outcome: ToolConfirmationOutcome.ProceedOnce,
      }),
    );

    const stats = uiTelemetryService.getMetrics();
    expect(stats.tools.totalCalls).toBe(1);
    expect(stats.tools.totalSuccess).toBe(1);
    expect(stats.tools.totalFail).toBe(0);
    expect(stats.tools.totalDurationMs).toBe(42);
    expect(stats.tools.byName['read_file']).toMatchObject({ count: 1, success: 1 });
    expect(stats.tools.byName['ReadFile']).toBeUndefined();
    expect(stats.tools.totalDecisions[ToolCallDecision.ACCEPT]).toBe(1);
  });

  it('records successful file line deltas', () => {
    uiTelemetryService.clear('tool-stats-test');

    recordToolCallStats(
      makeCompletedCall({
        tool: { name: 'edit' },
        request: { name: 'edit', args: {}, callId: 'call-2', prompt_id: 'p-1' },
        response: {
          diffStat: { model_added_lines: 3, model_removed_lines: 1 },
        },
      }),
    );

    const stats = uiTelemetryService.getMetrics();
    expect(stats.tools.totalSuccess).toBe(1);
    expect(stats.tools.byName['edit']).toMatchObject({ count: 1, success: 1 });
    expect(stats.files.totalLinesAdded).toBe(3);
    expect(stats.files.totalLinesRemoved).toBe(1);
  });

  it('records failed calls without counting their line deltas', () => {
    uiTelemetryService.clear('tool-stats-test');

    recordToolCallStats(
      makeCompletedCall({
        status: CoreToolCallStatus.Error,
        tool: { name: 'edit' },
        request: { name: 'edit', args: {}, callId: 'call-3', prompt_id: 'p-1' },
        response: {
          diffStat: { model_added_lines: 3, model_removed_lines: 1 },
        },
      }),
    );

    const stats = uiTelemetryService.getMetrics();
    expect(stats.tools.totalFail).toBe(1);
    expect(stats.tools.byName['edit']).toMatchObject({ count: 1, fail: 1 });
    expect(stats.files.totalLinesAdded).toBe(0);
    expect(stats.files.totalLinesRemoved).toBe(0);
  });
});
