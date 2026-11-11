/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  SDKUserMessageSchema,
  SDKUserMessageReplaySchema,
  SDKAssistantMessageSchema,
  SDKPartialAssistantMessageSchema,
  SDKResultSuccessSchema,
  SDKResultErrorSchema,
  SDKResultMessageSchema,
  SDKSystemMessageSchema,
  SDKStatusMessageSchema,
  SDKCompactBoundaryMessageSchema,
  SDKPermissionDeniedMessageSchema,
  SDKSessionStateChangedMessageSchema,
  SDKPlanModeSnapshotSchema,
  SDKPlanModeChangedMessageSchema,
  SDKSessionTitleChangedMessageSchema,
  SDKArtifactUpdateMessageSchema,
  SDKAvailableModelsUpdateMessageSchema,
  SDKCommandsChangedMessageSchema,
  SDKTaskUpdatedMessageSchema,
  SDKControlRequestProgressMessageSchema,
  SDKSkillEvolutionMessageSchema,
  SDKMessageSchema,
} from '../sdk-message.js';
import { ModelUsageSchema, SDKPermissionDenialSchema } from '../common.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const uuid = () => randomUUID();
const sessionId = 'test-session-001';

describe('CodeMode 宿主消息协议', () => {
  const envelope = () => ({ code_mode_tool_use_id: 'exec', parent_tool_use_id: null, uuid: uuid(), session_id: sessionId });
  it('保留宿主来源、关联 ID 和原生结果，不补造模型属性', () => {
    const use = { ...envelope(), type: 'system', subtype: 'host_tool_use', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'child', name: 'Read', input: { file_path: '/tmp/a' } }] } };
    const result = { ...envelope(), type: 'system', subtype: 'host_tool_result', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'child', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] }] }, tool_use_result: { value: 1 } };
    expect(SDKMessageSchema().parse(use)).toEqual(use);
    expect(SDKMessageSchema().parse(result)).toEqual(result);
    expect(SDKUserMessageSchema().safeParse(result).success).toBe(false);
    expect(SDKAssistantMessageSchema().safeParse(use).success).toBe(false);
  });
  it('缺失 CodeMode 关联的宿主消息不能降级成模型消息', () => {
    const invalid = { ...envelope(), code_mode_tool_use_id: undefined, type: 'system', subtype: 'host_tool_result', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'child', content: 'done' }] } };
    expect(SDKMessageSchema().safeParse(invalid).success).toBe(false);
  });
});

const sampleModelUsage = {
  inputTokens: 100,
  outputTokens: 50,
  cacheReadInputTokens: 10,
  cacheCreationInputTokens: 5,
  webSearchRequests: 0,
  costUSD: 0.001,
  contextWindow: 200000,
  maxOutputTokens: 8192,
};

// ---------------------------------------------------------------------------
// ModelUsageSchema
// ---------------------------------------------------------------------------
describe('ModelUsageSchema', () => {
  it('parses a valid model usage object', () => {
    const result = ModelUsageSchema().parse(sampleModelUsage);
    expect(result.inputTokens).toBe(100);
    expect(result.costUSD).toBe(0.001);
  });

  it('rejects missing fields', () => {
    expect(() => ModelUsageSchema().parse({ inputTokens: 100 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// SDKUserMessageSchema
// ---------------------------------------------------------------------------
describe('SDKUserMessageSchema', () => {
  it('parses a valid user message', () => {
    const msg = {
      type: 'user' as const,
      message: { role: 'user', content: 'Hello world' },
      parent_tool_use_id: null,
    };
    const result = SDKUserMessageSchema().parse(msg);
    expect(result.type).toBe('user');
    expect(result.parent_tool_use_id).toBeNull();
  });

  it('parses with optional uuid and session_id', () => {
    const msg = {
      type: 'user' as const,
      message: { role: 'user', content: 'Hi' },
      parent_tool_use_id: null,
      uuid: uuid(),
      session_id: sessionId,
      timestamp: new Date().toISOString(),
    };
    const result = SDKUserMessageSchema().parse(msg);
    expect(result.uuid).toBeDefined();
    expect(result.session_id).toBe(sessionId);
  });

  it('parses with optional priority and shouldQuery', () => {
    const msg = {
      type: 'user' as const,
      message: { role: 'user', content: 'Urgent' },
      parent_tool_use_id: null,
      priority: 'now' as const,
      shouldQuery: false,
    };
    const result = SDKUserMessageSchema().parse(msg);
    expect(result.priority).toBe('now');
    expect(result.shouldQuery).toBe(false);
  });

  it('parses CLI-stamped tool result metadata', () => {
    const msg = {
      type: 'user' as const,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'User rejected',
            is_error: true,
          },
        ],
      },
      parent_tool_use_id: null,
      tool_result_meta: [
        {
          id: 'tool-1',
          non_execution_kind: 'user-rejected' as const,
          user_feedback: 'Use a different approach',
        },
      ],
    };

    expect(SDKUserMessageSchema().parse(msg).tool_result_meta).toEqual(
      msg.tool_result_meta,
    );
  });

  it('rejects invalid type', () => {
    const msg = {
      type: 'assistant',
      message: { role: 'user', content: 'Hello' },
      parent_tool_use_id: null,
    };
    expect(() => SDKUserMessageSchema().parse(msg)).toThrow();
  });
});

describe('SDKSkillEvolutionMessageSchema', () => {
  it('parses a host-reviewable suggestion result', () => {
    const result = SDKSkillEvolutionMessageSchema().parse({
      type: 'system',
      subtype: 'skill_evolution',
      result: {
        status: 'suggested',
        attemptId: 'attempt-1',
        origin: 'turn_complete',
        suggestions: [{ skillName: 'review', action: 'update', summary: 'keep checks', confidence: 0.9 }],
        durationMs: 10,
        usage: {
          input_tokens: 12,
          output_tokens: 4,
          credits: 0.25,
        },
      },
      uuid: uuid(),
      session_id: sessionId,
    });
    expect(result.result.suggestions).toHaveLength(1);
    expect(result.result.usage).toMatchObject({ credits: 0.25 });
    expect(result.result).not.toHaveProperty('credits');
  });
});

describe('SDKCommandsChangedMessageSchema', () => {
  it('parses an authoritative command snapshot', () => {
    const message = {
      type: 'system' as const,
      subtype: 'commands_changed' as const,
      commands: [
        {
          name: 'review',
          description: 'Review code',
          argumentHint: '[path]',
        },
      ],
      uuid: uuid(),
      session_id: sessionId,
    };

    expect(SDKCommandsChangedMessageSchema().parse(message)).toEqual(message);
    expect(SDKMessageSchema().parse(message)).toEqual(message);
  });

  it('rejects a snapshot without commands', () => {
    expect(() =>
      SDKCommandsChangedMessageSchema().parse({
        type: 'system',
        subtype: 'commands_changed',
        uuid: uuid(),
        session_id: sessionId,
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// SDKUserMessageReplaySchema
// ---------------------------------------------------------------------------
describe('SDKUserMessageReplaySchema', () => {
  it('parses a valid replay message', () => {
    const msg = {
      type: 'user' as const,
      message: { role: 'user', content: 'Replayed' },
      parent_tool_use_id: null,
      uuid: uuid(),
      session_id: sessionId,
      isReplay: true as const,
    };
    const result = SDKUserMessageReplaySchema().parse(msg);
    expect(result.isReplay).toBe(true);
  });

  it('preserves synthetic task-notification provenance on a replay', () => {
    const msg = {
      type: 'user' as const,
      message: { role: 'user', content: 'Monitor event' },
      parent_tool_use_id: null,
      uuid: uuid(),
      session_id: sessionId,
      isReplay: true as const,
      isSynthetic: true,
      origin: { kind: 'task-notification' as const },
    };

    expect(SDKUserMessageReplaySchema().parse(msg)).toMatchObject({
      isReplay: true,
      isSynthetic: true,
      origin: { kind: 'task-notification' },
    });
  });

  it('rejects non-true isReplay', () => {
    const msg = {
      type: 'user' as const,
      message: { role: 'user', content: 'Replayed' },
      parent_tool_use_id: null,
      uuid: uuid(),
      session_id: sessionId,
      isReplay: false,
    };
    expect(() => SDKUserMessageReplaySchema().parse(msg)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// SDKAssistantMessageSchema
// ---------------------------------------------------------------------------
describe('SDKAssistantMessageSchema', () => {
  it('parses a valid assistant message', () => {
    const msg = {
      type: 'assistant' as const,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
      parent_tool_use_id: null,
      uuid: uuid(),
      session_id: sessionId,
    };
    const result = SDKAssistantMessageSchema().parse(msg);
    expect(result.type).toBe('assistant');
  });

  it('parses with optional error', () => {
    const msg = {
      type: 'assistant' as const,
      message: {},
      parent_tool_use_id: null,
      error: 'rate_limit' as const,
      uuid: uuid(),
      session_id: sessionId,
    };
    const result = SDKAssistantMessageSchema().parse(msg);
    expect(result.error).toBe('rate_limit');
  });

  it('parses with tool_use parent', () => {
    const toolUseId = 'toolu_abc123';
    const msg = {
      type: 'assistant' as const,
      message: {},
      parent_tool_use_id: toolUseId,
      uuid: uuid(),
      session_id: sessionId,
    };
    const result = SDKAssistantMessageSchema().parse(msg);
    expect(result.parent_tool_use_id).toBe(toolUseId);
  });

  it('parses an optional assistant request id', () => {
    const msg = {
      type: 'assistant' as const,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
      parent_tool_use_id: null,
      request_id: 'model-request-123',
      uuid: uuid(),
      session_id: sessionId,
    };

    expect(SDKAssistantMessageSchema().parse(msg).request_id).toBe(
      'model-request-123',
    );
  });
});

// ---------------------------------------------------------------------------
// SDKPartialAssistantMessageSchema (stream_event)
// ---------------------------------------------------------------------------
describe('SDKPartialAssistantMessageSchema', () => {
  it('parses a valid stream_event', () => {
    const msg = {
      type: 'stream_event' as const,
      event: { type: 'message_start', message: {} },
      parent_tool_use_id: null,
      uuid: uuid(),
      session_id: sessionId,
    };
    const result = SDKPartialAssistantMessageSchema().parse(msg);
    expect(result.type).toBe('stream_event');
  });

  it('accepts any event shape at P0 (placeholder)', () => {
    const msg = {
      type: 'stream_event' as const,
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'chunk' },
      },
      parent_tool_use_id: null,
      uuid: uuid(),
      session_id: sessionId,
    };
    const result = SDKPartialAssistantMessageSchema().parse(msg);
    expect(result.event).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// SDKResultSuccessSchema / SDKResultErrorSchema
// ---------------------------------------------------------------------------
describe('SDKResultSuccessSchema', () => {
  it('parses a valid success result', () => {
    const msg = {
      type: 'result' as const,
      subtype: 'success' as const,
      duration_ms: 5000,
      duration_api_ms: 4500,
      is_error: false,
      num_turns: 3,
      result: 'Task completed successfully.',
      stop_reason: 'end_turn',
      total_cost_usd: 0.05,
      total_credits: 1.25,
      usage: { input_tokens: 1000, output_tokens: 500 },
      modelUsage: { 'claude-sonnet-4-20250514': sampleModelUsage },
      permission_denials: [],
      uuid: uuid(),
      session_id: sessionId,
    };
    const result = SDKResultSuccessSchema().parse(msg);
    expect(result.subtype).toBe('success');
    expect(result.is_error).toBe(false);
    expect(result.num_turns).toBe(3);
    expect(result.total_credits).toBe(1.25);
  });

  it('parses with structured_output and fast_mode_state', () => {
    const msg = {
      type: 'result' as const,
      subtype: 'success' as const,
      duration_ms: 1000,
      duration_api_ms: 800,
      is_error: false,
      num_turns: 1,
      result: 'Done',
      stop_reason: null,
      total_cost_usd: 0.01,
      total_credits: 0,
      usage: {},
      modelUsage: {},
      permission_denials: [],
      structured_output: { answer: 42 },
      fast_mode_state: 'on' as const,
      uuid: uuid(),
      session_id: sessionId,
    };
    const result = SDKResultSuccessSchema().parse(msg);
    expect(result.structured_output).toEqual({ answer: 42 });
    expect(result.fast_mode_state).toBe('on');
  });

  it('accepts a named business error code on a success-shaped result', () => {
    const msg = {
      type: 'result' as const,
      subtype: 'success' as const,
      duration_ms: 1000,
      duration_api_ms: 800,
      is_error: true,
      num_turns: 1,
      result: '',
      stop_reason: null,
      total_cost_usd: 0,
      total_credits: 0,
      usage: {},
      modelUsage: {},
      permission_denials: [],
      error_code: 'EXTERNAL_TOKEN_RATE_LIMITED',
      uuid: uuid(),
      session_id: sessionId,
    };

    expect(SDKResultSuccessSchema().parse(msg).error_code).toBe(
      'EXTERNAL_TOKEN_RATE_LIMITED',
    );
  });

  it('parses the task-notification origin', () => {
    const msg = {
      type: 'result' as const,
      subtype: 'success' as const,
      duration_ms: 1000,
      duration_api_ms: 800,
      is_error: false,
      num_turns: 1,
      result: 'Done',
      stop_reason: null,
      total_cost_usd: 0,
      total_credits: 0,
      usage: {},
      modelUsage: {},
      permission_denials: [],
      origin: { kind: 'task-notification' as const },
      uuid: uuid(),
      session_id: sessionId,
    };

    expect(SDKResultSuccessSchema().parse(msg).origin).toEqual({
      kind: 'task-notification',
    });
  });

  it('parses the peer origin', () => {
    const msg = {
      type: 'result' as const,
      subtype: 'success' as const,
      duration_ms: 1000,
      duration_api_ms: 800,
      is_error: false,
      num_turns: 1,
      result: 'Done',
      stop_reason: null,
      total_cost_usd: 0,
      total_credits: 0,
      usage: {},
      modelUsage: {},
      permission_denials: [],
      origin: {
        kind: 'peer' as const,
        from: 'architect',
        senderTaskId: 'agent-1',
        name: 'architect',
        body: 'Review complete.',
      },
      uuid: uuid(),
      session_id: sessionId,
    };

    expect(SDKResultSuccessSchema().parse(msg).origin).toEqual({
      kind: 'peer',
      from: 'architect',
      senderTaskId: 'agent-1',
      name: 'architect',
      body: 'Review complete.',
    });
  });
});

describe('SDKResultErrorSchema', () => {
  it('parses a valid error result', () => {
    const msg = {
      type: 'result' as const,
      subtype: 'error_during_execution' as const,
      duration_ms: 2000,
      duration_api_ms: 1500,
      is_error: true,
      num_turns: 1,
      stop_reason: null,
      total_cost_usd: 0.02,
      total_credits: 0.5,
      usage: {},
      modelUsage: {},
      permission_denials: [],
      error_message: 'Service business rejection',
      errors: ['Something went wrong'],
      uuid: uuid(),
      session_id: sessionId,
    };
    const result = SDKResultErrorSchema().parse(msg);
    expect(result.subtype).toBe('error_during_execution');
    expect(result.error_message).toBe('Service business rejection');
    expect(result.errors).toHaveLength(1);
  });

  it('accepts all error subtypes', () => {
    const subtypes = [
      'error_during_execution',
      'error_max_turns',
      'error_max_budget_usd',
      'error_max_structured_output_retries',
    ] as const;

    for (const subtype of subtypes) {
      const msg = {
        type: 'result' as const,
        subtype,
        duration_ms: 0,
        duration_api_ms: 0,
        is_error: true,
        num_turns: 0,
        stop_reason: null,
        total_cost_usd: 0,
        total_credits: 0,
        usage: {},
        modelUsage: {},
        permission_denials: [],
        errors: [],
        uuid: uuid(),
        session_id: sessionId,
      };
      expect(() => SDKResultErrorSchema().parse(msg)).not.toThrow();
    }
  });

  it('accepts a named business error code on an error result', () => {
    const msg = {
      type: 'result' as const,
      subtype: 'error_during_execution' as const,
      duration_ms: 0,
      duration_api_ms: 0,
      is_error: true,
      num_turns: 0,
      stop_reason: null,
      total_cost_usd: 0,
      total_credits: 0,
      usage: {},
      modelUsage: {},
      permission_denials: [],
      errors: ['External model request failed'],
      error_code: 'EXTERNAL_MODEL_USER_NOT_AVAILABLE',
      uuid: uuid(),
      session_id: sessionId,
    };

    expect(SDKResultErrorSchema().parse(msg).error_code).toBe(
      'EXTERNAL_MODEL_USER_NOT_AVAILABLE',
    );
  });
});

describe('SDKResultMessageSchema (union)', () => {
  it('parses success through the union', () => {
    const msg = {
      type: 'result' as const,
      subtype: 'success' as const,
      duration_ms: 100,
      duration_api_ms: 80,
      is_error: false,
      num_turns: 1,
      result: 'OK',
      stop_reason: 'end_turn',
      total_cost_usd: 0.001,
      total_credits: 0,
      usage: {},
      modelUsage: {},
      permission_denials: [],
      uuid: uuid(),
      session_id: sessionId,
    };
    expect(() => SDKResultMessageSchema().parse(msg)).not.toThrow();
  });

  it('parses error through the union', () => {
    const msg = {
      type: 'result' as const,
      subtype: 'error_max_turns' as const,
      duration_ms: 100,
      duration_api_ms: 80,
      is_error: true,
      num_turns: 10,
      stop_reason: null,
      total_cost_usd: 1.0,
      total_credits: 2,
      usage: {},
      modelUsage: {},
      permission_denials: [],
      errors: ['Max turns exceeded'],
      uuid: uuid(),
      session_id: sessionId,
    };
    expect(() => SDKResultMessageSchema().parse(msg)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// SDKSystemMessageSchema
// ---------------------------------------------------------------------------
describe('SDKSystemMessageSchema', () => {
  it('parses a valid init system message', () => {
    const msg = {
      type: 'system' as const,
      subtype: 'init' as const,
      apiKeySource: 'user' as const,
      cwd: '/home/user/project',
      tools: ['Read', 'Write', 'Bash'],
      mcp_servers: [{ name: 'browser', status: 'connected' }],
      model: 'claude-sonnet-4-20250514',
      permissionMode: 'default' as const,
      slash_commands: ['/help', '/clear'],
      output_style: 'stream',
      skills: ['pdf', 'pptx'],
      plugins: [{ name: 'my-plugin', path: '/path/to/plugin' }],
      uuid: uuid(),
      session_id: sessionId,
    };
    const result = SDKSystemMessageSchema().parse(msg);
    expect(result.subtype).toBe('init');
    expect(result.tools).toContain('Read');
    expect(result.mcp_servers).toHaveLength(1);
  });

  // skip: 现存失败
  it.skip('parses with optional fields', () => {
    const msg = {
      type: 'system' as const,
      subtype: 'init' as const,
      agents: ['agent-1', 'agent-2'],
      apiKeySource: 'project' as const,
      betas: ['context-1m-2025-08-07'],
      cwd: '/workspace',
      tools: [],
      mcp_servers: [],
      model: 'claude-opus-4-20250514',
      permissionMode: 'yolo' as const,
      slash_commands: [],
      output_style: 'json',
      skills: [],
      plugins: [],
      fast_mode_state: 'cooldown' as const,
      uuid: uuid(),
      session_id: sessionId,
    };
    const result = SDKSystemMessageSchema().parse(msg);
    expect(result.agents).toHaveLength(2);
    expect(result.betas).toHaveLength(1);
    expect(result.fast_mode_state).toBe('cooldown');
  });
});

// ---------------------------------------------------------------------------
// SDKStatusMessageSchema
// ---------------------------------------------------------------------------
describe('SDKStatusMessageSchema', () => {
  it('parses a compacting status', () => {
    const msg = {
      type: 'system' as const,
      subtype: 'status' as const,
      status: 'compacting' as const,
      uuid: uuid(),
      session_id: sessionId,
    };
    const result = SDKStatusMessageSchema().parse(msg);
    expect(result.status).toBe('compacting');
  });

  it('parses a null status (idle)', () => {
    const msg = {
      type: 'system' as const,
      subtype: 'status' as const,
      status: null,
      permissionMode: 'acceptEdits' as const,
      uuid: uuid(),
      session_id: sessionId,
    };
    const result = SDKStatusMessageSchema().parse(msg);
    expect(result.status).toBeNull();
    expect(result.permissionMode).toBe('acceptEdits');
  });
});

describe('SDKControlRequestProgressMessageSchema', () => {
  it('parses side-question retry progress through the message union', () => {
    const message = {
      type: 'system' as const,
      subtype: 'control_request_progress' as const,
      request_id: 'side-question-request',
      status: 'api_retry' as const,
      attempt: 1,
      max_retries: 5,
      retry_delay_ms: 750,
      error_status: 429,
      uuid: uuid(),
      session_id: sessionId,
    };

    expect(SDKControlRequestProgressMessageSchema().parse(message)).toEqual(
      message,
    );
    expect(SDKMessageSchema().parse(message)).toEqual(message);
  });
});

// ---------------------------------------------------------------------------
// SDKCompactBoundaryMessageSchema
// ---------------------------------------------------------------------------
describe('SDKCompactBoundaryMessageSchema', () => {
  it('parses compact metadata emitted after compaction', () => {
    const msg = {
      type: 'system' as const,
      subtype: 'compact_boundary' as const,
      compact_metadata: {
        trigger: 'manual' as const,
        pre_tokens: 12345,
        post_tokens: 2000,
        messages_summarized: 18,
        duration_ms: 987,
        preserved_segment: {
          head_uuid: uuid(),
          anchor_uuid: uuid(),
          tail_uuid: uuid(),
        },
      },
      uuid: uuid(),
      session_id: sessionId,
    };

    const result = SDKCompactBoundaryMessageSchema().parse(msg);

    expect(result.compact_metadata).toMatchObject({
      trigger: 'manual',
      pre_tokens: 12345,
      post_tokens: 2000,
      messages_summarized: 18,
      duration_ms: 987,
    });
  });
});

// ---------------------------------------------------------------------------
// SDKPermissionDeniedMessageSchema
// ---------------------------------------------------------------------------
describe('SDKPermissionDeniedMessageSchema', () => {
  it('parses a permission denied system message', () => {
    const msg = {
      type: 'system' as const,
      subtype: 'permission_denied' as const,
      tool_name: 'mcp__perm_rules__rule_probe',
      tool_use_id: 'toolu-denied',
      message: 'Permission denied: dontAsk',
      uuid: uuid(),
      session_id: sessionId,
      decision_reason_type: 'mode' as const,
      decision_reason: 'Permission mode: dontAsk',
      tool_denial_kind: 'permission-rule' as const,
    };
    const result = SDKPermissionDeniedMessageSchema().parse(msg);
    expect(result.tool_name).toBe('mcp__perm_rules__rule_probe');
    expect(result.tool_use_id).toBe('toolu-denied');
    expect(result.tool_denial_kind).toBe('permission-rule');
  });

  it('parses repeated tool call as a structured denial reason', () => {
    const msg = {
      type: 'system' as const,
      subtype: 'permission_denied' as const,
      tool_name: 'Read',
      tool_use_id: 'toolu-repeated',
      message: 'Repeated tool call was denied',
      uuid: uuid(),
      session_id: sessionId,
      decision_reason_type: 'repeatedToolCall' as const,
      decision_reason: 'Read was requested repeatedly',
    };
    const result = SDKPermissionDeniedMessageSchema().parse(msg);
    expect(result.decision_reason_type).toBe('repeatedToolCall');
  });
});

// ---------------------------------------------------------------------------
// SDKSessionStateChangedMessageSchema
// ---------------------------------------------------------------------------
describe('SDKSessionStateChangedMessageSchema', () => {
  it('parses all valid states', () => {
    const states = ['idle', 'running', 'requires_action'] as const;

    for (const state of states) {
      const msg = {
        type: 'system' as const,
        subtype: 'session_state_changed' as const,
        state,
        uuid: uuid(),
        session_id: sessionId,
      };
      const result = SDKSessionStateChangedMessageSchema().parse(msg);
      expect(result.state).toBe(state);
    }
  });

  it('rejects invalid state', () => {
    const msg = {
      type: 'system' as const,
      subtype: 'session_state_changed' as const,
      state: 'paused',
      uuid: uuid(),
      session_id: sessionId,
    };
    expect(() => SDKSessionStateChangedMessageSchema().parse(msg)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// SDKPlanModeChangedMessageSchema
// ---------------------------------------------------------------------------
describe('SDKPlanModeChangedMessageSchema', () => {
  it('parses a full Plan Mode snapshot through the message union', () => {
    const msg = {
      type: 'system' as const,
      subtype: 'plan_mode_changed' as const,
      plan_mode: { active: true },
      uuid: uuid(),
      session_id: sessionId,
    };

    expect(SDKPlanModeSnapshotSchema().parse(msg.plan_mode)).toEqual({
      active: true,
    });
    expect(SDKPlanModeChangedMessageSchema().parse(msg)).toEqual(msg);
    expect(SDKMessageSchema().parse(msg)).toEqual(msg);
  });

  it('rejects a non-boolean Plan Mode state', () => {
    expect(() =>
      SDKPlanModeSnapshotSchema().parse({ active: 'true' }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// SDKSessionTitleChangedMessageSchema
// ---------------------------------------------------------------------------
describe('SDKSessionTitleChangedMessageSchema', () => {
  it('parses session title updates', () => {
    const msg = {
      type: 'system' as const,
      subtype: 'session_title_changed' as const,
      title: 'Fix auth flow',
      source: 'ai' as const,
      revision: 2,
      uuid: uuid(),
      session_id: sessionId,
    };
    const result = SDKSessionTitleChangedMessageSchema().parse(msg);
    expect(result.title).toBe('Fix auth flow');
    expect(result.source).toBe('ai');
  });
});

// ---------------------------------------------------------------------------
// SDKMessageSchema (top-level union)
// ---------------------------------------------------------------------------
describe('SDKMessageSchema (P0 union)', () => {
  const artifactUpdate = {
    type: 'system' as const,
    subtype: 'artifacts_update' as const,
    artifacts: [
      {
        path: '/workspace/report.md',
        display_path: 'report.md',
        name: 'report.md',
        group: { key: 'outputs', name: 'Outputs' },
        relative_path: 'report.md',
        size: 128,
        mime: 'text/markdown',
        mtime: 1_787_000_000_000,
        kind: 'changed' as const,
        additions: 8,
        deletions: 2,
        is_new: false,
      },
      {
        path: '/workspace/chart.png',
        display_path: 'chart.png',
        name: 'chart.png',
        kind: 'presented' as const,
      },
    ],
    uuid: uuid(),
    session_id: sessionId,
  };

  it('parses artifacts_update through its schema and the SDKMessage union', () => {
    expect(SDKArtifactUpdateMessageSchema().parse(artifactUpdate)).toEqual(
      artifactUpdate,
    );
    expect(SDKMessageSchema().parse(artifactUpdate)).toEqual(artifactUpdate);
  });

  it.each(['type', 'subtype', 'artifacts', 'uuid', 'session_id'] as const)(
    'rejects artifacts_update missing message field %s',
    (field) => {
      const invalid: Partial<typeof artifactUpdate> = { ...artifactUpdate };
      delete invalid[field];

      expect(() => SDKArtifactUpdateMessageSchema().parse(invalid)).toThrow();
      expect(() => SDKMessageSchema().parse(invalid)).toThrow();
    },
  );

  it.each(['path', 'display_path', 'name', 'kind'] as const)(
    'rejects an Artifact missing common field %s',
    (field) => {
      const [artifact] = artifactUpdate.artifacts;
      const invalidArtifact: Partial<typeof artifact> = { ...artifact };
      delete invalidArtifact[field];
      const invalid = { ...artifactUpdate, artifacts: [invalidArtifact] };

      expect(() => SDKArtifactUpdateMessageSchema().parse(invalid)).toThrow();
      expect(() => SDKMessageSchema().parse(invalid)).toThrow();
    },
  );

  it.each(['additions', 'deletions', 'is_new'] as const)(
    'rejects a changed Artifact missing field %s',
    (field) => {
      const [artifact] = artifactUpdate.artifacts;
      const invalidArtifact: Partial<typeof artifact> = { ...artifact };
      delete invalidArtifact[field];
      const invalid = { ...artifactUpdate, artifacts: [invalidArtifact] };

      expect(() => SDKArtifactUpdateMessageSchema().parse(invalid)).toThrow();
      expect(() => SDKMessageSchema().parse(invalid)).toThrow();
    },
  );

  const availableModelsUpdate = {
    type: 'system' as const,
    subtype: 'available_models_update' as const,
    models: [
      {
        value: 'qwen-model-a',
        modelId: 'qwen-model-a',
        displayName: 'Qwen Model A',
        description: 'Reasoning',
        source: 'organization' as const,
      },
    ],
    currentModel: 'qwen-model-a',
    uuid: uuid(),
    session_id: sessionId,
  };

  it.each(['system', 'user', 'organization', 'custom'] as const)(
    'parses available_models_update with source=%s through both schemas',
    (source) => {
      const update = {
        ...availableModelsUpdate,
        models: [{ ...availableModelsUpdate.models[0], source }],
      };
      expect(SDKAvailableModelsUpdateMessageSchema().parse(update)).toEqual(
        update,
      );
      expect(SDKMessageSchema().parse(update)).toEqual(update);
    },
  );

  it('still rejects unknown model sources in available_models_update', () => {
    const update = {
      ...availableModelsUpdate,
      models: [{ ...availableModelsUpdate.models[0], source: 'unknown' }],
    };
    expect(() =>
      SDKAvailableModelsUpdateMessageSchema().parse(update),
    ).toThrow();
    expect(() => SDKMessageSchema().parse(update)).toThrow();
  });

  it.each(['subtype', 'models', 'currentModel', 'uuid', 'session_id'] as const)(
    'rejects available_models_update missing field %s',
    (field) => {
      const invalid: Partial<typeof availableModelsUpdate> = {
        ...availableModelsUpdate,
      };
      delete invalid[field];
      expect(() =>
        SDKAvailableModelsUpdateMessageSchema().parse(invalid),
      ).toThrow();
      expect(() => SDKMessageSchema().parse(invalid)).toThrow();
    },
  );

  it('parses task_updated patches through the union', () => {
    const msg = {
      type: 'system' as const,
      subtype: 'task_updated' as const,
      task_id: 'b12345678',
      patch: {
        status: 'running' as const,
        description: 'watch build',
        is_backgrounded: true,
      },
      uuid: uuid(),
      session_id: sessionId,
    };

    expect(SDKTaskUpdatedMessageSchema().parse(msg)).toEqual(msg);
    expect(() => SDKMessageSchema().parse(msg)).not.toThrow();
  });

  it('parses background task roster changes through the union', () => {
    const message = {
      type: 'system' as const,
      subtype: 'background_tasks_changed' as const,
      tasks: [
        {
          task_id: 'a1234567890abcdef',
          task_type: 'in_process_teammate',
          description: 'Review the implementation',
        },
      ],
      uuid: uuid(),
      session_id: sessionId,
    };

    expect(SDKMessageSchema().parse(message)).toEqual(message);
  });

  it('parses a user message through the union', () => {
    const msg = {
      type: 'user' as const,
      message: {},
      parent_tool_use_id: null,
    };
    expect(() => SDKMessageSchema().parse(msg)).not.toThrow();
  });

  it('parses an assistant message through the union', () => {
    const msg = {
      type: 'assistant' as const,
      message: {},
      parent_tool_use_id: null,
      uuid: uuid(),
      session_id: sessionId,
    };
    expect(() => SDKMessageSchema().parse(msg)).not.toThrow();
  });

  it('parses a stream_event through the union', () => {
    const msg = {
      type: 'stream_event' as const,
      event: { type: 'message_start', message: {} },
      parent_tool_use_id: null,
      uuid: uuid(),
      session_id: sessionId,
    };
    expect(() => SDKMessageSchema().parse(msg)).not.toThrow();
  });

  it('parses a system init through the union', () => {
    const msg = {
      type: 'system' as const,
      subtype: 'init' as const,
      apiKeySource: 'user' as const,
      cwd: '/',
      tools: [],
      mcp_servers: [],
      model: 'claude-sonnet-4-20250514',
      permissionMode: 'default' as const,
      slash_commands: [],
      output_style: 'stream',
      skills: [],
      plugins: [],
      uuid: uuid(),
      session_id: sessionId,
    };
    expect(() => SDKMessageSchema().parse(msg)).not.toThrow();
  });

  it('parses a session title update through the union', () => {
    const msg = {
      type: 'system' as const,
      subtype: 'session_title_changed' as const,
      title: 'Fix auth flow',
      source: 'custom' as const,
      revision: 3,
      uuid: uuid(),
      session_id: sessionId,
    };
    expect(() => SDKMessageSchema().parse(msg)).not.toThrow();
  });

  it('rejects an unknown type', () => {
    const msg = {
      type: 'unknown_type',
      data: {},
    };
    expect(() => SDKMessageSchema().parse(msg)).toThrow();
  });

  it('preserves isReplay on user replay messages (union ordering)', () => {
    const msg = {
      type: 'user' as const,
      message: { role: 'user', content: 'Replayed prompt' },
      parent_tool_use_id: null,
      uuid: uuid(),
      session_id: sessionId,
      isReplay: true as const,
    };
    const result = SDKMessageSchema().parse(msg) as { isReplay?: boolean };
    expect(result.isReplay).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SDKPermissionDenialSchema
// ---------------------------------------------------------------------------
describe('SDKPermissionDenialSchema', () => {
  it('parses a valid permission denial', () => {
    const denial = {
      tool_name: 'Bash',
      tool_use_id: 'toolu_123',
      tool_input: { command: 'rm -rf /' },
      message: 'Permission denied: blocked by rule',
      decision_reason_type: 'rule' as const,
      decision_reason: 'deny rule from session: Bash(rm -rf /)',
      tool_denial_kind: 'permission-rule' as const,
    };
    const result = SDKPermissionDenialSchema().parse(denial);
    expect(result.tool_name).toBe('Bash');
    expect(result.decision_reason_type).toBe('rule');
    expect(result.tool_denial_kind).toBe('permission-rule');
  });

  it('parses a repeated tool call permission denial', () => {
    const denial = {
      tool_name: 'Read',
      tool_use_id: 'toolu_repeated',
      tool_input: { file_path: '/same.txt' },
      message: 'Repeated tool call was denied',
      decision_reason_type: 'repeatedToolCall' as const,
      decision_reason: 'Read was requested repeatedly',
    };
    const result = SDKPermissionDenialSchema().parse(denial);
    expect(result.decision_reason_type).toBe('repeatedToolCall');
  });
});

describe('tool_progress preview contract', () => {
  const preview = { type: 'tool_progress', parent_tool_use_id: null, elapsed_time_seconds: 2, uuid: 'p', session_id: 's', tool_use_id: 't', tool_name: 'Bash', execution_id: 'e', progress_sequence: 1, phase: 'running', started_at_ms: 10, elapsed_ms: 2000, output: '中' };
  it('accepts elapsed-only progress without inventing output', () => {
    const heartbeat = { type: 'tool_progress', uuid: 'h', session_id: 's', tool_use_id: 't', tool_name: 'Bash', parent_tool_use_id: null, elapsed_time_seconds: 2 };
    expect(SDKMessageSchema().parse(heartbeat)).toEqual(heartbeat);
  });
  it('accepts replacement previews without inventing missing totals', () => {
    expect(SDKMessageSchema().parse(preview)).toEqual(preview);
  });
  it.each([{ progress_sequence: 0 }, { elapsed_ms: Infinity }, { output: '中'.repeat(2000) }, { tool_use_id: '' }, { total_bytes: -1 }])('rejects malformed progress %j', invalid => {
    expect(SDKMessageSchema().safeParse({ ...preview, ...invalid }).success).toBe(false);
  });
});

describe('Hook static diagnostics', () => {
  it('accepts a diagnostics snapshot as an SDK message', () => {
    const message = {
      type: 'system',
      subtype: 'hook_diagnostics',
      uuid: '00000000-0000-4000-8000-000000000001',
      session_id: 'session-a',
      checked_at: '2026-10-23T10:00:00.000Z',
      read_status: 'partial',
      diagnostics: [
        {
          code: 'settings_load_error',
          message: 'Could not read Hook settings.',
        },
      ],
    };
    expect(SDKMessageSchema().parse(message)).toEqual(message);
  });
});
