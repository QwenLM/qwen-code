/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { agentMessagesToHistoryItems } from './agentHistoryAdapter.js';
import type {
  AgentMessage,
  ToolCallConfirmationDetails,
} from '@qwen-code/qwen-code-core';
import { ToolCallStatus } from '../../types.js';

// ─── Helpers ────────────────────────────────────────────────

function msg(
  role: AgentMessage['role'],
  content: string,
  extra?: Partial<AgentMessage>,
): AgentMessage {
  return { role, content, timestamp: 0, ...extra };
}

const noApprovals = new Map<string, ToolCallConfirmationDetails>();

function toolCallMsg(
  callId: string,
  toolName: string,
  opts?: { description?: string; renderOutputAsMarkdown?: boolean },
): AgentMessage {
  return msg('tool_call', `Tool call: ${toolName}`, {
    metadata: {
      callId,
      toolName,
      description: opts?.description ?? '',
      renderOutputAsMarkdown: opts?.renderOutputAsMarkdown,
    },
  });
}

function toolResultMsg(
  callId: string,
  toolName: string,
  opts?: {
    success?: boolean;
    resultDisplay?: string;
    outputFile?: string;
  },
): AgentMessage {
  return msg('tool_result', `Tool ${toolName}`, {
    metadata: {
      callId,
      toolName,
      success: opts?.success ?? true,
      resultDisplay: opts?.resultDisplay,
      outputFile: opts?.outputFile,
    },
  });
}

// ─── Role mapping ────────────────────────────────────────────

describe('agentMessagesToHistoryItems — role mapping', () => {
  it('maps user message', () => {
    const items = agentMessagesToHistoryItems(
      [msg('user', 'hello')],
      noApprovals,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'user', text: 'hello' });
  });

  it('maps plain assistant message', () => {
    const items = agentMessagesToHistoryItems(
      [msg('assistant', 'response')],
      noApprovals,
    );
    expect(items[0]).toMatchObject({ type: 'gemini', text: 'response' });
  });

  it('maps thought assistant message', () => {
    const items = agentMessagesToHistoryItems(
      [msg('assistant', 'thinking...', { thought: true })],
      noApprovals,
    );
    expect(items[0]).toMatchObject({
      type: 'gemini_thought',
      text: 'thinking...',
    });
  });

  it('maps assistant message with error metadata', () => {
    const items = agentMessagesToHistoryItems(
      [msg('assistant', 'oops', { metadata: { error: true } })],
      noApprovals,
    );
    expect(items[0]).toMatchObject({ type: 'error', text: 'oops' });
  });

  it('maps info message with no level → type info', () => {
    const items = agentMessagesToHistoryItems(
      [msg('info', 'note')],
      noApprovals,
    );
    expect(items[0]).toMatchObject({ type: 'info', text: 'note' });
  });

  it.each([
    ['warning', 'warning'],
    ['success', 'success'],
    ['error', 'error'],
  ] as const)('maps info message with level=%s', (level, expectedType) => {
    const items = agentMessagesToHistoryItems(
      [msg('info', 'text', { metadata: { level } })],
      noApprovals,
    );
    expect(items[0]).toMatchObject({ type: expectedType });
  });

  it('maps unknown info level → type info', () => {
    const items = agentMessagesToHistoryItems(
      [msg('info', 'x', { metadata: { level: 'verbose' } })],
      noApprovals,
    );
    expect(items[0]).toMatchObject({ type: 'info' });
  });

  it('skips unknown roles without crashing', () => {
    const items = agentMessagesToHistoryItems(
      [
        msg('user', 'before'),
        // force an unknown role
        { role: 'unknown' as AgentMessage['role'], content: 'x', timestamp: 0 },
        msg('user', 'after'),
      ],
      noApprovals,
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ type: 'user', text: 'before' });
    expect(items[1]).toMatchObject({ type: 'user', text: 'after' });
  });
});

// ─── Tool grouping ───────────────────────────────────────────

describe('agentMessagesToHistoryItems — tool grouping', () => {
  it('merges a tool_call + tool_result pair into one tool_group', () => {
    const items = agentMessagesToHistoryItems(
      [toolCallMsg('c1', 'read_file'), toolResultMsg('c1', 'read_file')],
      noApprovals,
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.type).toBe('tool_group');
    const group = items[0] as Extract<
      (typeof items)[0],
      { type: 'tool_group' }
    >;
    expect(group.tools).toHaveLength(1);
    expect(group.tools[0]!.name).toBe('read_file');
  });

  it('merges multiple parallel tool calls into one tool_group', () => {
    const items = agentMessagesToHistoryItems(
      [
        toolCallMsg('c1', 'read_file'),
        toolCallMsg('c2', 'write_file'),
        toolResultMsg('c1', 'read_file'),
        toolResultMsg('c2', 'write_file'),
      ],
      noApprovals,
    );
    expect(items).toHaveLength(1);
    const group = items[0] as Extract<
      (typeof items)[0],
      { type: 'tool_group' }
    >;
    expect(group.tools).toHaveLength(2);
    expect(group.tools[0]!.name).toBe('read_file');
    expect(group.tools[1]!.name).toBe('write_file');
  });

  it('preserves tool call order by first appearance', () => {
    const items = agentMessagesToHistoryItems(
      [
        toolCallMsg('c2', 'second'),
        toolCallMsg('c1', 'first'),
        toolResultMsg('c1', 'first'),
        toolResultMsg('c2', 'second'),
      ],
      noApprovals,
    );
    const group = items[0] as Extract<
      (typeof items)[0],
      { type: 'tool_group' }
    >;
    expect(group.tools[0]!.name).toBe('second');
    expect(group.tools[1]!.name).toBe('first');
  });

  it('breaks tool groups at non-tool messages', () => {
    const items = agentMessagesToHistoryItems(
      [
        toolCallMsg('c1', 'tool_a'),
        toolResultMsg('c1', 'tool_a'),
        msg('assistant', 'between'),
        toolCallMsg('c2', 'tool_b'),
        toolResultMsg('c2', 'tool_b'),
      ],
      noApprovals,
    );
    expect(items).toHaveLength(3);
    expect(items[0]!.type).toBe('tool_group');
    expect(items[1]!.type).toBe('gemini');
    expect(items[2]!.type).toBe('tool_group');
  });

  it('handles tool_result arriving without a prior tool_call gracefully', () => {
    const items = agentMessagesToHistoryItems(
      [
        toolResultMsg('c1', 'orphan', {
          success: true,
          resultDisplay: 'output',
        }),
      ],
      noApprovals,
    );
    expect(items).toHaveLength(1);
    const group = items[0] as Extract<
      (typeof items)[0],
      { type: 'tool_group' }
    >;
    expect(group.tools[0]!.callId).toBe('c1');
    expect(group.tools[0]!.status).toBe(ToolCallStatus.Success);
  });
});

// ─── Tool status ─────────────────────────────────────────────

describe('agentMessagesToHistoryItems — tool status', () => {
  it('Executing: tool_call with no result yet', () => {
    const items = agentMessagesToHistoryItems(
      [toolCallMsg('c1', 'shell')],
      noApprovals,
    );
    const group = items[0] as Extract<
      (typeof items)[0],
      { type: 'tool_group' }
    >;
    expect(group.tools[0]!.status).toBe(ToolCallStatus.Executing);
  });

  it('Success: tool_result with success=true', () => {
    const items = agentMessagesToHistoryItems(
      [
        toolCallMsg('c1', 'read'),
        toolResultMsg('c1', 'read', { success: true }),
      ],
      noApprovals,
    );
    const group = items[0] as Extract<
      (typeof items)[0],
      { type: 'tool_group' }
    >;
    expect(group.tools[0]!.status).toBe(ToolCallStatus.Success);
  });

  it('Error: tool_result with success=false', () => {
    const items = agentMessagesToHistoryItems(
      [
        toolCallMsg('c1', 'write'),
        toolResultMsg('c1', 'write', { success: false }),
      ],
      noApprovals,
    );
    const group = items[0] as Extract<
      (typeof items)[0],
      { type: 'tool_group' }
    >;
    expect(group.tools[0]!.status).toBe(ToolCallStatus.Error);
  });

  it('Confirming: tool_call present in pendingApprovals', () => {
    const fakeApproval = {} as ToolCallConfirmationDetails;
    const approvals = new Map([['c1', fakeApproval]]);
    const items = agentMessagesToHistoryItems(
      [toolCallMsg('c1', 'shell')],
      approvals,
    );
    const group = items[0] as Extract<
      (typeof items)[0],
      { type: 'tool_group' }
    >;
    expect(group.tools[0]!.status).toBe(ToolCallStatus.Confirming);
    expect(group.tools[0]!.confirmationDetails).toBe(fakeApproval);
  });

  it('Confirming takes priority over Executing', () => {
    // pending approval AND no result yet → Confirming, not Executing
    const approvals = new Map([['c1', {} as ToolCallConfirmationDetails]]);
    const items = agentMessagesToHistoryItems(
      [toolCallMsg('c1', 'shell')],
      approvals,
    );
    const group = items[0] as Extract<
      (typeof items)[0],
      { type: 'tool_group' }
    >;
    expect(group.tools[0]!.status).toBe(ToolCallStatus.Confirming);
  });
});

// ─── Tool metadata ───────────────────────────────────────────

describe('agentMessagesToHistoryItems — tool metadata', () => {
  it('forwards resultDisplay from tool_result', () => {
    const items = agentMessagesToHistoryItems(
      [
        toolCallMsg('c1', 'read'),
        toolResultMsg('c1', 'read', {
          success: true,
          resultDisplay: 'file contents',
        }),
      ],
      noApprovals,
    );
    const group = items[0] as Extract<
      (typeof items)[0],
      { type: 'tool_group' }
    >;
    expect(group.tools[0]!.resultDisplay).toBe('file contents');
  });

  it('forwards outputFile from tool_result', () => {
    const items = agentMessagesToHistoryItems(
      [
        toolCallMsg('c1', 'shell'),
        toolResultMsg('c1', 'shell', {
          success: true,
          outputFile: '/tmp/output.txt',
        }),
      ],
      noApprovals,
    );
    const group = items[0] as Extract<
      (typeof items)[0],
      { type: 'tool_group' }
    >;
    expect(group.tools[0]!.outputFile).toBe('/tmp/output.txt');
  });

  it('forwards renderOutputAsMarkdown from tool_call', () => {
    const items = agentMessagesToHistoryItems(
      [
        toolCallMsg('c1', 'web_fetch', { renderOutputAsMarkdown: true }),
        toolResultMsg('c1', 'web_fetch', { success: true }),
      ],
      noApprovals,
    );
    const group = items[0] as Extract<
      (typeof items)[0],
      { type: 'tool_group' }
    >;
    expect(group.tools[0]!.renderOutputAsMarkdown).toBe(true);
  });

  it('forwards description from tool_call', () => {
    const items = agentMessagesToHistoryItems(
      [toolCallMsg('c1', 'read', { description: 'reading src/index.ts' })],
      noApprovals,
    );
    const group = items[0] as Extract<
      (typeof items)[0],
      { type: 'tool_group' }
    >;
    expect(group.tools[0]!.description).toBe('reading src/index.ts');
  });
});

// ─── liveOutputs overlay ─────────────────────────────────────

describe('agentMessagesToHistoryItems — liveOutputs', () => {
  it('uses liveOutput as resultDisplay for Executing tools', () => {
    const liveOutputs = new Map([['c1', 'live stdout so far']]);
    const items = agentMessagesToHistoryItems(
      [toolCallMsg('c1', 'shell')],
      noApprovals,
      liveOutputs,
    );
    const group = items[0] as Extract<
      (typeof items)[0],
      { type: 'tool_group' }
    >;
    expect(group.tools[0]!.resultDisplay).toBe('live stdout so far');
  });

  it('ignores liveOutput for completed tools', () => {
    const liveOutputs = new Map([['c1', 'stale live output']]);
    const items = agentMessagesToHistoryItems(
      [
        toolCallMsg('c1', 'shell'),
        toolResultMsg('c1', 'shell', {
          success: true,
          resultDisplay: 'final output',
        }),
      ],
      noApprovals,
      liveOutputs,
    );
    const group = items[0] as Extract<
      (typeof items)[0],
      { type: 'tool_group' }
    >;
    expect(group.tools[0]!.resultDisplay).toBe('final output');
  });

  it('falls back to entry resultDisplay when no liveOutput for callId', () => {
    const liveOutputs = new Map([['other-id', 'unrelated']]);
    const items = agentMessagesToHistoryItems(
      [toolCallMsg('c1', 'shell')],
      noApprovals,
      liveOutputs,
    );
    const group = items[0] as Extract<
      (typeof items)[0],
      { type: 'tool_group' }
    >;
    expect(group.tools[0]!.resultDisplay).toBeUndefined();
  });
});

// ─── shellPids overlay ───────────────────────────────────────

describe('agentMessagesToHistoryItems — shellPids', () => {
  it('sets ptyId for Executing tools with a known PID', () => {
    const shellPids = new Map([['c1', 12345]]);
    const items = agentMessagesToHistoryItems(
      [toolCallMsg('c1', 'shell')],
      noApprovals,
      undefined,
      shellPids,
    );
    const group = items[0] as Extract<
      (typeof items)[0],
      { type: 'tool_group' }
    >;
    expect(group.tools[0]!.ptyId).toBe(12345);
  });

  it('does not set ptyId for completed tools', () => {
    const shellPids = new Map([['c1', 12345]]);
    const items = agentMessagesToHistoryItems(
      [
        toolCallMsg('c1', 'shell'),
        toolResultMsg('c1', 'shell', { success: true }),
      ],
      noApprovals,
      undefined,
      shellPids,
    );
    const group = items[0] as Extract<
      (typeof items)[0],
      { type: 'tool_group' }
    >;
    expect(group.tools[0]!.ptyId).toBeUndefined();
  });

  it('does not set ptyId when shellPids is not provided', () => {
    const items = agentMessagesToHistoryItems(
      [toolCallMsg('c1', 'shell')],
      noApprovals,
    );
    const group = items[0] as Extract<
      (typeof items)[0],
      { type: 'tool_group' }
    >;
    expect(group.tools[0]!.ptyId).toBeUndefined();
  });
});

// ─── ID stability ────────────────────────────────────────────

describe('agentMessagesToHistoryItems — ID stability', () => {
  it('assigns monotonically increasing IDs', () => {
    const items = agentMessagesToHistoryItems(
      [
        msg('user', 'u1'),
        msg('assistant', 'a1'),
        msg('info', 'i1'),
        toolCallMsg('c1', 'tool'),
        toolResultMsg('c1', 'tool'),
      ],
      noApprovals,
    );
    const ids = items.map((i) => i.id);
    expect(ids).toEqual([0, 1, 2, 3]);
  });

  it('tool_group consumes one ID regardless of how many calls it contains', () => {
    const items = agentMessagesToHistoryItems(
      [
        msg('user', 'go'),
        toolCallMsg('c1', 'tool_a'),
        toolCallMsg('c2', 'tool_b'),
        toolResultMsg('c1', 'tool_a'),
        toolResultMsg('c2', 'tool_b'),
        msg('assistant', 'done'),
      ],
      noApprovals,
    );
    // user=0, tool_group=1, assistant=2
    expect(items.map((i) => i.id)).toEqual([0, 1, 2]);
  });

  it('IDs from a prefix of messages are stable when more messages are appended', () => {
    const base: AgentMessage[] = [msg('user', 'u'), msg('assistant', 'a')];

    const before = agentMessagesToHistoryItems(base, noApprovals);
    const after = agentMessagesToHistoryItems(
      [...base, msg('info', 'i')],
      noApprovals,
    );

    expect(after[0]!.id).toBe(before[0]!.id);
    expect(after[1]!.id).toBe(before[1]!.id);
    expect(after[2]!.id).toBe(2);
  });
});
