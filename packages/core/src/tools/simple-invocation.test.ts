/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  SimpleInvocation,
  type SimpleInvocationConfig,
} from './simple-invocation.js';
import type { ToolUseContext } from './tool-types.js';
import type { ToolResult, ExecuteOptions } from './tools.js';

interface TestParams {
  path: string;
}

function createTestInvocation(
  executeFn: SimpleInvocationConfig<TestParams, ToolResult>['execute'],
  params: TestParams = { path: '/test' },
) {
  const config: SimpleInvocationConfig<TestParams, ToolResult> = {
    execute: executeFn,
  };
  return new SimpleInvocation<TestParams, ToolResult>(
    params,
    config,
    'test-tool',
  );
}

describe('SimpleInvocation', () => {
  describe('executeWithContext', () => {
    it('should pass the full ctx to the callback preserving all fields', async () => {
      let receivedCtx: ToolUseContext | undefined;
      const invocation = createTestInvocation(async (_params, ctx) => {
        receivedCtx = ctx;
        return { llmContent: 'ok', returnDisplay: 'ok' };
      });

      const signal = new AbortController().signal;
      const updateOutput = vi.fn();
      const ctx: ToolUseContext = {
        signal,
        updateOutput,
        options: {
          shellExecutionConfig:
            {} as unknown as ExecuteOptions['shellExecutionConfig'],
        },
        config: {
          getProjectRoot: () => '/root',
        } as unknown as ToolUseContext['config'],
        callId: 'call-123',
        toolCallScopeId: 'sched-456',
      };

      await invocation.executeWithContext(ctx);

      expect(receivedCtx).toBe(ctx);
      expect(receivedCtx!.callId).toBe('call-123');
      expect(receivedCtx!.toolCallScopeId).toBe('sched-456');
      expect(receivedCtx!.config).toBeDefined();
    });

    it('should pass params correctly', async () => {
      let receivedParams: TestParams | undefined;
      const invocation = createTestInvocation(
        async (params, _ctx) => {
          receivedParams = params;
          return { llmContent: 'ok', returnDisplay: 'ok' };
        },
        { path: '/my/path' },
      );

      const ctx: ToolUseContext = { signal: new AbortController().signal };
      await invocation.executeWithContext(ctx);

      expect(receivedParams).toEqual({ path: '/my/path' });
    });
  });

  describe('execute (scattered arguments signature)', () => {
    it('should construct a minimal ctx from scatter params', async () => {
      let receivedCtx: ToolUseContext | undefined;
      const invocation = createTestInvocation(async (_params, ctx) => {
        receivedCtx = ctx;
        return { llmContent: 'ok', returnDisplay: 'ok' };
      });

      const signal = new AbortController().signal;
      const updateOutput = vi.fn();
      await invocation.execute(signal, updateOutput, {
        shellExecutionConfig:
          {} as unknown as ExecuteOptions['shellExecutionConfig'],
      });

      expect(receivedCtx!.signal).toBe(signal);
      expect(receivedCtx!.updateOutput).toBe(updateOutput);
      expect(receivedCtx!.options).toBeDefined();
      // The scattered-arguments signature does not carry callId/toolCallScopeId.
      expect(receivedCtx!.callId).toBeUndefined();
      expect(receivedCtx!.toolCallScopeId).toBeUndefined();
    });
  });
});
