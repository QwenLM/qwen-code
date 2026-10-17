/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import type {
  ManagedSessionDurableRef,
  ManagedSessionEvent,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { hostedToolProgress } from './hosted-tool-progress.js';

function fixture(
  outcome: unknown = { envelope: { executionStatus: 'success' } },
) {
  const bodies = new Map<string, Buffer>();
  const resource = (id: string, body: unknown) => {
    const bytes = Buffer.from(JSON.stringify(body));
    bodies.set(id, bytes);
    return {
      resourceId: id,
      kind: 'managed-message',
      schemaVersion: 1,
      byteLength: bytes.length,
      digest: createHash('sha256').update(bytes).digest('hex'),
    };
  };
  const batchRef = resource('batch-body', {
    uuid: 'batch',
    type: 'assistant',
    daemonPromptId: 'prompt',
    message: {
      parts: [
        { text: 'Checking the workspace' },
        {
          functionCall: {
            id: 'model-call-1',
            name: 'run_shell_command',
            args: { command: 'secret command' },
          },
        },
        {
          functionCall: {
            id: 'model-call-2',
            name: 'read_file',
            args: { path: '/private/file' },
          },
        },
      ],
    },
  });
  const outcomeRef = resource('outcome-body', {
    ...Object(outcome),
    secret: 'private output',
  });
  const resultRef = resource('result-body', {
    type: 'tool_result',
    daemonPromptId: 'prompt',
    message: {
      parts: [
        {
          functionResponse: {
            id: 'model-call-2',
            name: 'read_file',
            response: { output: 'private file contents' },
          },
        },
      ],
    },
  });
  const events = [
    {
      kind: 'message.committed',
      sequence: 1,
      payload: { messageId: 'batch', role: 'assistant', contentRef: batchRef },
    },
    {
      kind: 'tool.intent',
      sequence: 2,
      payload: {
        executionCallId: 'broker-execution-1',
        batchId: 'batch',
        ordinal: 0,
      },
    },
    {
      kind: 'tool.intent',
      sequence: 3,
      payload: {
        executionCallId: 'broker-execution-2',
        batchId: 'batch',
        ordinal: 1,
      },
    },
    {
      kind: 'tool.receipt',
      sequence: 4,
      payload: {
        executionCallId: 'broker-execution-2',
        toolOutcomeRef: outcomeRef,
      },
    },
    {
      kind: 'message.committed',
      sequence: 5,
      payload: { role: 'tool_result', contentRef: resultRef },
    },
  ] as unknown as ManagedSessionEvent[];
  const read = vi.fn(
    async (ref: ManagedSessionDurableRef) => bodies.get(ref.resourceId)!,
  );
  const session = {
    authority: {
      eventsInSequenceRange: (from: number, through: number) =>
        events.filter(
          (event) => event.sequence >= from && event.sequence <= through,
        ),
    },
    resources: { read },
  } as unknown as Pick<ManagedSession, 'authority' | 'resources'>;
  return { session, events, read };
}

describe('Hosted tool lifecycle metadata', () => {
  it('finishes file tools from committed history when the legacy path has no receipt', async () => {
    const { session, events } = fixture();
    const progress = await hostedToolProgress(session, events[4]);
    expect(progress).toEqual({
      promptId: 'prompt',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'model-call-2',
        name: 'read_file',
        status: 'completed',
      },
    });
    expect(JSON.stringify(progress)).not.toMatch(/private|contents/);
  });
  it('names parallel calls by model IDs and never exposes their arguments or output', async () => {
    const { session, events } = fixture();
    const first = await hostedToolProgress(session, events[1]);
    const second = await hostedToolProgress(session, events[2]);
    expect(first).toEqual({
      promptId: 'prompt',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'model-call-1',
        name: 'run_shell_command',
        status: 'in_progress',
      },
    });
    expect(second?.update).toMatchObject({
      toolCallId: 'model-call-2',
      name: 'read_file',
    });
    const receipt = await hostedToolProgress(session, events[3]);
    expect(receipt?.update).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'model-call-2',
      name: 'read_file',
      status: 'completed',
    });
    expect(JSON.stringify([first, second, receipt])).not.toMatch(
      /secret|private|broker-execution/,
    );
    expect(await hostedToolProgress(session, events[1])).toEqual(first);
  });

  it.each([
    [{ envelope: { executionStatus: 'error' } }, 'failed'],
    [{ envelope: { executionStatus: 'cancelled' } }, 'cancelled'],
    [
      { functionResponse: { response: { executionStatus: 'not_started' } } },
      'failed',
    ],
    [{ executionStatus: 'success' }, 'completed'],
    [
      { functionResponse: { response: { error: 'redacted failure' } } },
      'failed',
    ],
  ])('uses durable terminal status for %j', async (outcome, status) => {
    const { session, events } = fixture(outcome);
    expect((await hostedToolProgress(session, events[3]))?.update.status).toBe(
      status,
    );
  });

  it('does not invent completion for unknown outcomes or unmatched receipts', async () => {
    const { session, events } = fixture({
      envelope: { executionStatus: 'unknown' },
    });
    expect(await hostedToolProgress(session, events[3])).toBeUndefined();
    expect(
      await hostedToolProgress(session, {
        ...events[3],
        payload: { ...events[3].payload, executionCallId: 'another-execution' },
      }),
    ).toBeUndefined();
    expect(
      await hostedToolProgress(session, {
        ...events[1],
        payload: { ...events[1].payload, ordinal: 9 },
      }),
    ).toBeUndefined();
  });

  it('ignores unrelated events without reading resources', async () => {
    const { session, events, read } = fixture();
    expect(await hostedToolProgress(session, events[0])).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });
});
