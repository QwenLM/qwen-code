/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  mapHookDecisionToPermission,
  translatePreToolHookOutput,
  translatePostToolHookOutput,
  resolveHookPermissionDecision,
  handlePostToolUseFailure,
  applyFailureHookResult,
} from './tool-hooks.js';
import { DefaultHookOutput, PreToolUseHookOutput } from '../hooks/types.js';
import type { PostToolUseFailureHookResult } from './hook-types.js';
import type { PermissionDecision } from './tool-types.js';
import type { ToolResult } from './tools.js';

// ==================== mapHookDecisionToPermission ====================

describe('mapHookDecisionToPermission', () => {
  it('maps allow to allow', () => {
    expect(mapHookDecisionToPermission('allow')).toBe('allow');
  });

  it('maps deny to deny', () => {
    expect(mapHookDecisionToPermission('deny')).toBe('deny');
  });

  it('maps ask to ask', () => {
    expect(mapHookDecisionToPermission('ask')).toBe('ask');
  });

  it('maps undefined to none', () => {
    expect(mapHookDecisionToPermission(undefined)).toBe('none');
  });
});

// ==================== translatePreToolHookOutput ====================

describe('translatePreToolHookOutput', () => {
  it('returns undefined for null/undefined input', () => {
    expect(translatePreToolHookOutput(null)).toBeUndefined();
    expect(translatePreToolHookOutput(undefined)).toBeUndefined();
  });

  it('translates a simple allow decision', () => {
    const output = new DefaultHookOutput({ decision: 'allow' });
    const result = translatePreToolHookOutput(output);
    expect(result).toBeDefined();
    expect(result!.hookPermissionResult).toBe('allow');
    expect(result!.stop).toBeUndefined();
    expect(result!.preventContinuation).toBeUndefined();
  });

  it('translates a deny/block decision with reason', () => {
    const output = new DefaultHookOutput({
      decision: 'deny',
      reason: 'forbidden',
    });
    const result = translatePreToolHookOutput(output);
    expect(result!.hookPermissionResult).toBe('deny');
    expect(result!.preventContinuation).toBe(true);
    expect(result!.reason).toBe('forbidden');
  });

  it('translates stop execution', () => {
    const output = new DefaultHookOutput({
      continue: false,
      stopReason: 'halt',
    });
    const result = translatePreToolHookOutput(output);
    expect(result!.stop).toBe(true);
    expect(result!.preventContinuation).toBe(true);
    expect(result!.reason).toBe('halt');
  });

  it('extracts modified input from PreToolUseHookOutput', () => {
    const output = new PreToolUseHookOutput({
      hookSpecificOutput: {
        updatedInput: { path: '/new/path' },
      },
    });
    const result = translatePreToolHookOutput(output);
    expect(result!.hookUpdatedInput).toEqual({ path: '/new/path' });
  });

  it('does not extract modified input from DefaultHookOutput', () => {
    const output = new DefaultHookOutput({
      hookSpecificOutput: {
        tool_input: { path: '/new/path' },
      },
    });
    const result = translatePreToolHookOutput(output);
    expect(result!.hookUpdatedInput).toBeUndefined();
  });

  it('extracts additional context', () => {
    const output = new DefaultHookOutput({
      hookSpecificOutput: {
        additionalContext: 'some context',
      },
    });
    const result = translatePreToolHookOutput(output);
    expect(result!.additionalContext).toBe('some context');
  });
});

// ==================== translatePostToolHookOutput ====================

describe('translatePostToolHookOutput', () => {
  it('returns undefined for null/undefined input', () => {
    expect(translatePostToolHookOutput(null)).toBeUndefined();
    expect(translatePostToolHookOutput(undefined)).toBeUndefined();
  });

  it('translates stop execution', () => {
    const output = new DefaultHookOutput({
      continue: false,
      stopReason: 'done',
    });
    const result = translatePostToolHookOutput(output);
    expect(result!.stop).toBe(true);
    expect(result!.reason).toBe('done');
  });

  it('translates blocking error', () => {
    const output = new DefaultHookOutput({
      decision: 'deny',
      reason: 'bad result',
    });
    const result = translatePostToolHookOutput(output);
    expect(result!.blockingError).toBe('bad result');
  });

  it('translates additional context', () => {
    const output = new DefaultHookOutput({
      hookSpecificOutput: {
        additionalContext: 'extra info',
      },
    });
    const result = translatePostToolHookOutput(output);
    expect(result!.additionalContexts).toEqual(['extra info']);
  });

  it('returns empty result for no-op hook output', () => {
    const output = new DefaultHookOutput({});
    const result = translatePostToolHookOutput(output);
    expect(result).toBeDefined();
    expect(result!.stop).toBeUndefined();
    expect(result!.blockingError).toBeUndefined();
    expect(result!.additionalContexts).toBeUndefined();
  });
});

// ==================== resolveHookPermissionDecision ====================

describe('resolveHookPermissionDecision', () => {
  it('hook deny overrides everything', () => {
    const policy: PermissionDecision = { decision: 'allow' };
    const result = resolveHookPermissionDecision('deny', policy);
    expect(result.decision).toBe('deny');
    expect(result.source).toBe('hook');
  });

  it('policy deny overrides hook allow', () => {
    const policy: PermissionDecision = {
      decision: 'deny',
      reason: 'policy says no',
    };
    const result = resolveHookPermissionDecision('allow', policy);
    expect(result.decision).toBe('deny');
    expect(result.source).toBe('permission');
    expect(result.reason).toBe('policy says no');
  });

  it('hook allow passes when policy is not deny', () => {
    const policy: PermissionDecision = { decision: 'ask_user' };
    const result = resolveHookPermissionDecision('allow', policy);
    expect(result.decision).toBe('allow');
    expect(result.source).toBe('hook');
  });

  it('hook ask produces ask_user', () => {
    const policy: PermissionDecision = { decision: 'allow' };
    const result = resolveHookPermissionDecision('ask', policy);
    expect(result.decision).toBe('ask_user');
    expect(result.source).toBe('hook');
  });

  it('hook none falls through to policy', () => {
    const policy: PermissionDecision = {
      decision: 'ask_user',
      reason: 'need confirmation',
    };
    const result = resolveHookPermissionDecision('none', policy);
    expect(result.decision).toBe('ask_user');
    expect(result.source).toBe('permission');
  });

  it('defaults to allow when both are undefined', () => {
    const result = resolveHookPermissionDecision(undefined, undefined);
    expect(result.decision).toBe('allow');
    expect(result.source).toBe('default');
  });

  it('hook deny overrides policy deny (hook is source)', () => {
    const policy: PermissionDecision = { decision: 'deny', reason: 'policy' };
    const result = resolveHookPermissionDecision('deny', policy);
    expect(result.decision).toBe('deny');
    expect(result.source).toBe('hook');
  });
});

// ==================== handlePostToolUseFailure ====================

describe('handlePostToolUseFailure', () => {
  it('returns undefined when no handler is provided', async () => {
    const result = await handlePostToolUseFailure(
      'test-tool',
      new Error('oops'),
      {},
    );
    expect(result).toBeUndefined();
  });

  it('calls the handler and returns its result', async () => {
    const recoveredResult: ToolResult = {
      llmContent: 'recovered',
      returnDisplay: 'recovered',
    };
    const handler = vi.fn().mockResolvedValue({
      recoveredResult,
    } satisfies PostToolUseFailureHookResult);

    const result = await handlePostToolUseFailure(
      'test-tool',
      new Error('oops'),
      { key: 'value' },
      handler,
    );

    expect(handler).toHaveBeenCalledWith('test-tool', expect.any(Error), {
      key: 'value',
    });
    expect(result?.recoveredResult).toBe(recoveredResult);
  });

  it('swallows handler errors and returns undefined', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('handler crashed'));
    const result = await handlePostToolUseFailure(
      'test-tool',
      new Error('original'),
      {},
      handler,
    );
    expect(result).toBeUndefined();
  });

  it('returns enhanced error from handler', async () => {
    const handler = vi.fn().mockResolvedValue({
      enhancedError: 'Better error message: file not found at /path',
    } satisfies PostToolUseFailureHookResult);

    const result = await handlePostToolUseFailure(
      'test-tool',
      new Error('original'),
      {},
      handler,
    );
    expect(result?.enhancedError).toBe(
      'Better error message: file not found at /path',
    );
  });
});

// ==================== applyFailureHookResult ====================

describe('applyFailureHookResult', () => {
  const originalError = new Error('original error');

  it('returns original error when no failure result', () => {
    const applied = applyFailureHookResult(undefined, originalError);
    expect(applied.recovered).toBe(false);
    if (!applied.recovered) {
      expect(applied.error).toBe(originalError);
    }
  });

  it('returns original error when failure result is empty', () => {
    const applied = applyFailureHookResult({}, originalError);
    expect(applied.recovered).toBe(false);
    if (!applied.recovered) {
      expect(applied.error).toBe(originalError);
    }
  });

  it('returns recovered result when provided', () => {
    const recoveredResult: ToolResult = {
      llmContent: 'recovered content',
      returnDisplay: 'recovered display',
    };
    const applied = applyFailureHookResult({ recoveredResult }, originalError);
    expect(applied.recovered).toBe(true);
    if (applied.recovered) {
      expect(applied.result).toBe(recoveredResult);
    }
  });

  it('returns enhanced error when provided', () => {
    const applied = applyFailureHookResult(
      { enhancedError: 'enhanced message' },
      originalError,
    );
    expect(applied.recovered).toBe(false);
    if (!applied.recovered) {
      expect(applied.error.message).toBe('enhanced message');
      expect(applied.error.cause).toBe(originalError);
    }
  });

  it('prioritizes recovery over enhanced error', () => {
    const recoveredResult: ToolResult = {
      llmContent: 'recovered',
      returnDisplay: 'recovered',
    };
    const applied = applyFailureHookResult(
      { recoveredResult, enhancedError: 'should be ignored' },
      originalError,
    );
    expect(applied.recovered).toBe(true);
  });
});
