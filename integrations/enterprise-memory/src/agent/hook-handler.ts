/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import type { AgentStateStore } from './state-store.js';

export interface RuntimeGatewayClient {
  post<T>(path: string, value: unknown, operationId: string): Promise<T>;
  get<T>(path: string, operationId: string): Promise<T>;
}

const commonSchema = z.object({
  session_id: z.string().min(1).max(256),
  hook_event_name: z.enum([
    'SessionStart',
    'UserPromptSubmit',
    'PostToolUse',
    'PostToolUseFailure',
    'Stop',
    'StopFailure',
  ]),
  timestamp: z.string().datetime(),
});
const sessionContextResponseSchema = z
  .object({ system_context: z.string().max(4_000) })
  .passthrough();
const turnOpenResponseSchema = z
  .object({
    turn_id: z.string().uuid(),
    additional_context: z.string().max(6_000),
  })
  .passthrough();

export type HookOutput = Record<string, unknown> | null;

export class HookHandler {
  constructor(
    private readonly gateway: RuntimeGatewayClient,
    private readonly states: AgentStateStore,
  ) {}

  async handle(value: unknown): Promise<HookOutput> {
    const common = commonSchema.passthrough().parse(value);
    switch (common.hook_event_name) {
      case 'SessionStart':
        return this.sessionStart(common);
      case 'UserPromptSubmit':
        return this.userPromptSubmit(common);
      case 'PostToolUse':
        await this.toolEvent(common, false);
        return null;
      case 'PostToolUseFailure':
        await this.toolEvent(common, true);
        return null;
      case 'Stop':
        await this.stop(common);
        return { continue: true };
      case 'StopFailure':
        await this.stopFailure(common);
        return null;
    }
  }

  private async sessionStart(
    input: typeof commonSchema._output,
  ): Promise<HookOutput> {
    const event = commonSchema
      .extend({
        source: z.enum(['startup', 'resume', 'clear', 'compact', 'branch']),
        model: z.string().min(1).max(256),
        permission_mode: z.string().min(1).max(64),
      })
      .passthrough()
      .parse(input);
    const request = {
      session_id: event.session_id,
      source: event.source,
      model: event.model,
      permission_mode: event.permission_mode,
    };
    const operationId = await this.states.beginOperation(event.session_id, [
      'hook-v1',
      event.hook_event_name,
      event.timestamp,
      request,
    ]);
    const result = sessionContextResponseSchema.parse(
      await this.gateway.post<unknown>(
        '/v1/runtime/session-context',
        request,
        operationId,
      ),
    );
    await this.states.completeOperation(event.session_id, operationId);
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: result.system_context,
      },
    };
  }

  private async userPromptSubmit(
    input: typeof commonSchema._output,
  ): Promise<HookOutput> {
    const event = commonSchema
      .extend({ prompt: z.string().max(64_000) })
      .passthrough()
      .parse(input);
    const request = {
      session_id: event.session_id,
      occurred_at: event.timestamp,
      prompt: event.prompt,
    };
    const operation = await this.states.beginOperationWithState(
      event.session_id,
      ['hook-v1', event.hook_event_name, request],
    );
    const operationId = operation.operationId;
    const result = turnOpenResponseSchema.parse(
      await this.gateway.post<unknown>(
        '/v1/runtime/turns:open',
        { event_id: operationId, ...request },
        operationId,
      ),
    );
    await this.states.update(event.session_id, (state) => {
      const canAdvanceTurn =
        state.turnId === operation.turnId || state.turnId === result.turn_id;
      return {
        ...state,
        turnId: canAdvanceTurn ? result.turn_id : state.turnId,
        pendingOperationId:
          state.pendingOperationId === operationId
            ? undefined
            : state.pendingOperationId,
      };
    });
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: result.additional_context,
      },
    };
  }

  private async toolEvent(
    input: typeof commonSchema._output,
    failed: boolean,
  ): Promise<void> {
    const event = commonSchema
      .extend({
        tool_name: z.enum([
          'read_file',
          'grep_search',
          'glob',
          'list_directory',
          'write_file',
          'edit',
          'notebook_edit',
          'run_shell_command',
        ]),
        tool_use_id: z.string().min(1).max(256),
        is_interrupt: z.boolean().optional(),
      })
      .passthrough()
      .parse(input);
    const eventKind = failed ? 'tool_failure' : 'tool_success';
    const payload = {
      tool_name: event.tool_name,
      tool_use_id: event.tool_use_id,
      status: failed ? 'failed' : 'succeeded',
      is_interrupt: event.is_interrupt ?? false,
    };
    const { operationId, turnId } = await this.states.beginOperationWithState(
      event.session_id,
      ['hook-v1', event.hook_event_name, event.timestamp, eventKind, payload],
    );
    await this.gateway.post(
      '/v1/runtime/turn-events',
      {
        event_id: operationId,
        session_id: event.session_id,
        turn_id: turnId,
        event_kind: eventKind,
        occurred_at: event.timestamp,
        payload,
      },
      operationId,
    );
    await this.states.completeOperation(event.session_id, operationId);
  }

  private async stop(input: typeof commonSchema._output): Promise<void> {
    const event = commonSchema
      .extend({ last_assistant_message: z.string().max(64_000) })
      .passthrough()
      .parse(input);
    const payload = { assistant: event.last_assistant_message };
    const { operationId, turnId } = await this.states.beginOperationWithState(
      event.session_id,
      ['hook-v1', event.hook_event_name, event.timestamp, payload],
    );
    await this.gateway.post(
      '/v1/runtime/turn-events',
      {
        event_id: operationId,
        session_id: event.session_id,
        turn_id: turnId,
        event_kind: 'stop',
        occurred_at: event.timestamp,
        payload,
      },
      operationId,
    );
    await this.states.completeOperation(event.session_id, operationId);
  }

  private async stopFailure(input: typeof commonSchema._output): Promise<void> {
    const event = commonSchema
      .extend({
        error: z.enum([
          'rate_limit',
          'authentication_failed',
          'billing_error',
          'invalid_request',
          'server_error',
          'max_output_tokens',
          'unknown',
        ]),
      })
      .passthrough()
      .parse(input);
    const payload = { error_class: event.error };
    const { operationId, turnId } = await this.states.beginOperationWithState(
      event.session_id,
      ['hook-v1', event.hook_event_name, event.timestamp, payload],
    );
    await this.gateway.post(
      '/v1/runtime/turn-events',
      {
        event_id: operationId,
        session_id: event.session_id,
        turn_id: turnId,
        event_kind: 'stop_failure',
        occurred_at: event.timestamp,
        payload,
      },
      operationId,
    );
    await this.states.completeOperation(event.session_id, operationId);
  }
}
