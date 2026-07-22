/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HookHandler, type RuntimeGatewayClient } from './hook-handler.js';
import { AgentStateStore } from './state-store.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

class RecordingGateway implements RuntimeGatewayClient {
  readonly calls: {
    path: string;
    value?: unknown;
    operationId: string;
  }[] = [];
  sessionContextResponse: unknown = {
    policy_version: 5,
    system_context: 'Signed organization policy',
  };
  turnOpenResponse: unknown = {
    turn_id: 'ea09a5be-4e32-48cb-b76d-d513492d9c82',
    memories: [{ id: '5f2d8477-fcb3-481b-a5aa-859c3d696bd1' }],
    additional_context: '<enterprise_memory_reference_data />',
  };

  async post<T>(path: string, value: unknown, operationId: string): Promise<T> {
    this.calls.push({ path, value, operationId });
    if (path === '/v1/runtime/session-context') {
      return this.sessionContextResponse as T;
    }
    if (path === '/v1/runtime/turns:open') {
      return this.turnOpenResponse as T;
    }
    return { accepted: true } as T;
  }

  async get<T>(path: string, operationId: string): Promise<T> {
    this.calls.push({ path, operationId });
    return {} as T;
  }
}

async function fixture(): Promise<{
  gateway: RecordingGateway;
  handler: HookHandler;
  states: AgentStateStore;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), 'qwen-memory-hook-'));
  directories.push(directory);
  const gateway = new RecordingGateway();
  const states = new AgentStateStore(directory);
  return { gateway, states, handler: new HookHandler(gateway, states) };
}

const common = {
  session_id: 'session-a',
  timestamp: '2026-07-22T00:00:00.000Z',
};

describe('HookHandler', () => {
  it('injects signed policy only through SessionStart output', async () => {
    const { gateway, handler, states } = await fixture();

    await expect(
      handler.handle({
        ...common,
        hook_event_name: 'SessionStart',
        source: 'startup',
        model: 'qwen3-coder',
        permission_mode: 'default',
      }),
    ).resolves.toEqual({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'Signed organization policy',
      },
    });
    expect(gateway.calls[0]?.path).toBe('/v1/runtime/session-context');
    expect(
      (await states.read(common.session_id)).pendingOperationId,
    ).toBeUndefined();
  });

  it('supports branch session starts from Qwen Code', async () => {
    const { handler } = await fixture();

    await expect(
      handler.handle({
        ...common,
        hook_event_name: 'SessionStart',
        source: 'branch',
        model: 'qwen3-coder',
        permission_mode: 'default',
      }),
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        additionalContext: 'Signed organization policy',
      },
    });
  });

  it('opens a turn, injects bounded reference context, and persists only metadata', async () => {
    const { handler, states } = await fixture();

    const output = await handler.handle({
      ...common,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'How should I build this repository?',
    });

    expect(output).toEqual({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: '<enterprise_memory_reference_data />',
      },
    });
    const state = await states.read(common.session_id);
    expect(state).toMatchObject({
      turnId: 'ea09a5be-4e32-48cb-b76d-d513492d9c82',
    });
    expect(state.pendingOperationId).toBeUndefined();
  });

  it('rejects an invalid Gateway context response before persisting turn state', async () => {
    const { gateway, handler, states } = await fixture();
    gateway.turnOpenResponse = {
      turn_id: 'not-a-uuid',
      additional_context: 'x'.repeat(6_001),
    };

    await expect(
      handler.handle({
        ...common,
        hook_event_name: 'UserPromptSubmit',
        prompt: 'How should I build this repository?',
      }),
    ).rejects.toThrow();
    expect((await states.read(common.session_id)).turnId).toBeUndefined();
  });

  it('sends allowlisted tool metadata without tool input or output', async () => {
    const { gateway, handler, states } = await fixture();

    await handler.handle({
      ...common,
      hook_event_name: 'PostToolUse',
      tool_name: 'read_file',
      tool_use_id: 'tool-a',
      tool_input: { path: '/secret' },
      tool_response: 'sensitive file content',
    });

    const value = gateway.calls[0]?.value as {
      payload: Record<string, unknown>;
    };
    expect(value.payload).toEqual({
      tool_name: 'read_file',
      tool_use_id: 'tool-a',
      status: 'succeeded',
      is_interrupt: false,
    });
    expect(JSON.stringify(value)).not.toContain('sensitive file content');
    expect(JSON.stringify(value)).not.toContain('/secret');
    expect(
      (await states.read(common.session_id)).pendingOperationId,
    ).toBeUndefined();
  });

  it('retries the same hook operation against its originally captured turn', async () => {
    const { gateway, handler } = await fixture();
    await handler.handle({
      ...common,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'First turn',
    });
    const toolEvent = {
      ...common,
      hook_event_name: 'PostToolUse',
      tool_name: 'read_file',
      tool_use_id: 'tool-a',
    };
    await handler.handle(toolEvent);
    gateway.turnOpenResponse = {
      turn_id: '8d39189f-cb3d-4a18-bd43-52f7bf9014e9',
      additional_context: '',
    };
    await handler.handle({
      ...common,
      timestamp: '2026-07-22T00:00:01.000Z',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Second turn',
    });
    await handler.handle(toolEvent);

    expect(gateway.calls[1]?.operationId).toBe(gateway.calls[3]?.operationId);
    expect(gateway.calls[1]?.value).toEqual(gateway.calls[3]?.value);
    expect(gateway.calls[3]?.value).toMatchObject({
      turn_id: 'ea09a5be-4e32-48cb-b76d-d513492d9c82',
    });
  });

  it('does not roll current state back when an old prompt retry arrives late', async () => {
    const { gateway, handler, states } = await fixture();
    const firstPrompt = {
      ...common,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'First turn',
    };
    await handler.handle(firstPrompt);
    gateway.turnOpenResponse = {
      turn_id: '8d39189f-cb3d-4a18-bd43-52f7bf9014e9',
      additional_context: '',
    };
    await handler.handle({
      ...common,
      timestamp: '2026-07-22T00:00:01.000Z',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Second turn',
    });
    gateway.turnOpenResponse = {
      turn_id: 'ea09a5be-4e32-48cb-b76d-d513492d9c82',
      additional_context: '',
    };

    await handler.handle(firstPrompt);

    expect((await states.read(common.session_id)).turnId).toBe(
      '8d39189f-cb3d-4a18-bd43-52f7bf9014e9',
    );
  });

  it('reports Stop without requesting a blocking loop', async () => {
    const { gateway, handler } = await fixture();

    await expect(
      handler.handle({
        ...common,
        hook_event_name: 'Stop',
        last_assistant_message: 'Final response',
      }),
    ).resolves.toEqual({ continue: true });
    expect(gateway.calls[0]?.value).toMatchObject({
      event_kind: 'stop',
      payload: { assistant: 'Final response' },
    });
  });

  it('reports the stable StopFailure error class without error details', async () => {
    const { gateway, handler } = await fixture();

    await handler.handle({
      ...common,
      hook_event_name: 'StopFailure',
      error: 'server_error',
      error_details: 'Connection reset while handling secret-value',
    });

    expect(gateway.calls[0]?.value).toMatchObject({
      event_kind: 'stop_failure',
      payload: { error_class: 'server_error' },
    });
    expect(JSON.stringify(gateway.calls[0]?.value)).not.toContain(
      'secret-value',
    );
  });
});
