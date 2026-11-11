/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runToolUseLifecycle,
  type ToolUseLifecycleOptions,
  type PreExecutionOutcome,
} from './tool-execution-lifecycle.js';
import type { ToolCallRequestInfo } from '../tool-executor/types.js';
import type {
  AnyDeclarativeTool,
  AnyToolInvocation,
  ToolResult,
} from './tools.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(name = 'test_tool'): ToolCallRequestInfo {
  return {
    callId: `call-${name}`,
    name,
    args: {},
    prompt_id: 'test',
  };
}

function makeTool(name = 'test_tool'): AnyDeclarativeTool {
  return {
    name,
    isConcurrencySafe: vi.fn().mockReturnValue(true),
    build: vi.fn(),
  } as unknown as AnyDeclarativeTool;
}

function makeInvocation(): AnyToolInvocation {
  return {
    params: {},
    getDescription: () => 'test',
    toolLocations: () => [],
    execute: async () => ({
      llmContent: 'test result',
      returnDisplay: 'test result',
    }),
  } as unknown as AnyToolInvocation;
}

function makeSuccessResult(content = 'test result'): ToolResult {
  return {
    llmContent: content,
    returnDisplay: content,
  };
}

function makeErrorResult(message = 'tool error'): ToolResult {
  return {
    llmContent: message,
    returnDisplay: message,
    error: { message, type: undefined },
  };
}

function defaultOptions(
  overrides?: Partial<ToolUseLifecycleOptions>,
): ToolUseLifecycleOptions {
  const ac = new AbortController();
  return {
    invocation: makeInvocation(),
    request: makeRequest(),
    tool: makeTool(),
    signal: overrides?.signal ?? ac.signal,
    execute: vi.fn().mockResolvedValue(makeSuccessResult()),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runToolUseLifecycle', () => {
  describe('basic execution', () => {
    it('executes successfully with no gates', async () => {
      const result = await runToolUseLifecycle(defaultOptions());

      expect(result.result).toBeDefined();
      expect(result.result!.llmContent).toBe('test result');
      expect(result.error).toBeUndefined();
      expect(result.cancelled).toBe(false);
      expect(result.stage).toBe('execution');
    });

    it('passes invocation and signal to execute callback', async () => {
      const executeFn = vi.fn().mockResolvedValue(makeSuccessResult());
      const invocation = makeInvocation();
      const ac = new AbortController();

      await runToolUseLifecycle(
        defaultOptions({
          invocation,
          signal: ac.signal,
          execute: executeFn,
        }),
      );

      expect(executeFn).toHaveBeenCalledWith(invocation, ac.signal);
    });

    it('reports error from ToolResult.error field', async () => {
      const result = await runToolUseLifecycle(
        defaultOptions({
          execute: vi
            .fn()
            .mockResolvedValue(makeErrorResult('something broke')),
        }),
      );

      expect(result.result).toBeDefined();
      expect(result.error).toBeDefined();
      expect(result.error!.message).toBe('something broke');
      expect(result.cancelled).toBe(false);
      expect(result.stage).toBe('execution');
    });
  });

  describe('abort handling', () => {
    it('returns cancelled if signal already aborted before start', async () => {
      const ac = new AbortController();
      ac.abort('already cancelled');

      const result = await runToolUseLifecycle(
        defaultOptions({ signal: ac.signal }),
      );

      expect(result.cancelled).toBe(true);
      expect(result.stage).toBe('abort');
      expect(result.toolDenialKind).toBe('cancelled');
      expect(result.error!.message).toContain('cancelled');
    });

    it('returns cancelled if signal aborted during pre-execution gate', async () => {
      const ac = new AbortController();

      const preExecutionGate = vi.fn().mockImplementation(async () => {
        ac.abort('user abort');
        return { status: 'proceed' } as PreExecutionOutcome;
      });

      const result = await runToolUseLifecycle(
        defaultOptions({ signal: ac.signal, preExecutionGate }),
      );

      expect(result.cancelled).toBe(true);
      expect(result.stage).toBe('abort');
    });

    it('returns cancelled if execute throws AbortError', async () => {
      const ac = new AbortController();

      const execute = vi.fn().mockImplementation(async () => {
        ac.abort();
        throw new DOMException('Aborted', 'AbortError');
      });

      const result = await runToolUseLifecycle(
        defaultOptions({ signal: ac.signal, execute }),
      );

      expect(result.cancelled).toBe(true);
      expect(result.stage).toBe('execution');
      expect(result.toolDenialKind).toBe('interrupted');
    });

    it('returns cancelled if signal aborted after execution completes', async () => {
      const ac = new AbortController();

      const execute = vi.fn().mockImplementation(async () => {
        ac.abort();
        return makeSuccessResult();
      });

      const result = await runToolUseLifecycle(
        defaultOptions({ signal: ac.signal, execute }),
      );

      expect(result.cancelled).toBe(true);
      expect(result.stage).toBe('execution');
      expect(result.toolDenialKind).toBe('interrupted');
      // The result is still available even though cancelled
      expect(result.result).toBeDefined();
    });
  });

  describe('pre-execution gate', () => {
    it('returns runtime validation errors before invoking the gate', async () => {
      const validationResult = makeErrorResult('read the file first');
      const validateBeforePermission = vi
        .fn()
        .mockResolvedValue(validationResult);
      const invocation = {
        ...makeInvocation(),
        validateBeforePermission,
      } as AnyToolInvocation;
      const preExecutionGate = vi.fn();
      const execute = vi.fn();

      const result = await runToolUseLifecycle(
        defaultOptions({ invocation, preExecutionGate, execute }),
      );

      expect(validateBeforePermission).toHaveBeenCalledWith(
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          callId: 'call-test_tool',
        }),
      );
      expect(preExecutionGate).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(result.result).toBe(validationResult);
      expect(result.error?.message).toBe('read the file first');
      expect(result.stage).toBe('validation');
    });

    it('runs the gate after runtime validation succeeds', async () => {
      const callOrder: string[] = [];
      const invocation = {
        ...makeInvocation(),
        validateBeforePermission: vi.fn().mockImplementation(async () => {
          callOrder.push('validation');
          return undefined;
        }),
      } as AnyToolInvocation;
      const preExecutionGate = vi.fn().mockImplementation(async () => {
        callOrder.push('gate');
        return { status: 'proceed' } as PreExecutionOutcome;
      });
      const execute = vi.fn().mockImplementation(async () => {
        callOrder.push('execute');
        return makeSuccessResult();
      });

      await runToolUseLifecycle(
        defaultOptions({ invocation, preExecutionGate, execute }),
      );

      expect(callOrder).toEqual(['validation', 'gate', 'execute']);
    });

    it('proceeds when gate returns proceed', async () => {
      const preExecutionGate = vi
        .fn()
        .mockResolvedValue({ status: 'proceed' } as PreExecutionOutcome);

      const result = await runToolUseLifecycle(
        defaultOptions({ preExecutionGate }),
      );

      expect(preExecutionGate).toHaveBeenCalled();
      expect(result.result).toBeDefined();
      expect(result.stage).toBe('execution');
    });

    it('blocks execution when gate returns denied', async () => {
      const executeFn = vi.fn();
      const preExecutionGate = vi.fn().mockResolvedValue({
        status: 'denied',
        error: new Error('Policy violation'),
        toolDenialKind: 'permission-rule',
        userFeedback: 'Use a different approach',
        decisionReasonType: 'mode',
        decisionReason: 'Denied by configured mode',
      } as PreExecutionOutcome);

      const result = await runToolUseLifecycle(
        defaultOptions({ preExecutionGate, execute: executeFn }),
      );

      expect(executeFn).not.toHaveBeenCalled();
      expect(result.result).toBeUndefined();
      expect(result.error!.message).toBe('Policy violation');
      expect(result.cancelled).toBe(false);
      expect(result.stage).toBe('pre-gate');
      expect(result.toolDenialKind).toBe('permission-rule');
      expect(result.userFeedback).toBe('Use a different approach');
      expect(result.decisionReasonType).toBe('mode');
      expect(result.decisionReason).toBe('Denied by configured mode');
    });

    it('preserves a denied outcome when the gate also aborts the turn', async () => {
      const ac = new AbortController();
      const executeFn = vi.fn();
      const preExecutionGate = vi.fn().mockImplementation(async () => {
        ac.abort();
        return {
          status: 'denied',
          error: new Error('Denied by PermissionRequest hook'),
        } as PreExecutionOutcome;
      });

      const result = await runToolUseLifecycle(
        defaultOptions({
          signal: ac.signal,
          preExecutionGate,
          execute: executeFn,
        }),
      );

      expect(executeFn).not.toHaveBeenCalled();
      expect(ac.signal.aborted).toBe(true);
      expect(result.error?.message).toBe('Denied by PermissionRequest hook');
      expect(result.cancelled).toBe(false);
      expect(result.stage).toBe('pre-gate');
    });

    it('cancels execution when gate returns cancelled', async () => {
      const executeFn = vi.fn();
      const preExecutionGate = vi.fn().mockResolvedValue({
        status: 'cancelled',
        error: new Error('User denied execution'),
      } as PreExecutionOutcome);

      const result = await runToolUseLifecycle(
        defaultOptions({ preExecutionGate, execute: executeFn }),
      );

      expect(executeFn).not.toHaveBeenCalled();
      expect(result.cancelled).toBe(true);
      expect(result.error!.message).toBe('User denied execution');
      expect(result.stage).toBe('pre-gate');
    });

    it('handles hook-error outcome', async () => {
      const executeFn = vi.fn();
      const preExecutionGate = vi.fn().mockResolvedValue({
        status: 'hook-error',
        error: new Error('Hook crashed'),
      } as PreExecutionOutcome);

      const result = await runToolUseLifecycle(
        defaultOptions({ preExecutionGate, execute: executeFn }),
      );

      expect(executeFn).not.toHaveBeenCalled();
      expect(result.error!.message).toBe('Hook crashed');
      expect(result.cancelled).toBe(false);
      expect(result.stage).toBe('pre-gate');
    });

    it('catches thrown errors from gate', async () => {
      const preExecutionGate = vi
        .fn()
        .mockRejectedValue(new Error('gate explosion'));

      const result = await runToolUseLifecycle(
        defaultOptions({ preExecutionGate }),
      );

      expect(result.error!.message).toBe('gate explosion');
      expect(result.stage).toBe('pre-gate');
    });

    it('passes correct arguments to gate', async () => {
      const invocation = makeInvocation();
      const request = makeRequest('my_tool');
      const tool = makeTool('my_tool');
      const ac = new AbortController();

      const preExecutionGate = vi
        .fn()
        .mockResolvedValue({ status: 'proceed' } as PreExecutionOutcome);

      await runToolUseLifecycle(
        defaultOptions({
          invocation,
          request,
          tool,
          signal: ac.signal,
          preExecutionGate,
        }),
      );

      expect(preExecutionGate).toHaveBeenCalledWith(
        invocation,
        request,
        tool,
        ac.signal,
        undefined,
      );
    });

    it('rebuilds invocation with modified args before execute', async () => {
      const originalInvocation = makeInvocation();
      const rebuiltInvocation = {
        ...makeInvocation(),
        params: { path: '/tmp/modified' },
      } as AnyToolInvocation;
      const request = makeRequest('my_tool');
      request.args = { path: '/tmp/original' };
      const tool = makeTool('my_tool');
      (tool.build as ReturnType<typeof vi.fn>).mockReturnValue(
        rebuiltInvocation,
      );
      const execute = vi.fn().mockResolvedValue(makeSuccessResult());
      const modifiedArgs = { path: '/tmp/modified' };

      const result = await runToolUseLifecycle(
        defaultOptions({
          invocation: originalInvocation,
          request,
          tool,
          preExecutionGate: vi.fn().mockResolvedValue({
            status: 'proceed',
            modifiedArgs,
          } as PreExecutionOutcome),
          execute,
        }),
      );

      expect(tool.build).toHaveBeenCalledWith(modifiedArgs, undefined);
      expect(request.args).toEqual(modifiedArgs);
      expect(execute).toHaveBeenCalledWith(
        rebuiltInvocation,
        expect.anything(),
      );
      expect(result.invocation).toBe(rebuiltInvocation);
    });
  });

  describe('execution errors', () => {
    it('catches thrown errors from execute', async () => {
      const execute = vi.fn().mockRejectedValue(new Error('execution boom'));

      const result = await runToolUseLifecycle(defaultOptions({ execute }));

      expect(result.result).toBeUndefined();
      expect(result.error!.message).toBe('execution boom');
      expect(result.cancelled).toBe(false);
      expect(result.stage).toBe('execution');
    });

    it('wraps non-Error throws', async () => {
      const execute = vi.fn().mockRejectedValue('string error');

      const result = await runToolUseLifecycle(defaultOptions({ execute }));

      expect(result.error!.message).toBe('string error');
    });
  });

  describe('post-execution callback', () => {
    it('calls postExecution after successful execution', async () => {
      const invocation = makeInvocation();
      const request = makeRequest();
      const tool = makeTool();
      const toolResult = makeSuccessResult('done');
      const postExecution = vi.fn();

      await runToolUseLifecycle(
        defaultOptions({
          invocation,
          request,
          tool,
          execute: vi.fn().mockResolvedValue(toolResult),
          postExecution,
        }),
      );

      expect(postExecution).toHaveBeenCalledWith(
        invocation,
        request,
        tool,
        toolResult,
      );
    });

    it('does not call postExecution if pre-gate blocks', async () => {
      const postExecution = vi.fn();
      const preExecutionGate = vi.fn().mockResolvedValue({
        status: 'denied',
        error: new Error('blocked'),
      } as PreExecutionOutcome);

      await runToolUseLifecycle(
        defaultOptions({ preExecutionGate, postExecution }),
      );

      expect(postExecution).not.toHaveBeenCalled();
    });

    it('does not call postExecution if execution throws', async () => {
      const postExecution = vi.fn();
      const execute = vi.fn().mockRejectedValue(new Error('boom'));

      await runToolUseLifecycle(defaultOptions({ execute, postExecution }));

      expect(postExecution).not.toHaveBeenCalled();
    });

    it('reports post-hook error while preserving result', async () => {
      const toolResult = makeSuccessResult('good result');
      const postExecution = vi
        .fn()
        .mockRejectedValue(new Error('after-hook failed'));

      const result = await runToolUseLifecycle(
        defaultOptions({
          execute: vi.fn().mockResolvedValue(toolResult),
          postExecution,
        }),
      );

      // Result is preserved even when post-hook fails
      expect(result.result).toBe(toolResult);
      expect(result.error!.message).toBe('after-hook failed');
      expect(result.cancelled).toBe(false);
      expect(result.stage).toBe('post-hook');
    });
  });

  describe('full pipeline', () => {
    it('runs gate → execute → post-execution in order', async () => {
      const callOrder: string[] = [];

      const preExecutionGate = vi.fn().mockImplementation(async () => {
        callOrder.push('gate');
        return { status: 'proceed' } as PreExecutionOutcome;
      });

      const execute = vi.fn().mockImplementation(async () => {
        callOrder.push('execute');
        return makeSuccessResult();
      });

      const postExecution = vi.fn().mockImplementation(async () => {
        callOrder.push('post');
      });

      const result = await runToolUseLifecycle(
        defaultOptions({ preExecutionGate, execute, postExecution }),
      );

      expect(callOrder).toEqual(['gate', 'execute', 'post']);
      expect(result.result).toBeDefined();
      expect(result.error).toBeUndefined();
    });
  });
});
