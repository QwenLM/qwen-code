/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as acp from '@agentclientprotocol/sdk';
import {
  CoreToolCallStatus as Status,
  InMemoryToolCallSnapshotStore,
  Kind,
  type ToolCall,
} from '@qwen-code/core';
import { AcpToolCallPublisher } from './toolCallPublisher.js';
import { projectToolCall } from './toolProjection.js';

function call(
  id: string,
  status: Status,
  name = 'test_tool',
  isError = false,
): ToolCall {
  return {
    status,
    request: {
      callId: id,
      name,
      args: {},
      prompt_id: 'prompt',
      message_id: 'turn',
    },
    tool: { kind: Kind.Other },
    response: {
      callId: id,
      responseParts: [{ text: `${id} output` }],
      error: new Error('execution failed'),
      isError,
    },
  } as ToolCall;
}

const publishers: AcpToolCallPublisher[] = [];
afterEach(() => {
  for (const publisher of publishers.splice(0)) publisher.dispose();
});

function setup(
  terminal = false,
  send = vi
    .fn<(update: acp.SessionUpdate) => Promise<void>>()
    .mockResolvedValue(undefined),
) {
  const snapshots = new InMemoryToolCallSnapshotStore();
  const publisher = new AcpToolCallPublisher(
    snapshots,
    'scheduler',
    'turn',
    terminal,
    send,
  );
  publishers.push(publisher);
  const publish = (...toolCalls: ToolCall[]) =>
    snapshots.publishToolCallSnapshot({ toolCallScopeId: 'scheduler', toolCalls });
  const updates = () => send.mock.calls.map(([update]) => update);
  return { snapshots, publisher, publish, send, updates };
}

function declaration(id: string, name = 'test_tool') {
  return projectToolCall({
    toolCallId: id,
    name,
    input: {},
    status: 'pending',
  });
}

describe('AcpToolCallPublisher', () => {
  it('keeps waiting tools pending and reports execution once, even without output', async () => {
    const { publisher, publish, updates } = setup();
    await publisher.declare(declaration('tool'), 'test_tool');
    publish(call('tool', Status.Scheduled));
    publish(call('tool', Status.AwaitingApproval));
    await publisher.flush();
    expect(updates()).toHaveLength(1);
    publish(call('tool', Status.Executing));
    publish(call('tool', Status.Executing));
    await publisher.flush();
    expect(updates()).toHaveLength(2);
    expect(updates()[1]).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool',
      status: 'in_progress',
    });
  });

  it('publishes a fast tool result while another tool is still running', async () => {
    const { publisher, publish, updates } = setup();
    publish(call('slow', Status.Executing), call('fast', Status.Executing));
    publish(call('slow', Status.Executing), call('fast', Status.Success));
    await publisher.flush();
    expect(updates()).toEqual([
      expect.objectContaining({ toolCallId: 'slow', status: 'pending' }),
      expect.objectContaining({ toolCallId: 'slow', status: 'in_progress' }),
      expect.objectContaining({ toolCallId: 'fast', status: 'pending' }),
      expect.objectContaining({ toolCallId: 'fast', status: 'in_progress' }),
      expect.objectContaining({
        toolCallId: 'fast',
        status: 'completed',
        rawOutput: 'fast output',
      }),
    ]);
    // The assistant and SDK results can arrive after physical completion.
    await publisher.declare(declaration('fast'), 'test_tool');
    await publisher.result({ toolCallId: 'fast', content: 'fast output' });
    publish(call('slow', Status.Executing), call('fast', Status.Success));
    await publisher.flush();
    expect(updates()).toHaveLength(5);
  });

  it.each([
    [Status.Error, false],
    [Status.Cancelled, false],
    [Status.Success, true],
  ])('projects %s (semantic error: %s) as failed', async (status, isError) => {
    const { publisher, publish, updates } = setup();
    publish(call('tool', status, 'test_tool', isError));
    await publisher.flush();
    expect(updates()).toHaveLength(2);
    expect(updates()[1]).toMatchObject({
      toolCallId: 'tool',
      status: 'failed',
    });
    publish(call('tool', Status.Executing));
    await publisher.result({ toolCallId: 'tool', content: 'late success' });
    await publisher.flush();
    expect(updates()).toHaveLength(2);
  });

  it('uses request_permission as the declaration and still reports rejection', async () => {
    const { publisher, publish, updates } = setup();
    publisher.permissionRequested('tool', 'test_tool');
    publish(call('tool', Status.AwaitingApproval));
    await publisher.flush();
    expect(updates()).toEqual([]);
    publish(call('tool', Status.Cancelled));
    await publisher.flush();
    expect(updates()).toEqual([
      expect.objectContaining({
        sessionUpdate: 'tool_call_update',
        status: 'failed',
      }),
    ]);
  });

  it.each(['Bash', 'PowerShell'])(
    'does not repeat terminal output or exit for %s',
    async (name) => {
      const { publisher, publish, updates } = setup(true);
      publish(call('tool', Status.Executing, name));
      publish(call('tool', Status.Success, name));
      await publisher.flush();
      await publisher.result({
        toolCallId: 'tool',
        name,
        content: 'tool output',
      });
      publish(call('tool', Status.Success, name));
      await publisher.flush();
      expect(updates()).toHaveLength(4);
      expect(updates()[2]).toMatchObject({
        _meta: { terminal_output: { data: 'tool output' } },
      });
      expect(updates()[3]).toMatchObject({
        status: 'completed',
        _meta: { terminal_exit: { exit_code: 0 } },
      });
    },
  );

  it('allows SDK result enrichment without another terminal transition or stale snapshot overwrite', async () => {
    const { publisher, publish, updates } = setup();
    publish(call('tool', Status.Success));
    await publisher.flush();
    await publisher.result({ toolCallId: 'tool', content: 'enriched output' });
    publish(call('tool', Status.Success));
    await publisher.result({ toolCallId: 'tool', content: 'enriched output' });
    expect(updates()).toHaveLength(3);
    expect(updates()[2]).toMatchObject({ rawOutput: 'enriched output' });
    expect(updates()[2]).not.toHaveProperty('status');
  });

  it.each(['url', 'base64'] as const)(
    'omits eager image bytes and preserves the later %s result',
    async (sourceType) => {
      const { publisher, publish, updates } = setup();
      const completed = call(
        'image',
        Status.Success,
        'mcp__screenshots__capture',
      );
      if (completed.status !== Status.Success)
        throw new Error('Expected success');
      completed.response.responseParts = [
        { text: 'Screenshot captured' },
        { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
      ];
      publish(completed);
      await publisher.flush();
      expect(updates()[1]).toMatchObject({
        status: 'completed',
        content: [
          {
            type: 'content',
            content: { type: 'text', text: 'Screenshot captured' },
          },
        ],
        rawOutput: [{ type: 'text', text: 'Screenshot captured' }],
      });
      expect(JSON.stringify(updates())).not.toContain('aW1hZ2U=');
      // Uploaded URLs and the existing upload-failure/custom-provider fallback
      // both remain available through the final SDK result.
      const content = [
        { type: 'text', text: 'Screenshot captured' },
        {
          type: 'image',
          source:
            sourceType === 'url'
              ? { type: 'url', url: 'https://example.test/screenshot.png' }
              : { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' },
        },
      ];
      await publisher.result({ toolCallId: 'image', content });
      expect(updates()[2]).toMatchObject({ rawOutput: content });
      expect(updates()[2]).not.toHaveProperty('status');
      publish(completed);
      await publisher.result({ toolCallId: 'image', content });
      expect(updates()).toHaveLength(3);
      expect(completed.response.responseParts[1]).toHaveProperty(
        'inlineData.data',
        'aW1hZ2U=',
      );
    },
  );

  it('publishes completion for an image-only result without rendering an empty array', async () => {
    const { publisher, publish, updates } = setup();
    const completed = call(
      'image',
      Status.Success,
      'mcp__screenshots__capture',
    );
    if (completed.status !== Status.Success)
      throw new Error('Expected success');
    completed.response.responseParts = [
      { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
    ];
    publish(completed);
    await publisher.flush();
    expect(updates()[1]).toMatchObject({ status: 'completed', content: [] });
    expect(JSON.stringify(updates())).not.toContain('aW1hZ2U=');
  });

  it('retains the SDK result fallback when no execution snapshot is available', async () => {
    const { publisher, updates } = setup();
    await publisher.declare(declaration('tool'), 'test_tool');
    await publisher.result({
      toolCallId: 'tool',
      content: 'fallback',
      isError: true,
    });
    expect(updates()[1]).toMatchObject({
      status: 'failed',
      rawOutput: 'fallback',
    });
  });

  it('ignores other schedulers, old turns and snapshots after disposal', async () => {
    const { snapshots, publisher, publish, updates } = setup();
    snapshots.publishToolCallSnapshot({
      toolCallScopeId: 'subagent',
      toolCalls: [call('tool', Status.Executing)],
    });
    const old = call('old', Status.Success);
    old.request.message_id = 'old-turn';
    publish(old);
    await publisher.flush();
    expect(updates()).toEqual([]);
    publish(call('queued', Status.Executing));
    publisher.dispose();
    publish(call('later', Status.Executing));
    await publisher.flush();
    expect(updates()).toEqual([]);
  });

  it('does not send a queued update after disposal during an in-flight declaration', async () => {
    let release!: () => void;
    const send = vi
      .fn<(update: acp.SessionUpdate) => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
    const { publisher, publish, updates } = setup(false, send);
    publish(call('tool', Status.Executing));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    publisher.dispose();
    release();
    await publisher.flush();
    expect(updates()).toHaveLength(1);
  });

  it('surfaces asynchronous transport failures when the turn flushes', async () => {
    const send = vi
      .fn<(update: acp.SessionUpdate) => Promise<void>>()
      .mockRejectedValue(new Error('connection closed'));
    const { publisher, publish } = setup(false, send);
    publish(call('tool', Status.Executing));
    await expect(publisher.flush()).rejects.toThrow('connection closed');
  });
});
