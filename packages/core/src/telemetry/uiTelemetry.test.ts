/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UiTelemetryService, MAIN_SOURCE } from './uiTelemetry.js';
import { ToolCallDecision } from './tool-call-decision.js';
import type { ApiErrorEvent, ApiResponseEvent } from './types.js';
import { ToolCallEvent } from './types.js';
import {
  EVENT_API_ERROR,
  EVENT_API_RESPONSE,
  EVENT_TOOL_CALL,
} from './constants.js';
import type {
  CancelledToolCall,
  CompletedToolCall,
  ErroredToolCall,
  SuccessfulToolCall,
} from '../core/coreToolScheduler.js';
import { ToolErrorType } from '../tools/tool-error.js';
import { ToolConfirmationOutcome } from '../tools/tools.js';
import { MockTool } from '../test-utils/mock-tool.js';

const createFakeCompletedToolCall = (
  name: string,
  success: boolean | 'cancelled',
  duration = 100,
  outcome?: ToolConfirmationOutcome,
  error?: Error,
): CompletedToolCall => {
  const request = {
    callId: `call_${name}_${Date.now()}`,
    name,
    args: { foo: 'bar' },
    isClientInitiated: false,
    prompt_id: 'prompt-id-1',
  };
  const tool = new MockTool({ name });
  const respond = (
    response: Record<string, unknown>,
    err: Error | undefined,
    errorType: ToolErrorType | undefined,
    resultDisplay: string,
  ) => ({
    callId: request.callId,
    responseParts: [
      { functionResponse: { id: request.callId, name, response } },
    ],
    error: err,
    errorType,
    resultDisplay,
  });

  if (success === true) {
    return {
      status: 'success',
      request,
      tool,
      invocation: tool.build({ param: 'test' }),
      response: respond(
        { output: 'Success!' },
        undefined,
        undefined,
        'Success!',
      ),
      durationMs: duration,
      outcome,
    } as SuccessfulToolCall;
  } else if (success === 'cancelled') {
    return {
      status: 'cancelled',
      request,
      tool,
      invocation: tool.build({ param: 'test' }),
      response: respond(
        { error: 'Tool cancelled' },
        new Error('Tool cancelled'),
        ToolErrorType.UNKNOWN,
        'Cancelled!',
      ),
      durationMs: duration,
      outcome,
    } as CancelledToolCall;
  } else {
    return {
      status: 'error',
      request,
      tool,
      response: respond(
        { error: 'Tool failed' },
        error || new Error('Tool failed'),
        ToolErrorType.UNKNOWN,
        'Failure!',
      ),
      durationMs: duration,
      outcome,
    } as ErroredToolCall;
  }
};

const fakeToolEvent = (
  ...args: Parameters<typeof createFakeCompletedToolCall>
) => new ToolCallEvent(createFakeCompletedToolCall(...args));

/** A ToolCallEvent as the telemetry pipeline delivers it. */
const toolEvent = (event: ToolCallEvent, extra: Record<string, unknown> = {}) =>
  ({
    ...structuredClone(event),
    'event.name': EVENT_TOOL_CALL,
    ...extra,
  }) as ToolCallEvent & { 'event.name': typeof EVENT_TOOL_CALL };

const makeToolEvent = (name: string) =>
  ({
    'event.name': EVENT_TOOL_CALL,
    function_name: name,
    duration_ms: 50,
    success: true,
    decision: ToolCallDecision.AUTO_ACCEPT,
    prompt_id: 'p1',
  }) as ToolCallEvent & { 'event.name': typeof EVENT_TOOL_CALL };

/** An API response event; `tokens` is [input, output, total, cached, thoughts]. */
const apiResponse = (
  model: string,
  duration_ms: number,
  [input, output, total, cached, thoughts]: number[],
  extra: Record<string, unknown> = {},
) =>
  ({
    'event.name': EVENT_API_RESPONSE,
    model,
    duration_ms,
    input_token_count: input,
    output_token_count: output,
    total_token_count: total,
    cached_content_token_count: cached,
    thoughts_token_count: thoughts,
    ...extra,
  }) as ApiResponseEvent & { 'event.name': typeof EVENT_API_RESPONSE };

const proResponse = () =>
  apiResponse('gemini-2.5-pro', 500, [10, 20, 30, 5, 2]);

const makeApiEvent = (
  model: string,
  inputTokens: number,
  extra?: Record<string, unknown>,
) => apiResponse(model, 100, [inputTokens, 10, inputTokens + 10, 0, 0], extra);

const apiError = (
  model: string,
  duration_ms: number,
  error_message: string,
  extra: Record<string, unknown> = {},
) =>
  ({
    'event.name': EVENT_API_ERROR,
    model,
    duration_ms,
    error_message,
    ...extra,
  }) as ApiErrorEvent & { 'event.name': typeof EVENT_API_ERROR };

const decisions = (overrides: Record<string, number> = {}) => ({
  [ToolCallDecision.ACCEPT]: 0,
  [ToolCallDecision.REJECT]: 0,
  [ToolCallDecision.MODIFY]: 0,
  [ToolCallDecision.AUTO_ACCEPT]: 0,
  ...overrides,
});

const skillTotals = (
  totalCalls: number,
  totalSuccess: number,
  totalFail: number,
  byName: Record<string, unknown> = {},
) => ({ totalCalls, totalSuccess, totalFail, byName });

/** Expected model entry when every call came from the main agent. */
const mainOnly = (
  [totalRequests, totalErrors, totalLatencyMs]: number[],
  [prompt, candidates, total, cached, thoughts]: number[],
) => {
  const aggregate = {
    api: { totalRequests, totalErrors, totalLatencyMs },
    tokens: { prompt, candidates, total, cached, thoughts },
  };
  return { ...aggregate, bySource: { [MAIN_SOURCE]: aggregate } };
};

describe('UiTelemetryService', () => {
  let service: UiTelemetryService;
  const addToolCall = (
    ...args: Parameters<typeof createFakeCompletedToolCall>
  ) => service.addEvent(toolEvent(fakeToolEvent(...args)));

  beforeEach(() => {
    service = new UiTelemetryService();
  });

  it('should have correct initial metrics', () => {
    const metrics = service.getMetrics();
    expect(metrics).toEqual({
      models: {},
      tools: {
        totalCalls: 0,
        totalSuccess: 0,
        totalFail: 0,
        totalDurationMs: 0,
        totalDecisions: decisions(),
        byName: {},
      },
      files: {
        totalLinesAdded: 0,
        totalLinesRemoved: 0,
      },
      skills: skillTotals(0, 0, 0),
    });
    expect(service.getLastPromptTokenCount()).toBe(0);
  });

  it('should emit an update event when an event is added', () => {
    const spy = vi.fn();
    service.on('update', spy);

    service.addEvent(proResponse());

    expect(spy).toHaveBeenCalledOnce();
    const { metrics, lastPromptTokenCount } = spy.mock.calls[0][0];
    expect(metrics).toBeDefined();
    expect(lastPromptTokenCount).toBe(0);
  });

  describe('API Response Event Processing', () => {
    it('applies cached-input fallback per session event without changing global metrics', () => {
      const sessionId = 'session-mixed-cache';
      const add = (tokens: number[]) =>
        service.addEvent(apiResponse('qwen', 1, tokens), sessionId);

      add([100, 20, 120, 80, 0]);
      add([0, 20, 220, 200, 0]);

      expect(
        service.getMetricsForSession(sessionId).models['qwen'].tokens.prompt,
      ).toBe(100);
      expect(
        service.getMetricsForSession(sessionId).statsModels?.['qwen'].tokens
          .prompt,
      ).toBe(300);
      expect(service.getMetrics().models['qwen'].tokens.prompt).toBe(100);
    });

    it('should process a single ApiResponseEvent', () => {
      service.addEvent(proResponse());

      expect(service.getMetrics().models['gemini-2.5-pro']).toEqual(
        mainOnly([1, 0, 500], [10, 20, 30, 5, 2]),
      );
      expect(service.getLastPromptTokenCount()).toBe(0);
    });

    it('should aggregate multiple ApiResponseEvents for the same model', () => {
      service.addEvent(proResponse());
      service.addEvent(apiResponse('gemini-2.5-pro', 600, [15, 25, 40, 10, 4]));

      expect(service.getMetrics().models['gemini-2.5-pro']).toEqual(
        mainOnly([2, 0, 1100], [25, 45, 70, 15, 6]),
      );
      expect(service.getLastPromptTokenCount()).toBe(0);
    });

    it('should handle ApiResponseEvents for different models', () => {
      service.addEvent(proResponse());
      service.addEvent(
        apiResponse('gemini-2.5-flash', 1000, [100, 200, 300, 50, 20]),
      );

      const metrics = service.getMetrics();
      expect(metrics.models['gemini-2.5-pro']).toBeDefined();
      expect(metrics.models['gemini-2.5-flash']).toBeDefined();
      expect(metrics.models['gemini-2.5-pro'].api.totalRequests).toBe(1);
      expect(metrics.models['gemini-2.5-flash'].api.totalRequests).toBe(1);
      expect(service.getLastPromptTokenCount()).toBe(0);
    });
  });

  describe('Generation Timing Metrics', () => {
    const timedResponse = (overrides: Partial<ApiResponseEvent> = {}) =>
      apiResponse('qwen3-coder', 500, [10, 20, 30, 0, 0], {
        prompt_id: 'user-query',
        ttft_ms: 100,
        ...overrides,
      });

    it('aggregates timed streaming responses and keeps the latest sample', () => {
      service.addEvent(timedResponse());
      service.addEvent(
        timedResponse({
          model: 'qwen-plus',
          duration_ms: 800,
          ttft_ms: 200,
          output_token_count: 30,
        }),
      );

      expect(service.getMetrics().generation).toEqual({
        timedRequests: 2,
        totalTtftMs: 300,
        totalGenerationDurationMs: 1000,
        totalThroughputOutputTokens: 50,
        last: {
          model: 'qwen-plus',
          ttftMs: 200,
          generationDurationMs: 600,
          outputTokens: 30,
        },
      });
    });

    it('does not create samples for missing TTFT or internal prompts', () => {
      service.addEvent(timedResponse({ ttft_ms: undefined }));
      service.addEvent(timedResponse({ prompt_id: 'prompt_suggestion' }));

      expect(service.getMetrics().generation).toBeUndefined();
    });

    it('clamps sampling time when TTFT exceeds request duration', () => {
      service.addEvent(timedResponse({ duration_ms: 100, ttft_ms: 150 }));

      expect(service.getMetrics().generation).toMatchObject({
        timedRequests: 1,
        totalGenerationDurationMs: 0,
        totalThroughputOutputTokens: 0,
        last: {
          ttftMs: 150,
          generationDurationMs: 0,
        },
      });
    });

    it('keeps generation metrics isolated per session', () => {
      service.addEvent(timedResponse(), 'session-a');
      service.addEvent(
        timedResponse({ model: 'qwen-plus', ttft_ms: 250 }),
        'session-b',
      );

      expect(
        service.getMetricsForSession('session-a').generation?.last?.model,
      ).toBe('qwen3-coder');
      expect(
        service.getMetricsForSession('session-b').generation?.last?.model,
      ).toBe('qwen-plus');
    });

    it('clears generation metrics when the service resets', () => {
      service.addEvent(timedResponse());
      expect(service.getMetrics().generation).toBeDefined();

      service.reset();

      expect(service.getMetrics().generation).toBeUndefined();
    });
  });

  describe('API Error Event Processing', () => {
    it('should process a single ApiErrorEvent', () => {
      service.addEvent(apiError('gemini-2.5-pro', 300, 'Something went wrong'));

      expect(service.getMetrics().models['gemini-2.5-pro']).toEqual(
        mainOnly([1, 1, 300], [0, 0, 0, 0, 0]),
      );
    });

    it('should aggregate ApiErrorEvents and ApiResponseEvents', () => {
      service.addEvent(proResponse());
      service.addEvent(apiError('gemini-2.5-pro', 300, 'Something went wrong'));

      expect(service.getMetrics().models['gemini-2.5-pro']).toEqual(
        mainOnly([2, 1, 800], [10, 20, 30, 5, 2]),
      );
    });
  });

  describe('Subagent Source Attribution', () => {
    const SID = '11111111-1111-1111-1111-111111111111';

    it('attributes API calls without subagent_name to MAIN_SOURCE', () => {
      service.addEvent(apiResponse('glm-5', 100, [10, 5, 15, 0, 0]));

      const modelMetrics = service.getMetrics().models['glm-5'];
      expect(Object.keys(modelMetrics.bySource)).toEqual([MAIN_SOURCE]);
      expect(modelMetrics.bySource[MAIN_SOURCE].api.totalRequests).toBe(1);
      expect(modelMetrics.api.totalRequests).toBe(1);
    });

    it('splits a single model between main and a subagent', () => {
      service.addEvent(apiResponse('glm-5', 200, [100, 50, 150, 20, 0]));
      service.addEvent(
        apiResponse('glm-5', 80, [40, 10, 50, 0, 0], {
          subagent_name: 'echoer',
        }),
      );

      const modelMetrics = service.getMetrics().models['glm-5'];
      // Aggregate spans both main and subagent calls
      expect(modelMetrics.api.totalRequests).toBe(2);
      expect(modelMetrics.api.totalLatencyMs).toBe(280);
      expect(modelMetrics.tokens.prompt).toBe(140);
      expect(modelMetrics.tokens.total).toBe(200);
      // Per-source breakdown isolates each contributor
      expect(new Set(Object.keys(modelMetrics.bySource))).toEqual(
        new Set([MAIN_SOURCE, 'echoer']),
      );
      expect(modelMetrics.bySource[MAIN_SOURCE].api.totalRequests).toBe(1);
      expect(modelMetrics.bySource[MAIN_SOURCE].tokens.prompt).toBe(100);
      expect(modelMetrics.bySource['echoer'].api.totalRequests).toBe(1);
      expect(modelMetrics.bySource['echoer'].tokens.prompt).toBe(40);
    });

    it('splits two subagents sharing a model into distinct source buckets', () => {
      const makeEvent = (subagent_name: string, duration: number) =>
        apiResponse('glm-5', duration, [10, 5, 15, 0, 0], { subagent_name });

      service.addEvent(makeEvent('alpha', 50));
      service.addEvent(makeEvent('bravo', 70));

      const modelMetrics = service.getMetrics().models['glm-5'];
      expect(modelMetrics.api.totalRequests).toBe(2);
      expect(Object.keys(modelMetrics.bySource).sort()).toEqual([
        'alpha',
        'bravo',
      ]);
      expect(modelMetrics.bySource['alpha'].api.totalRequests).toBe(1);
      expect(modelMetrics.bySource['bravo'].api.totalRequests).toBe(1);
      // Main bucket should NOT be created when no main-origin event arrived
      expect(modelMetrics.bySource[MAIN_SOURCE]).toBeUndefined();
    });

    it('preserves name buckets and records metrics by invocation id', () => {
      const makeEvent = (subagent_id: string, prompt: number) =>
        apiResponse('glm-5', 10, [prompt, 0, prompt, 0, 0], {
          subagent_name: 'general-purpose',
          subagent_id,
          subagent_type: 'general-purpose',
          subagent_task_name: 'query weather',
        });

      service.addEvent(makeEvent('id-1', 40), SID);
      service.addEvent(makeEvent('id-2', 60), SID);

      const modelMetrics = service.getMetrics().models['glm-5'];
      expect(Object.keys(modelMetrics.bySource)).toEqual(['general-purpose']);
      expect(modelMetrics.bySource['general-purpose'].tokens.prompt).toBe(100);
      expect(service.getMetrics().sourceMetrics).toBeUndefined();
      const sessionMetrics = service.getMetricsForSession(SID);
      expect(sessionMetrics.sourceMetrics?.['id-1'].tokens.prompt).toBe(40);
      expect(sessionMetrics.sourceMetrics?.['id-2'].tokens.prompt).toBe(60);
      expect(sessionMetrics.sourceMeta).toEqual({
        'id-1': { name: 'query weather', type: 'general-purpose' },
        'id-2': { name: 'query weather', type: 'general-purpose' },
      });
    });

    it('keeps invocation maps prototype-free after snapshot restore', () => {
      const sessionId = 'session-snapshot';
      const event = apiResponse('qwen', 1, [1, 0, 1, 0, 0], {
        subagent_id: 'constructor',
        subagent_type: 'Explore',
        subagent_task_name: 'inspect',
      });

      service.addEvent(event, sessionId);
      const snapshot = service.snapshotForReplay(sessionId);
      service.restoreFromReplaySnapshot(snapshot);
      service.addEvent(event, sessionId);

      const metrics = service.getMetricsForSession(sessionId);
      expect(metrics.sourceMetrics?.['constructor'].tokens.prompt).toBe(2);
      expect(Object.getPrototypeOf(metrics.sourceMetrics)).toBeNull();
      expect(Object.getPrototypeOf(metrics.sourceMeta)).toBeNull();
      expect(Object.getPrototypeOf(metrics.statsModels)).toBeNull();
    });

    it('restores legacy invocation ids from session-scoped prompt ids', () => {
      const addResponse = (
        subagentId: string,
        round: number,
        prompt: number,
        subagentName = 'general-purpose',
      ) =>
        service.addEvent(
          apiResponse('glm-5', 10, [prompt, 0, prompt, 0, 0], {
            prompt_id: `${SID}#${subagentId}#${round}`,
            subagent_name: subagentName,
          }),
          SID,
        );

      addResponse('general-purpose-a83536b9', 1, 40);
      addResponse('general-purpose-a83536b9', 2, 60);
      addResponse('Explore-8384d783', 1, 20, 'query weather');
      service.addEvent(
        apiError('glm-5', 10, 'boom', {
          prompt_id: `${SID}#Explore-8384d783#2`,
          subagent_name: 'query weather',
        }),
        SID,
      );

      const metrics = service.getMetricsForSession(SID);
      expect(metrics.sourceMetrics?.['general-purpose-a83536b9']).toMatchObject(
        {
          api: { totalRequests: 2, totalErrors: 0 },
          tokens: { prompt: 100, total: 100 },
        },
      );
      expect(metrics.sourceMetrics?.['Explore-8384d783']).toMatchObject({
        api: { totalRequests: 2, totalErrors: 1 },
        tokens: { prompt: 20, total: 20 },
      });
      expect(metrics.sourceMeta).toEqual({
        'general-purpose-a83536b9': {
          name: 'general-purpose',
          type: 'general-purpose',
        },
        'Explore-8384d783': {
          name: 'query weather',
          type: 'query weather',
        },
      });
      expect(service.getMetrics().sourceMetrics).toBeUndefined();
    });

    it('prefers an explicit invocation id over the legacy prompt id', () => {
      service.addEvent(
        apiResponse('glm-5', 10, [40, 0, 40, 0, 0], {
          prompt_id: `${SID}#legacy-id#1`,
          subagent_name: 'general-purpose',
          subagent_id: 'explicit-id',
        }),
        SID,
      );

      expect(
        Object.keys(service.getMetricsForSession(SID).sourceMetrics ?? {}),
      ).toEqual(['explicit-id']);
    });

    it.each([
      { promptId: '11111111-1111-1111-1111-111111111111#agent-id#1' },
      { promptId: 'other-session#agent-id#1', subagentName: 'agent' },
      {
        promptId: '11111111-1111-1111-1111-111111111111##1',
        subagentName: 'agent',
      },
      {
        promptId: '11111111-1111-1111-1111-111111111111#agent-id#x',
        subagentName: 'agent',
      },
      { promptId: 'prompt_suggestion', subagentName: 'agent' },
    ])(
      'does not infer an invocation id from unrelated prompt id $promptId',
      ({ promptId, subagentName }) => {
        service.addEvent(
          apiResponse('glm-5', 10, [40, 0, 40, 0, 0], {
            prompt_id: promptId,
            subagent_name: subagentName,
          }),
          SID,
        );

        expect(service.getMetricsForSession(SID).sourceMetrics).toBeUndefined();
      },
    );

    it.each([
      { prompt: 40, cached: 5, candidates: 10, thoughts: 2, expected: 52 },
      { prompt: 40, cached: 5, candidates: 10, thoughts: 20, expected: 70 },
      { prompt: 0, cached: 40, candidates: 10, thoughts: 2, expected: 52 },
    ])(
      'falls back when total tokens are omitted ($candidates candidates, $thoughts thoughts)',
      ({ prompt, cached, candidates, thoughts, expected }) => {
        service.addEvent(
          apiResponse('glm-5', 10, [prompt, candidates, 0, cached, thoughts], {
            subagent_name: 'general-purpose',
            subagent_id: 'id-1',
          }),
          SID,
        );

        const metrics = service.getMetrics();
        const session = service.getMetricsForSession(SID);
        expect(metrics.models['glm-5'].tokens.total).toBe(0);
        expect(
          metrics.models['glm-5'].bySource['general-purpose'].tokens.total,
        ).toBe(0);
        expect(metrics.sourceMetrics).toBeUndefined();
        expect(session.models['glm-5'].tokens.total).toBe(0);
        expect(
          session.models['glm-5'].bySource['general-purpose'].tokens.total,
        ).toBe(0);
        expect(session.statsModels?.['glm-5'].tokens.total).toBe(expected);
        expect(session.sourceMetrics?.['id-1'].tokens.total).toBe(expected);
      },
    );

    it.each(['openai', 'qwen-oauth'])(
      'does not double-count reasoning for %s events',
      (authType) => {
        service.addEvent(
          apiResponse('openai-model', 10, [40, 10, 0, 0, 2], {
            auth_type: authType,
          }),
          SID,
        );

        expect(service.getMetrics().models['openai-model'].tokens.total).toBe(
          0,
        );
        expect(
          service.getMetricsForSession(SID).statsModels?.['openai-model'].tokens
            .total,
        ).toBe(50);
      },
    );

    it('preserves richer invocation metadata from earlier events', () => {
      const event = (extra: Record<string, unknown> = {}) =>
        apiResponse('glm-5', 10, [10, 0, 10, 0, 0], {
          subagent_name: 'general-purpose',
          subagent_id: 'id-1',
          ...extra,
        });

      service.addEvent(
        event({
          subagent_type: 'code-reviewer',
          subagent_task_name: 'review the diff',
        }),
        SID,
      );
      service.addEvent(event(), SID);

      expect(service.getMetricsForSession(SID).sourceMeta?.['id-1']).toEqual({
        name: 'review the diff',
        type: 'code-reviewer',
      });
    });

    it('keeps API error invocation details scoped to the session', () => {
      service.addEvent(
        apiError('glm-5', 10, 'failed', {
          subagent_name: 'general-purpose',
          subagent_id: 'error-id',
        }),
        SID,
      );

      expect(service.getMetrics().sourceMetrics).toBeUndefined();
      expect(service.getMetrics().sourceMeta).toBeUndefined();
      expect(
        service.getMetricsForSession(SID).sourceMetrics?.['error-id'].api,
      ).toMatchObject({ totalRequests: 1, totalErrors: 1 });

      service.removeSession(SID);
      expect(service.getMetricsForSession(SID).sourceMetrics).toBeUndefined();
    });

    it('handles a subagent named after an Object.prototype member without crashing', () => {
      // `constructor` is a valid subagent name. A plain-object `bySource`
      // would find `Object.prototype.constructor` on the truthiness check,
      // skip bucket creation and crash aggregation; the prototype-free map
      // prevents this.
      const event = apiResponse('glm-5', 100, [10, 5, 15, 0, 0], {
        subagent_name: 'constructor',
      });

      expect(() => service.addEvent(event)).not.toThrow();

      const modelMetrics = service.getMetrics().models['glm-5'];
      expect(modelMetrics.bySource['constructor']).toBeDefined();
      expect(modelMetrics.bySource['constructor'].api.totalRequests).toBe(1);
      expect(modelMetrics.bySource['constructor'].tokens.prompt).toBe(10);
      // Sanity: the Object prototype member was not actually mutated.
      expect(typeof modelMetrics.bySource['constructor']).toBe('object');
    });

    it('attributes API errors to the subagent source bucket', () => {
      service.addEvent(
        apiError('glm-5', 150, 'boom', { subagent_name: 'alpha' }),
      );

      const modelMetrics = service.getMetrics().models['glm-5'];
      expect(modelMetrics.api.totalErrors).toBe(1);
      expect(modelMetrics.bySource['alpha'].api.totalErrors).toBe(1);
      expect(modelMetrics.bySource[MAIN_SOURCE]).toBeUndefined();
    });
  });

  describe('Tool Call Event Processing', () => {
    it.each([
      [
        'should process a single successful ToolCallEvent',
        true,
        150,
        ToolConfirmationOutcome.ProceedOnce,
        ToolCallDecision.ACCEPT,
        1,
      ],
      [
        'should process a single failed ToolCallEvent',
        false,
        200,
        ToolConfirmationOutcome.Cancel,
        ToolCallDecision.REJECT,
        0,
      ],
      [
        'should process a single cancelled ToolCallEvent',
        'cancelled',
        180,
        ToolConfirmationOutcome.Cancel,
        ToolCallDecision.REJECT,
        0,
      ],
    ] as const)(
      '%s',
      (_title, status, duration, outcome, decision, success) => {
        addToolCall('test_tool', status, duration, outcome);
        const { tools } = service.getMetrics();

        expect(tools.totalCalls).toBe(1);
        expect(tools.totalSuccess).toBe(success);
        expect(tools.totalFail).toBe(1 - success);
        expect(tools.totalDurationMs).toBe(duration);
        expect(tools.totalDecisions[decision]).toBe(1);
        expect(tools.byName['test_tool']).toEqual({
          count: 1,
          success,
          fail: 1 - success,
          durationMs: duration,
          decisions: decisions({ [decision]: 1 }),
        });
      },
    );

    it('should process a ToolCallEvent with modify decision', () => {
      addToolCall(
        'test_tool',
        true,
        250,
        ToolConfirmationOutcome.ModifyWithEditor,
      );
      const { tools } = service.getMetrics();

      expect(tools.totalDecisions[ToolCallDecision.MODIFY]).toBe(1);
      expect(tools.byName['test_tool'].decisions[ToolCallDecision.MODIFY]).toBe(
        1,
      );
    });

    it('should process a ToolCallEvent without a decision', () => {
      addToolCall('test_tool', true, 100);
      const { tools } = service.getMetrics();

      expect(tools.totalDecisions).toEqual(decisions());
      expect(tools.byName['test_tool'].decisions).toEqual(decisions());
    });

    it('should aggregate multiple ToolCallEvents for the same tool', () => {
      addToolCall('test_tool', true, 100, ToolConfirmationOutcome.ProceedOnce);
      addToolCall('test_tool', false, 150, ToolConfirmationOutcome.Cancel);
      const { tools } = service.getMetrics();

      expect(tools.totalCalls).toBe(2);
      expect(tools.totalSuccess).toBe(1);
      expect(tools.totalFail).toBe(1);
      expect(tools.totalDurationMs).toBe(250);
      expect(tools.totalDecisions[ToolCallDecision.ACCEPT]).toBe(1);
      expect(tools.totalDecisions[ToolCallDecision.REJECT]).toBe(1);
      expect(tools.byName['test_tool']).toEqual({
        count: 2,
        success: 1,
        fail: 1,
        durationMs: 250,
        decisions: decisions({
          [ToolCallDecision.ACCEPT]: 1,
          [ToolCallDecision.REJECT]: 1,
        }),
      });
    });

    it('should handle ToolCallEvents for different tools', () => {
      addToolCall('tool_A', true, 100);
      addToolCall('tool_B', false, 200);
      const { tools } = service.getMetrics();

      expect(tools.totalCalls).toBe(2);
      expect(tools.totalSuccess).toBe(1);
      expect(tools.totalFail).toBe(1);
      expect(tools.byName['tool_A']).toBeDefined();
      expect(tools.byName['tool_B']).toBeDefined();
      expect(tools.byName['tool_A'].count).toBe(1);
      expect(tools.byName['tool_B'].count).toBe(1);
    });

    it('redacts function_args for structured_output calls while preserving metrics', () => {
      const toolCall = createFakeCompletedToolCall(
        'structured_output',
        true,
        250,
        ToolConfirmationOutcome.ProceedOnce,
      );
      // The fake hardcodes args to { foo: 'bar' }; in the real structured-output
      // flow this is the user's extracted payload, which ToolCallEvent must not
      // pass through to telemetry.
      (toolCall.request as { args: Record<string, unknown> }).args = {
        secret: 'extracted private value',
      };

      const event = new ToolCallEvent(toolCall);

      expect(event.function_name).toBe('structured_output');
      expect(event.function_args).not.toHaveProperty('secret');
      expect(event.function_args).toEqual({
        __redacted: 'structured_output payload (see stdout result)',
      });

      // Metrics still flow through normally — duration, success, decision.
      service.addEvent(toolEvent(event));

      const { tools } = service.getMetrics();
      expect(tools.totalCalls).toBe(1);
      expect(tools.totalSuccess).toBe(1);
      expect(tools.totalDurationMs).toBe(250);
      expect(tools.byName['structured_output']).toMatchObject({
        count: 1,
        success: 1,
        durationMs: 250,
      });
    });

    it('does not redact function_args for non-structured_output tools', () => {
      const toolCall = createFakeCompletedToolCall(
        'write_file',
        true,
        100,
        ToolConfirmationOutcome.ProceedOnce,
      );
      (toolCall.request as { args: Record<string, unknown> }).args = {
        path: '/tmp/x',
        content: 'hello',
      };

      expect(new ToolCallEvent(toolCall).function_args).toEqual({
        path: '/tmp/x',
        content: 'hello',
      });
    });
  });

  describe('Skill Invocation Metrics', () => {
    it('aggregates successful and failed skill invocations by name', () => {
      service.recordSkillInvocation('review', true);
      service.recordSkillInvocation('review', false);
      service.recordSkillInvocation('testing', true);

      expect(service.getMetrics().skills).toEqual(
        skillTotals(3, 2, 1, {
          review: { count: 2, success: 1, fail: 1 },
          testing: { count: 1, success: 1, fail: 0 },
        }),
      );
    });

    it('handles skill names that collide with object prototype keys', () => {
      service.recordSkillInvocation('constructor', true);
      service.recordSkillInvocation('__proto__', false);

      expect(service.getMetrics().skills?.byName['constructor']).toEqual({
        count: 1,
        success: 1,
        fail: 0,
      });
      expect(service.getMetrics().skills?.byName['__proto__']).toEqual({
        count: 1,
        success: 0,
        fail: 1,
      });
    });
  });

  describe('resetLastPromptTokenCount', () => {
    const addInitialEvent = () =>
      service.addEvent(
        apiResponse('gemini-2.5-pro', 500, [100, 200, 300, 50, 20]),
      );

    it('should reset the last prompt token count to 0', () => {
      addInitialEvent();
      expect(service.getLastPromptTokenCount()).toBe(0);

      service.setLastPromptTokenCount(0);
      expect(service.getLastPromptTokenCount()).toBe(0);
    });

    it('should emit an update event when resetLastPromptTokenCount is called', () => {
      const spy = vi.fn();
      service.on('update', spy);
      addInitialEvent();
      spy.mockClear(); // focus on the reset call

      service.setLastPromptTokenCount(0);

      expect(spy).toHaveBeenCalledOnce();
      const { metrics, lastPromptTokenCount } = spy.mock.calls[0][0];
      expect(metrics).toBeDefined();
      expect(lastPromptTokenCount).toBe(0);
    });

    it('should not affect other metrics when resetLastPromptTokenCount is called', () => {
      addInitialEvent();
      const metricsBefore = service.getMetrics();

      service.setLastPromptTokenCount(0);

      expect(service.getMetrics()).toEqual(metricsBefore);
      expect(service.getLastPromptTokenCount()).toBe(0);
    });

    it('should work correctly when called multiple times', () => {
      const spy = vi.fn();
      service.on('update', spy);
      addInitialEvent();
      expect(service.getLastPromptTokenCount()).toBe(0);

      service.setLastPromptTokenCount(0);
      expect(service.getLastPromptTokenCount()).toBe(0);

      // Reset again - should still be 0 and still emit event
      spy.mockClear();
      service.setLastPromptTokenCount(0);
      expect(service.getLastPromptTokenCount()).toBe(0);
      expect(spy).toHaveBeenCalledOnce();
    });

    it('should correctly set status field for success/error/cancelled calls', () => {
      const successEvent = fakeToolEvent('success_tool', true, 100);
      const errorEvent = fakeToolEvent('error_tool', false, 150);
      const cancelledEvent = fakeToolEvent('cancelled_tool', 'cancelled', 200);

      expect(successEvent.status).toBe('success');
      expect(errorEvent.status).toBe('error');
      expect(cancelledEvent.status).toBe('cancelled');

      // Backward compatibility with the success field
      expect(successEvent.success).toBe(true);
      expect(errorEvent.success).toBe(false);
      expect(cancelledEvent.success).toBe(false);
    });
  });

  describe('Tool Call Event with Line Count Metadata', () => {
    const addWithMetadata = (metadata: Record<string, unknown>) =>
      service.addEvent(
        toolEvent(fakeToolEvent('test_tool', true, 100), { metadata }),
      );

    it('should aggregate valid line count metadata', () => {
      addWithMetadata({ model_added_lines: 10, model_removed_lines: 5 });

      const metrics = service.getMetrics();
      expect(metrics.files.totalLinesAdded).toBe(10);
      expect(metrics.files.totalLinesRemoved).toBe(5);
    });

    it('should ignore null/undefined values in line count metadata', () => {
      addWithMetadata({
        model_added_lines: null,
        model_removed_lines: undefined,
      });

      const metrics = service.getMetrics();
      expect(metrics.files.totalLinesAdded).toBe(0);
      expect(metrics.files.totalLinesRemoved).toBe(0);
    });
  });

  describe('Per-Session Metrics Isolation', () => {
    const SESSION_A = 'session-aaa';
    const SESSION_B = 'session-bbb';

    it('should isolate metrics by sessionId', () => {
      service.addEvent(makeApiEvent('model-a', 100), SESSION_A);
      service.addEvent(makeApiEvent('model-b', 200), SESSION_B);

      const metricsA = service.getMetricsForSession(SESSION_A);
      const metricsB = service.getMetricsForSession(SESSION_B);

      expect(metricsA.models['model-a']?.tokens.prompt).toBe(100);
      expect(metricsA.models['model-b']).toBeUndefined();

      expect(metricsB.models['model-b']?.tokens.prompt).toBe(200);
      expect(metricsB.models['model-a']).toBeUndefined();
    });

    it('should still accumulate to global metrics', () => {
      service.addEvent(makeApiEvent('model-x', 100), SESSION_A);
      service.addEvent(makeApiEvent('model-x', 200), SESSION_B);

      expect(service.getMetrics().models['model-x']?.tokens.prompt).toBe(300);
    });

    it('should return empty metrics for unknown session', () => {
      const metrics = service.getMetricsForSession('unknown');
      expect(metrics.models).toEqual({});
      expect(metrics.tools.totalCalls).toBe(0);
    });

    it('should handle events without sessionId (global only)', () => {
      service.addEvent(makeApiEvent('model-z', 50));

      expect(service.getMetrics().models['model-z']?.tokens.prompt).toBe(50);
      expect(service.getMetricsForSession('any-session').models).toEqual({});
    });

    it('resetSession should clear only that session', () => {
      service.addEvent(makeApiEvent('m', 100), SESSION_A);
      service.addEvent(makeApiEvent('m', 200), SESSION_B);

      service.resetSession(SESSION_A);

      expect(service.getMetricsForSession(SESSION_A).models).toEqual({});
      expect(
        service.getMetricsForSession(SESSION_B).models['m']?.tokens.prompt,
      ).toBe(200);
      // Global should not be affected
      expect(service.getMetrics().models['m']?.tokens.prompt).toBe(300);
    });

    it('removeSession should prevent late events from recreating bucket', () => {
      service.addEvent(makeApiEvent('m', 100), SESSION_A);
      service.removeSession(SESSION_A);

      // Late event after removal must not recreate the session bucket...
      service.addEvent(makeApiEvent('m', 50), SESSION_A);
      expect(service.getMetricsForSession(SESSION_A).models).toEqual({});

      // ...but global should still accumulate
      expect(service.getMetrics().models['m']?.tokens.prompt).toBe(150);
    });

    it('resetSession should re-enable a closed session', () => {
      service.addEvent(makeApiEvent('m', 100), SESSION_A);
      service.removeSession(SESSION_A);

      service.resetSession(SESSION_A); // re-open
      service.addEvent(makeApiEvent('m', 50), SESSION_A);

      expect(
        service.getMetricsForSession(SESSION_A).models['m']?.tokens.prompt,
      ).toBe(50);
    });

    it('should isolate tool call metrics by session', () => {
      service.addEvent(makeToolEvent('Read'), SESSION_A);
      service.addEvent(makeToolEvent('Write'), SESSION_B);
      service.addEvent(makeToolEvent('Read'), SESSION_B);

      const metricsA = service.getMetricsForSession(SESSION_A);
      const metricsB = service.getMetricsForSession(SESSION_B);

      expect(metricsA.tools.totalCalls).toBe(1);
      expect(metricsA.tools.byName['Read']?.count).toBe(1);
      expect(metricsA.tools.byName['Write']).toBeUndefined();

      expect(metricsB.tools.totalCalls).toBe(2);
      expect(metricsB.tools.byName['Write']?.count).toBe(1);
      expect(metricsB.tools.byName['Read']?.count).toBe(1);
    });

    it('should isolate skill invocation metrics by session', () => {
      service.recordSkillInvocation('review', true, SESSION_A);
      service.recordSkillInvocation('review', false, SESSION_B);
      service.recordSkillInvocation('testing', true, SESSION_B);

      expect(service.getMetricsForSession(SESSION_A).skills).toEqual(
        skillTotals(1, 1, 0, { review: { count: 1, success: 1, fail: 0 } }),
      );
      expect(service.getMetricsForSession(SESSION_B).skills).toEqual(
        skillTotals(2, 1, 1, {
          review: { count: 1, success: 0, fail: 1 },
          testing: { count: 1, success: 1, fail: 0 },
        }),
      );
    });

    it('removeSession should prevent late skill metrics from recreating bucket', () => {
      service.recordSkillInvocation('review', true, SESSION_A);
      service.removeSession(SESSION_A);

      service.recordSkillInvocation('review', false, SESSION_A);

      expect(service.getMetricsForSession(SESSION_A).skills).toEqual(
        skillTotals(0, 0, 0),
      );
      expect(service.getMetrics().skills?.byName['review']).toEqual({
        count: 2,
        success: 1,
        fail: 1,
      });
    });

    it('resetSession should not clear global metrics (replay scenario)', () => {
      const prompt = (sessionId?: string) =>
        (sessionId
          ? service.getMetricsForSession(sessionId)
          : service.getMetrics()
        ).models['m']?.tokens.prompt;
      // Session A active, session B being resumed
      service.addEvent(makeApiEvent('m', 100), SESSION_A);
      service.addEvent(makeApiEvent('m', 200), SESSION_B);

      // Resume session B: resetSession only clears B's bucket
      service.resetSession(SESSION_B);

      expect(prompt(SESSION_A)).toBe(100);
      expect(service.getMetricsForSession(SESSION_B).models).toEqual({});
      // Global NOT cleared (still has both sessions' original data)
      expect(prompt()).toBe(300);

      // Replay events into session B: B holds only replayed data, global
      // accumulates the replay too
      service.addEvent(makeApiEvent('m', 50), SESSION_B);
      expect(prompt(SESSION_B)).toBe(50);
      expect(prompt()).toBe(350);
    });

    it('#closedSessions should be bounded', () => {
      // Add more than MAX_CLOSED_SESSIONS
      for (let i = 0; i < 1005; i++) {
        service.addEvent(makeApiEvent('m', 1), `session-${i}`);
        service.removeSession(`session-${i}`);
      }
      // The oldest session was evicted from closedSessions, so a late event
      // to it creates a new bucket
      service.addEvent(makeApiEvent('m', 99), 'session-0');
      expect(
        service.getMetricsForSession('session-0').models['m']?.tokens.prompt,
      ).toBe(99);
    });
  });

  describe('Replay snapshot / restore (session-swap undo, #9833)', () => {
    const SESSION_A = 'session-aaa';
    const SESSION_B = 'session-bbb';
    const SESSION_C = 'session-ccc';

    const replayEvent = (
      model: string,
      inputTokens: number,
      subagent?: string,
    ) => makeApiEvent(model, inputTokens, { subagent_name: subagent });

    it('round-trips the whole observable surface', () => {
      // Rich pre-swap state: two models, a per-source breakdown, tool and
      // skill calls, two live buckets, token counts.
      service.addEvent(replayEvent('model-a', 100), SESSION_A);
      service.addEvent(replayEvent('model-b', 200, 'sub-1'), SESSION_A);
      service.addEvent(makeToolEvent('read_file'), SESSION_A);
      service.recordSkillInvocation('skill-a', true, SESSION_A);
      service.addEvent(replayEvent('model-a', 300), SESSION_B);
      service.setLastPromptTokenCount(42);
      service.setLastCachedContentTokenCount(7);
      const preGlobal = structuredClone(service.getMetrics());
      const preA = structuredClone(service.getMetricsForSession(SESSION_A));
      const preB = structuredClone(service.getMetricsForSession(SESSION_B));

      const snapshot = service.snapshotForReplay(SESSION_B, SESSION_A);

      // The replay + its fallout: new events into the aggregate and both
      // buckets, token counts moved, the outgoing bucket wiped by the
      // rollback's resetSession, a replay-created phantom state.
      service.resetSession(SESSION_B);
      service.addEvent(replayEvent('model-c', 999), SESSION_B);
      service.resetSession(SESSION_A);
      service.addEvent(replayEvent('model-c', 111), SESSION_A);
      service.setLastPromptTokenCount(999);
      service.setLastCachedContentTokenCount(999);

      service.restoreFromReplaySnapshot(snapshot);

      expect(service.getMetrics()).toEqual(preGlobal);
      expect(service.getMetricsForSession(SESSION_A)).toEqual(preA);
      expect(service.getMetricsForSession(SESSION_B)).toEqual(preB);
      expect(service.getLastPromptTokenCount()).toBe(42);
      expect(service.getLastCachedContentTokenCount()).toBe(7);
    });

    it('drops a bucket the replay created and restores the closed flag', () => {
      service.addEvent(replayEvent('model-a', 100), SESSION_A);
      // SESSION_B has no bucket yet and is marked closed — exactly the state
      // a resume of a finished session starts from.
      service.removeSession(SESSION_B);
      const snapshot = service.snapshotForReplay(SESSION_B, SESSION_A);

      // The replay creates B's bucket and reopens it.
      service.resetSession(SESSION_B);
      service.addEvent(replayEvent('model-a', 50), SESSION_B);
      expect(service.getMetricsForSession(SESSION_B).models).not.toEqual({});

      service.restoreFromReplaySnapshot(snapshot);

      // No leftover bucket reading as a live session; closed flag restored —
      // a fresh event for B must NOT land in a per-session bucket (closed
      // sessions are excluded from per-session accumulation).
      expect(service.getMetricsForSession(SESSION_B).models).toEqual({});
      service.addEvent(replayEvent('model-a', 77), SESSION_B);
      expect(service.getMetricsForSession(SESSION_B).models).toEqual({});
      // ...but the aggregate still counts it.
      expect(service.getMetrics().models['model-a']?.api.totalRequests).toBe(2);
    });

    it('keeps the bySource null prototype across restore', () => {
      // The bySource maps are prototype-free (crash guard for subagent names
      // like "constructor"); structuredClone silently re-arms the prototype,
      // so snapshot/restore must re-null it.
      service.addEvent(replayEvent('model-a', 100, 'constructor'), SESSION_A);
      const snapshot = service.snapshotForReplay(SESSION_B, SESSION_A);
      service.addEvent(replayEvent('model-a', 100), SESSION_B);
      service.restoreFromReplaySnapshot(snapshot);

      const bySource =
        service.getMetrics().models['model-a']?.bySource ??
        service.getMetricsForSession(SESSION_A).models['model-a']?.bySource;
      expect(bySource).toBeDefined();
      expect(Object.getPrototypeOf(bySource)).toBeNull();
      expect(bySource!['constructor']?.api.totalRequests).toBe(1);
      // The live accumulation path must keep working after the restore.
      service.addEvent(replayEvent('model-a', 5, 'constructor'), SESSION_A);
      expect(bySource!['constructor']?.api.totalRequests).toBe(2);
    });

    it('does not touch unrelated sessions', () => {
      service.addEvent(replayEvent('model-a', 100), SESSION_A);
      service.addEvent(replayEvent('model-a', 55), SESSION_C);
      const snapshot = service.snapshotForReplay(SESSION_B, SESSION_A);
      service.addEvent(replayEvent('model-a', 999), SESSION_B);

      service.restoreFromReplaySnapshot(snapshot);

      expect(
        service.getMetricsForSession(SESSION_C).models['model-a']?.tokens
          .prompt,
      ).toBe(55);
    });

    it('emits update so keyed displays re-render', () => {
      service.addEvent(replayEvent('model-a', 100), SESSION_A);
      const snapshot = service.snapshotForReplay(SESSION_B, SESSION_A);
      service.addEvent(replayEvent('model-a', 999), SESSION_B);

      const spy = vi.fn();
      service.on('update', spy);
      service.restoreFromReplaySnapshot(snapshot);

      expect(spy).toHaveBeenCalledOnce();
      expect(
        spy.mock.calls[0][0].metrics.models['model-a']?.tokens.prompt,
      ).toBe(100);
    });

    it('restore is overwrite-safe after another replay landed on top', () => {
      // The /branch rollback re-initializes the parent BEFORE the undo runs:
      // restore must supersede that second replay, not subtract from it.
      service.addEvent(replayEvent('model-a', 100), SESSION_A);
      const snapshot = service.snapshotForReplay(SESSION_B, SESSION_A);

      // Forward replay of the abandoned session...
      service.addEvent(replayEvent('model-a', 200), SESSION_B);
      // ...then the rollback's own replay of the parent on top.
      service.resetSession(SESSION_A);
      service.addEvent(replayEvent('model-a', 100), SESSION_A);
      service.addEvent(replayEvent('model-a', 100), SESSION_A);

      service.restoreFromReplaySnapshot(snapshot);

      expect(service.getMetrics().models['model-a']?.tokens.prompt).toBe(100);
      expect(
        service.getMetricsForSession(SESSION_A).models['model-a']?.tokens
          .prompt,
      ).toBe(100);
    });
  });
});

describe('UiTelemetryService.getTotalOutputTokens', () => {
  const response = (model: string, outputTokens: number) =>
    apiResponse(model, 10, [5, outputTokens, 5 + outputTokens, 0, 0], {
      prompt_id: 'p1',
    });

  // The workflow turn budget reads this: every model the session used, the
  // main loop's and the subagents' alike, and nothing from another session.
  it("sums output tokens across the session's models only", () => {
    const service = new UiTelemetryService();
    service.addEvent(response('qwen-a', 120), 'session-a');
    service.addEvent(response('qwen-b', 30), 'session-a');
    service.addEvent(response('qwen-a', 999), 'session-b');

    expect(service.getTotalOutputTokens('session-a')).toBe(150);
    expect(service.getTotalOutputTokens('session-b')).toBe(999);
    expect(service.getTotalOutputTokens('never-seen')).toBe(0);
  });

  it('starts again from zero after the session is reset', () => {
    const service = new UiTelemetryService();
    service.addEvent(response('qwen-a', 120), 'session-a');
    service.resetSession('session-a');
    expect(service.getTotalOutputTokens('session-a')).toBe(0);
  });

  it('restores a durable Session model ledger once without resetting warm usage or charging process totals', () => {
    const service = new UiTelemetryService();
    service.addEvent(response('main', 120), 'session-a');
    service.addEvent(response('hook', 30), 'session-a');
    const saved = structuredClone(
      service.getMetricsForSession('session-a').models,
    );
    service.reset();
    service.addEvent(response('other', 9), 'session-b');
    service.restoreSessionModelMetrics('session-a', saved);
    expect(service.getTotalOutputTokens('session-a')).toBe(150);
    expect(Object.keys(service.getMetrics().models)).toEqual(['other']);
    service.addEvent(response('hook', 20), 'session-a');
    service.restoreSessionModelMetrics('session-a', saved);
    expect(service.getTotalOutputTokens('session-a')).toBe(170);
    expect(service.getTotalOutputTokens('session-b')).toBe(9);
  });

  it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__'])(
    'accumulates source %s after restoring a JSON model ledger',
    (source) => {
      const service = new UiTelemetryService();
      service.addEvent(response('main', 120), 'session-a');
      const saved = JSON.parse(
        JSON.stringify(service.getMetricsForSession('session-a').models),
      );
      service.reset();

      service.restoreSessionModelMetrics('session-a', saved);
      expect(() =>
        service.addEvent(
          apiResponse('main', 10, [5, 20, 25, 0, 0], {
            subagent_name: source,
          }),
          'session-a',
        ),
      ).not.toThrow();

      const restored = service.getMetricsForSession('session-a').models;
      expect(Object.getPrototypeOf(restored['main'].bySource)).toBeNull();
      expect(restored['main'].bySource[source].api.totalRequests).toBe(1);
      expect(restored['main'].bySource[source].tokens.candidates).toBe(20);
      expect(service.getTotalOutputTokens('session-a')).toBe(140);
      expect(service.getMetrics().models['main'].tokens.candidates).toBe(20);
      expect(Object.hasOwn(saved['main'].bySource, source)).toBe(false);
    },
  );
});
