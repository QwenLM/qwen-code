/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createToolExecuteCallback,
  createToolPreExecutionGate,
  type ToolGateOptions,
} from './pre-execution-gate.js';
import { evaluatePreToolUseHook } from '../../hooks/preToolUseEvaluation.js';
import { createPermissionManager } from '../../test-utils/config.js';
import type { ConfigService } from '../../config-service/config-service.js';
import type { PermissionPolicySnapshot } from '../../permissions/manager/policy.js';
import type { AskHandler } from '../../permissions/manager/decision/index.js';
import type { ToolPermissionReason } from '../../tools/tool-checkers/checker-reasons.js';
import { createAskFactsStore } from '../../permissions/ask-handler/ask-facts.js';
import { runToolUseLifecycle } from '../../tools/tool-execution-lifecycle.js';
import type {
  AnyToolInvocation,
  AnyDeclarativeTool,
} from '../../tools/tools.js';
import type { ToolCallRequestInfo } from '../types.js';

vi.mock('../../hooks/preToolUseEvaluation.js');

function makeRequest(
  overrides: Partial<ToolCallRequestInfo> = {},
): ToolCallRequestInfo {
  return {
    callId: 'call-1',
    name: 'test-tool',
    args: {},
    prompt_id: 'prompt-1',
    toolCallScopeId: 'root',
    ...overrides,
  };
}

function makeTool(name: string): AnyDeclarativeTool {
  return {
    name,
    build: vi.fn().mockReturnValue({}),
    isConcurrencySafe: () => true,
  } as unknown as AnyDeclarativeTool;
}

function makeGateOptions(overrides: Partial<ToolGateOptions>): ToolGateOptions {
  return {
    resolveTool: vi.fn(),
    toolExecutor: {
      execute: vi.fn().mockResolvedValue({
        result: { llmContent: 'ok', returnDisplay: 'Success' },
      }),
    } as unknown as ToolGateOptions['toolExecutor'],
    state: {
      updateStatus: vi.fn(),
      updateArgs: vi.fn(),
      finalizeCall: vi.fn(),
    } as unknown as ToolGateOptions['state'],
    config: {
      getPermissionMode: () => 'yolo',
      getSessionId: () => 'session-1',
      getHookSystem: () => undefined,
      permissionAskChannel: { askFacts: createAskFactsStore() },
    } as unknown as ToolGateOptions['config'],
    context: {} as ToolGateOptions['context'],
    toolCallScopeId: 'root',
    ...overrides,
  };
}

describe('managed approval handoff from gate to execution', () => {
  it('still prompts for an outside-workspace redirect after a hook allows Bash', async () => {
    const { initializeShellParsers } = await import(
      '../../utils/shell-utils.js'
    );
    await initializeShellParsers();
    const askHandler = vi.fn<AskHandler<ToolPermissionReason>>(async () => ({
      kind: 'rejected',
    }));
    const permission = createPermissionManager({
      cwd: '/repo',
      permissionMode: 'default',
      askHandler,
      checkerDeps: {
        skill: {
          isAllowedForMainSession: () => true,
          isDisabled: () => false,
          hasOnlySafeProperties: () => true,
        },
        mcpCall: { isKnownTool: () => false, parseQualifiedName: () => ({}) },
      },
    });
    const options = makeGateOptions({
      context: { permission } as ToolGateOptions['context'],
    });
    const request = makeRequest({
      name: 'Bash',
      args: { command: 'echo hi > /elsewhere/out.txt' },
    });
    vi.mocked(evaluatePreToolUseHook).mockResolvedValue({
      status: 'continue',
      hookDecision: 'allow',
    });
    const result = await createToolPreExecutionGate(options)(
      { params: request.args } as AnyToolInvocation,
      request,
      makeTool('Bash'),
      new AbortController().signal,
    );
    expect(askHandler).toHaveBeenCalledOnce();
    expect(result.status).toBe('denied');
    expect(options.toolExecutor.execute).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    vi.mocked(evaluatePreToolUseHook).mockResolvedValue({
      status: 'continue',
    } as Awaited<ReturnType<typeof evaluatePreToolUseHook>>);
  });
  function setup(
    initial: PermissionPolicySnapshot['rules'],
    handler?: AskHandler<ToolPermissionReason>,
    permissionContext?: ToolGateOptions['context']['permissionContext'],
  ) {
    let rules = initial;
    const source: ConfigService = {
      start: async () => {},
      stop: async () => {},
      getValue: <T>() => ({ disabledModes: [], rules }) as T,
      onValueChange: () => () => {},
      onError: () => () => {},
    };
    const permission = createPermissionManager({
      cwd: '/repo',
      permissionMode: 'yolo',
      organizationPolicy: source,
      askHandler: handler,
      checkerDeps: {
        skill: {
          isAllowedForMainSession: () => true,
          isDisabled: () => false,
          hasOnlySafeProperties: () => true,
        },
        mcpCall: { isKnownTool: () => false, parseQualifiedName: () => ({}) },
      },
    });
    const options = makeGateOptions({
      context: {
        permission,
        permissionContext,
      } as ToolGateOptions['context'],
    });
    const request = makeRequest({
      name: 'Agent',
      args: { subagent_type: 'explore' },
    });
    const invocation = { params: request.args } as AnyToolInvocation;
    const tool = makeTool('Agent');
    const signal = new AbortController().signal;
    const gate = createToolPreExecutionGate(options);
    const execute = createToolExecuteCallback(options);
    return {
      permission,
      request,
      options,
      invocation,
      tool,
      signal,
      gate: () => gate(invocation, request, tool, signal),
      execute: () => execute(invocation, request, tool, signal),
      update(next: PermissionPolicySnapshot['rules']) {
        rules = next;
      },
    };
  }

  it('blocks execution when managed deny arrives during approval', async () => {
    const handler = vi.fn<AskHandler<ToolPermissionReason>>(async () => {
      s.update({ deny: ['Agent(Explore)'], ask: [] });
      return { kind: 'approved' };
    });
    const s = setup({ deny: [], ask: ['Agent(Explore)'] }, handler);
    const result = await runToolUseLifecycle({
      invocation: s.invocation,
      request: s.request,
      tool: s.tool,
      signal: s.signal,
      preExecutionGate: createToolPreExecutionGate(s.options),
      execute: (invocation, signal) =>
        createToolExecuteCallback(s.options)(
          invocation,
          s.request,
          s.tool,
          signal,
        ),
    });
    expect(result.stage).toBe('pre-gate');
    expect(result.preExecutionStatus).toBe('denied');
    expect(handler).toHaveBeenCalledOnce();
    expect(s.options.toolExecutor.execute).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'checks approved args before rebuilding and executing (denied=%s)',
    async (denied) => {
      const input = { subagent_type: 'build' };
      const handler = vi.fn<AskHandler<ToolPermissionReason>>(async () => ({
        kind: 'approved',
        input,
      }));
      const s = setup(
        { deny: denied ? ['Agent(Build)'] : [], ask: ['Agent(Explore)'] },
        handler,
      );
      vi.mocked(s.tool.build).mockReturnValue({
        params: input,
      } as AnyToolInvocation);
      const result = await runToolUseLifecycle({
        invocation: s.invocation,
        request: s.request,
        tool: s.tool,
        signal: s.signal,
        preExecutionGate: createToolPreExecutionGate(s.options),
        execute: (invocation, signal) =>
          createToolExecuteCallback(s.options)(
            invocation,
            s.request,
            s.tool,
            signal,
          ),
      });
      expect(handler).toHaveBeenCalledOnce();
      expect(s.options.toolExecutor.execute).toHaveBeenCalledTimes(
        denied ? 0 : 1,
      );
      if (denied) {
        expect(result.preExecutionStatus).toBe('denied');
        expect(s.tool.build).not.toHaveBeenCalled();
      } else {
        expect(s.request.args).toEqual(input);
        expect(s.tool.build).toHaveBeenCalledWith(input, undefined);
        expect(
          vi.mocked(s.options.toolExecutor.execute).mock.calls[0][0].call,
        ).toMatchObject({ invocation: { params: input } });
      }
    },
  );

  it('does not duplicate an unchanged managed approval', async () => {
    const handler = vi.fn<AskHandler<ToolPermissionReason>>(async () => ({
      kind: 'approved',
    }));
    const s = setup({ deny: [], ask: ['Agent(Explore)'] }, handler);
    expect((await s.gate()).status).toBe('proceed');
    expect((await s.execute()).error).toBeUndefined();
    expect(handler).toHaveBeenCalledOnce();
  });

  it('keeps parallel calls with the same external call id separate', async () => {
    const s = setup({ deny: ['Agent(Build)'], ask: [] });
    const second = { ...s.request, args: { subagent_type: 'explore' } };
    const invocation = { params: second.args } as AnyToolInvocation;
    expect((await s.gate()).status).toBe('proceed');
    expect(
      (
        await createToolPreExecutionGate(s.options)(
          invocation,
          second,
          s.tool,
          s.signal,
        )
      ).status,
    ).toBe('proceed');
    await s.execute();
    expect(
      (
        await createToolExecuteCallback(s.options)(
          invocation,
          second,
          s.tool,
          s.signal,
        )
      ).error,
    ).toBeUndefined();
    expect(s.options.toolExecutor.execute).toHaveBeenCalledTimes(2);
  });
  it('preserves ordinary execution without command rules', async () => {
    const s = setup(undefined);
    await s.gate();
    expect((await s.execute()).error).toBeUndefined();
    expect(s.options.toolExecutor.execute).toHaveBeenCalledOnce();
  });

  it('allows execution after managed command rules are cleared', async () => {
    const s = setup({ deny: ['Agent(Build)'], ask: [] });
    await s.gate();
    s.update({ deny: [], ask: [] });
    expect((await s.execute()).error).toBeUndefined();
    expect(s.options.toolExecutor.execute).toHaveBeenCalledOnce();
  });
});
