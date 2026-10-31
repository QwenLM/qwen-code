/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import type { ManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { ManagedToolStage } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-stage-record.js';
import type { HostedWorkspaceBroker } from './hosted-workspace-broker.js';
import { expandHostedExtensionCommand } from './hosted-extension-command.js';

function fixture(prompt: string) {
  const bytes = new Map<string, Buffer>();
  const records = new Map<
    string,
    {
      record: ManagedToolStage;
      revision: number;
      recordRef: ManagedSessionDurableRef;
      operationId: string;
    }
  >();
  const publish = async (kind: string, content: Buffer) => {
    const digest = createHash('sha256').update(content).digest('hex');
    const resourceId = `resource-${bytes.size}`;
    bytes.set(resourceId, content);
    return {
      kind,
      resourceId,
      schemaVersion: 1,
      byteLength: content.length,
      digest,
    };
  };
  const session = {
    resources: {
      publish,
      read: async (ref: ManagedSessionDurableRef) => bytes.get(ref.resourceId)!,
    },
    authority: {
      sessionHeader: {
        sessionKey: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          sessionId: 'session',
        },
      },
      extensionRecord: (_domain: string, id: string) => records.get(id),
      commitExtensionRecord: async (
        _command: unknown,
        request: { record: ManagedToolStage },
      ) => {
        const previous = records.get(request.record.toolStageId);
        const recordRef = await publish(
          'managed-tool_stage',
          Buffer.from(JSON.stringify(request.record)),
        );
        records.set(request.record.toolStageId, {
          record: request.record,
          recordRef,
          revision: (previous?.revision ?? 0) + 1,
          operationId: request.record.toolStageId,
        });
      },
      issueOperationGrant: vi.fn((request: Record<string, unknown>) => request),
    },
  } as unknown as ManagedSession;
  const control = vi.fn(async () => ({
    state: 'settled',
    result: { executionStatus: 'success', responseParts: [{ text: 'RESULT' }] },
  }));
  const broker = {
    runtimeSessionId: 'owner',
    runtime: {
      bindingId: 'binding',
      generation: '1',
      workspaceGeneration: '1',
    },
    extensionCommand: control,
  } as unknown as HostedWorkspaceBroker;
  const decide = vi.fn(
    async (
      _id: string,
      toolName: 'read_file' | 'shell',
      input: Record<string, unknown>,
    ) => ({
      allowed: true,
      toolName,
      input,
      approvalMode: 'default' as const,
      preHookOccurrence: null,
      permissionHookOccurrence: null,
      actionRequestId: null,
    }),
  );
  const completed = vi.fn(async () => undefined);
  const options = {
    session,
    broker,
    promptId: 'prompt',
    callId: 'call',
    revision: 1,
    command: {
      name: 'sample:run',
      description: 'Run sample',
      prompt,
      extensionId: 'sample',
      modelInvocable: true,
    },
    args: 'hello; $(touch /tmp/never)',
    signal: new AbortController().signal,
    definitionDigest: () => 'a'.repeat(64),
    decide,
    completed,
  };
  return { options, records, control, decide, completed };
}

describe('Hosted durable command expansion', () => {
  it('expands pure prompt arguments without starting Runtime work', async () => {
    const context = fixture('Review {{args}}');
    const prompt = await expandHostedExtensionCommand(context.options);
    expect(prompt).toContain('Review hello; $(touch /tmp/never)');
    expect(context.decide).not.toHaveBeenCalled();
    expect(context.control).not.toHaveBeenCalled();
  });

  it('escapes arguments inside Shell and reuses the committed result', async () => {
    const context = fixture('Before !{printf %s {{args}}} after');
    expect(await expandHostedExtensionCommand(context.options)).toContain(
      'Before RESULT after',
    );
    expect(context.decide.mock.calls[0]?.[2]).toMatchObject({
      command: "printf %s 'hello; $(touch /tmp/never)'",
    });
    const stage = [...context.records.values()][0]!.record;
    expect(stage.run.state).toBe('settled');
    expect(stage.permissionRef).not.toBeNull();
    expect(await expandHostedExtensionCommand(context.options)).toContain(
      'Before RESULT after',
    );
    expect(context.control).toHaveBeenCalledTimes(1);
    expect(context.decide).toHaveBeenCalledTimes(1);
  });

  it('queries an unknown original step without dispatching it again', async () => {
    const context = fixture('!{pwd}');
    context.control.mockResolvedValueOnce({
      state: 'outcome_unknown',
    } as never);
    await expect(expandHostedExtensionCommand(context.options)).rejects.toThrow(
      'outcome is unknown',
    );
    expect(await expandHostedExtensionCommand(context.options)).toContain(
      'RESULT',
    );
    expect(
      context.control.mock.calls.map(
        (call) => (call as unknown as [{ action: string }])[0].action,
      ),
    ).toEqual(['execute', 'status']);
    expect(context.decide).toHaveBeenCalledTimes(1);
  });

  it('keeps quoted Shell placeholders literal', async () => {
    const context = fixture('!{printf "%s" "{{args}}"}');
    await expandHostedExtensionCommand(context.options);
    expect(context.decide.mock.calls[0]?.[2]).toMatchObject({
      command: 'printf "%s" "hello; \\$(touch /tmp/never)"',
    });
  });
});
