/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evaluatePreToolUseHook } from './preToolUseEvaluation.js';
import type { Config } from '../config/config.js';
import type { HookSystem } from './hookSystem.js';
import type { AnyDeclarativeTool, AnyToolInvocation } from '../tools/tools.js';
import type { ToolCallRequestInfo } from '../tool-executor/types.js';
import { PreToolUseHookOutput } from './types.js';
import { ToolErrorType } from '../tools/tool-error.js';
import type { AggregatedHookResult } from './hookAggregator.js';

function makeRequest(
  overrides?: Partial<ToolCallRequestInfo>,
): ToolCallRequestInfo {
  return {
    callId: 'call-1',
    name: 'test_tool',
    args: {},
    prompt_id: 'prompt-1',
    ...overrides,
  };
}

function aggregatedHookResult(
  finalOutput?: PreToolUseHookOutput,
): AggregatedHookResult {
  const result: AggregatedHookResult = {
    success: true,
    allOutputs: [],
    errors: [],
    totalDuration: 0,
  };
  if (finalOutput) {
    result.finalOutput = finalOutput;
  }
  return result;
}

describe('evaluatePreToolUseHook', () => {
  let mockHookSystem: HookSystem;
  let mockConfig: Config;
  let mockTool: AnyDeclarativeTool;
  let mockInvocation: AnyToolInvocation;

  beforeEach(() => {
    mockHookSystem = {
      firePreToolUseEvent: vi.fn(),
    } as unknown as HookSystem;

    mockConfig = {
      getHookSystem: vi.fn().mockReturnValue(mockHookSystem),
      getMcpClientManager: vi.fn().mockReturnValue(undefined),
      getMcpServers: vi.fn().mockReturnValue({}),
    } as unknown as Config;

    mockInvocation = {
      params: { key: 'value' },
    } as unknown as AnyToolInvocation;

    mockTool = {
      build: vi.fn().mockReturnValue(mockInvocation),
    } as unknown as AnyDeclarativeTool;
  });

  it('should return continue when no hook system is configured', async () => {
    const noHookConfig = {
      getHookSystem: vi.fn().mockReturnValue(undefined),
      getMcpClientManager: vi.fn().mockReturnValue(undefined),
      getMcpServers: vi.fn().mockReturnValue({}),
    } as unknown as Config;

    const result = await evaluatePreToolUseHook(
      noHookConfig,
      mockTool,
      makeRequest(),
      mockInvocation,
    );

    expect(result).toEqual({ status: 'continue' });
  });

  it('should return continue when hook returns nothing', async () => {
    vi.mocked(mockHookSystem.firePreToolUseEvent).mockResolvedValue(
      aggregatedHookResult(),
    );

    const result = await evaluatePreToolUseHook(
      mockConfig,
      mockTool,
      makeRequest(),
      mockInvocation,
    );

    expect(result).toEqual({ status: 'continue' });
  });

  it('should return stop execution error when continue: false', async () => {
    vi.mocked(mockHookSystem.firePreToolUseEvent).mockResolvedValue(
      aggregatedHookResult({
        shouldStopExecution: () => true,
        getEffectiveReason: () => 'Stop immediately',
        getBlockingError: () => ({ blocked: false, reason: '' }),
      } as unknown as PreToolUseHookOutput),
    );

    const result = await evaluatePreToolUseHook(
      mockConfig,
      mockTool,
      makeRequest(),
      mockInvocation,
    );

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.errorType).toBe(ToolErrorType.STOP_EXECUTION);
      expect(result.error.message).toContain('Stop immediately');
    }
  });

  it('should prioritize continue: false over blocking error', async () => {
    vi.mocked(mockHookSystem.firePreToolUseEvent).mockResolvedValue(
      aggregatedHookResult({
        shouldStopExecution: () => true,
        getEffectiveReason: () => 'Stop wins',
        getBlockingError: () => ({
          blocked: true,
          reason: 'This should be ignored',
        }),
      } as unknown as PreToolUseHookOutput),
    );

    const result = await evaluatePreToolUseHook(
      mockConfig,
      mockTool,
      makeRequest(),
      mockInvocation,
    );

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.errorType).toBe(ToolErrorType.STOP_EXECUTION);
      expect(result.error.message).toContain('Stop wins');
    }
  });

  it('should return blocking error with attribution when hook blocks', async () => {
    vi.mocked(mockHookSystem.firePreToolUseEvent).mockResolvedValue(
      aggregatedHookResult({
        shouldStopExecution: () => false,
        getBlockingError: () => ({
          blocked: true,
          reason: 'Blocked by policy',
          hookName: 'security-check',
          hookCommand: './check.sh',
        }),
      } as unknown as PreToolUseHookOutput),
    );

    const result = await evaluatePreToolUseHook(
      mockConfig,
      mockTool,
      makeRequest(),
      mockInvocation,
    );

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.errorType).toBe(ToolErrorType.POLICY_VIOLATION);
      expect(result.error.message).toBe(
        'security-check hook blocking error from command: "./check.sh": Blocked by policy',
      );
    }
  });

  it('should return blocking error without attribution when hookName is missing', async () => {
    vi.mocked(mockHookSystem.firePreToolUseEvent).mockResolvedValue(
      aggregatedHookResult({
        shouldStopExecution: () => false,
        getBlockingError: () => ({
          blocked: true,
          reason: 'Blocked',
        }),
      } as unknown as PreToolUseHookOutput),
    );

    const result = await evaluatePreToolUseHook(
      mockConfig,
      mockTool,
      makeRequest(),
      mockInvocation,
    );

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error.message).toBe('Tool execution blocked: Blocked');
    }
  });

  it('should return ask decision when hook returns ask', async () => {
    vi.mocked(mockHookSystem.firePreToolUseEvent).mockResolvedValue(
      aggregatedHookResult({
        shouldStopExecution: () => false,
        getBlockingError: () => ({ blocked: false }),
        isAskDecision: () => true,
        getAdditionalContext: () => undefined,
        decision: 'ask',
        reason: 'Please confirm this action',
        systemMessage: 'UI-only warning',
      } as unknown as PreToolUseHookOutput),
    );

    const result = await evaluatePreToolUseHook(
      mockConfig,
      mockTool,
      makeRequest(),
      mockInvocation,
    );

    expect(result.status).toBe('continue');
    if (result.status === 'continue') {
      expect(result.hookDecision).toBe('ask');
      expect(result.hookSystemMessage).toBe('Please confirm this action');
    }
  });

  it('should return allow decision when hook explicitly allows', async () => {
    vi.mocked(mockHookSystem.firePreToolUseEvent).mockResolvedValue(
      aggregatedHookResult({
        shouldStopExecution: () => false,
        getBlockingError: () => ({ blocked: false }),
        isAskDecision: () => false,
        getAdditionalContext: () => undefined,
        decision: 'allow',
      } as unknown as PreToolUseHookOutput),
    );

    const result = await evaluatePreToolUseHook(
      mockConfig,
      mockTool,
      makeRequest(),
      mockInvocation,
    );

    expect(result.status).toBe('continue');
    if (result.status === 'continue') {
      expect(result.hookDecision).toBe('allow');
    }
  });

  it('should return modified args when hook modifies tool input', async () => {
    const modifiedInput = { key: 'modified' };
    const mockBeforeOutput = new PreToolUseHookOutput({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: modifiedInput,
      },
    });
    vi.mocked(mockHookSystem.firePreToolUseEvent).mockResolvedValue(
      aggregatedHookResult(mockBeforeOutput),
    );

    const newInvocation = {
      params: modifiedInput,
    } as unknown as AnyToolInvocation;
    vi.mocked(mockTool.build).mockReturnValue(newInvocation);

    const result = await evaluatePreToolUseHook(
      mockConfig,
      mockTool,
      makeRequest(),
      mockInvocation,
    );

    expect(result.status).toBe('continue');
    if (result.status === 'continue') {
      expect(result.modifiedArgs).toEqual(modifiedInput);
      expect(result.newInvocation).toBe(newInvocation);
      expect(mockTool.build).toHaveBeenCalledWith(modifiedInput, undefined);
    }
  });

  it('should return error when modified args fail validation', async () => {
    const mockBeforeOutput = new PreToolUseHookOutput({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { key: 'bad' },
      },
    });
    vi.mocked(mockHookSystem.firePreToolUseEvent).mockResolvedValue(
      aggregatedHookResult(mockBeforeOutput),
    );

    vi.mocked(mockTool.build).mockImplementation(() => {
      throw new Error('Invalid parameter: key');
    });

    const result = await evaluatePreToolUseHook(
      mockConfig,
      mockTool,
      makeRequest(),
      mockInvocation,
    );

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.errorType).toBe(ToolErrorType.INVALID_TOOL_PARAMS);
      expect(result.error.message).toContain('Invalid parameter: key');
    }
  });

  it('should return additionalContext when hook provides it', async () => {
    const mockBeforeOutput = new PreToolUseHookOutput({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: 'important context',
      },
    });
    vi.mocked(mockHookSystem.firePreToolUseEvent).mockResolvedValue(
      aggregatedHookResult(mockBeforeOutput),
    );

    const result = await evaluatePreToolUseHook(
      mockConfig,
      mockTool,
      makeRequest(),
      mockInvocation,
    );

    expect(result.status).toBe('continue');
    if (result.status === 'continue') {
      expect(result.additionalContext).toBe('important context');
    }
  });

  it('should not return modifiedArgs when hook does not provide tool_input', async () => {
    const mockBeforeOutput = new PreToolUseHookOutput({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        // No updatedInput
      },
    });
    vi.mocked(mockHookSystem.firePreToolUseEvent).mockResolvedValue(
      aggregatedHookResult(mockBeforeOutput),
    );

    const result = await evaluatePreToolUseHook(
      mockConfig,
      mockTool,
      makeRequest(),
      mockInvocation,
    );

    expect(result.status).toBe('continue');
    if (result.status === 'continue') {
      expect(result.modifiedArgs).toBeUndefined();
      expect(result.newInvocation).toBeUndefined();
      expect(mockTool.build).not.toHaveBeenCalled();
    }
  });
});
