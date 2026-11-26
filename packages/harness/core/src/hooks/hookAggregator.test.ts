/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { HookAggregator } from './hookAggregator.js';
import {
  HookType,
  HookEventName,
  type HookExecutionResult,
  type HookOutput,
} from './types.js';

// Helper function to create proper HookExecutionResult objects
function createHookExecutionResult(
  output?: HookOutput,
  success = true,
  duration = 100,
  error?: Error,
): HookExecutionResult {
  return {
    success,
    output,
    duration,
    error,
    hookConfig: {
      type: HookType.Command,
      command: 'test-command',
      timeout: 30,
    },
    eventName: HookEventName.PreToolUse,
  };
}

describe('HookAggregator', () => {
  let aggregator: HookAggregator;

  beforeEach(() => {
    aggregator = new HookAggregator();
  });

  describe('aggregateResults', () => {
    it('should handle empty results', () => {
      const results: HookExecutionResult[] = [];

      const aggregated = aggregator.aggregateResults(
        results,
        HookEventName.PreToolUse,
      );

      expect(aggregated.success).toBe(true);
      expect(aggregated.allOutputs).toHaveLength(0);
      expect(aggregated.errors).toHaveLength(0);
      expect(aggregated.totalDuration).toBe(0);
      expect(aggregated.finalOutput).toBeUndefined();
    });

    it('should aggregate successful results', () => {
      const results: HookExecutionResult[] = [
        createHookExecutionResult(
          { decision: 'allow', reason: 'Hook 1 approved' },
          true,
          100,
        ),
        createHookExecutionResult(
          { decision: 'allow', reason: 'Hook 2 approved' },
          true,
          150,
        ),
      ];

      const aggregated = aggregator.aggregateResults(
        results,
        HookEventName.PreToolUse,
      );

      expect(aggregated.success).toBe(true);
      expect(aggregated.allOutputs).toHaveLength(2);
      expect(aggregated.errors).toHaveLength(0);
      expect(aggregated.totalDuration).toBe(250);
      // When hooks explicitly return 'allow', the aggregated decision is 'allow'
      // (weakest signal — overridden by deny or ask from other hooks)
      expect(aggregated.finalOutput?.decision).toBe('allow');
      expect(aggregated.finalOutput?.reason).toBe(
        'Hook 1 approved\nHook 2 approved',
      );
    });

    it('should handle errors in results', () => {
      const results: HookExecutionResult[] = [
        {
          hookConfig: {
            type: HookType.Command,
            command: 'test-command',
            timeout: 30,
          },
          eventName: HookEventName.PreToolUse,
          success: false,
          error: new Error('Hook failed'),
          duration: 50,
        },
        {
          hookConfig: {
            type: HookType.Command,
            command: 'test-command',
            timeout: 30,
          },
          eventName: HookEventName.PreToolUse,
          success: true,
          output: { decision: 'allow' },
          duration: 100,
        },
      ];

      const aggregated = aggregator.aggregateResults(
        results,
        HookEventName.PreToolUse,
      );

      expect(aggregated.success).toBe(false);
      expect(aggregated.allOutputs).toHaveLength(1);
      expect(aggregated.errors).toHaveLength(1);
      expect(aggregated.errors[0].message).toBe('Hook failed');
      expect(aggregated.totalDuration).toBe(150);
    });

    it('should handle blocking decisions with OR logic', () => {
      const results: HookExecutionResult[] = [
        {
          hookConfig: {
            type: HookType.Command,
            command: 'test-command',
            timeout: 30,
          },
          eventName: HookEventName.PreToolUse,
          success: true,
          output: { decision: 'allow', reason: 'Hook 1 allowed' },
          duration: 100,
        },
        {
          hookConfig: {
            type: HookType.Command,
            command: 'test-command',
            timeout: 30,
          },
          eventName: HookEventName.PreToolUse,
          success: true,
          output: { decision: 'deny', reason: 'Hook 2 blocked' },
          duration: 150,
        },
      ];

      const aggregated = aggregator.aggregateResults(
        results,
        HookEventName.PreToolUse,
      );

      expect(aggregated.success).toBe(true);
      expect(aggregated.finalOutput?.decision).toBe('deny');
      expect(aggregated.finalOutput?.reason).toBe(
        'Hook 1 allowed\nHook 2 blocked',
      );
    });

    it('PreCompact: any blocker wins in OR-decision merge', () => {
      const results: HookExecutionResult[] = [
        {
          ...createHookExecutionResult({
            decision: 'allow',
            reason: 'Hook 1 allowed',
          }),
          eventName: HookEventName.PreCompact,
        },
        {
          ...createHookExecutionResult({
            decision: 'deny',
            reason: 'Hook 2 blocked compaction',
          }),
          eventName: HookEventName.PreCompact,
        },
      ];

      const aggregated = aggregator.aggregateResults(
        results,
        HookEventName.PreCompact,
      );

      expect(aggregated.success).toBe(true);
      expect(aggregated.finalOutput?.decision).toBe('deny');
      expect(aggregated.finalOutput?.reason).toBe(
        'Hook 1 allowed\nHook 2 blocked compaction',
      );
      expect(aggregated.finalOutput?.isBlockingDecision?.()).toBe(true);
    });

    it('should preserve modelInjection for blocking Stop hooks', () => {
      const results: HookExecutionResult[] = [
        createHookExecutionResult({
          decision: 'deny',
          reason: 'Goal still active',
          modelInjection: 'Continue working on the active goal.',
        }),
      ];

      const aggregated = aggregator.aggregateResults(
        results,
        HookEventName.Stop,
      );

      expect(aggregated.success).toBe(true);
      expect(aggregated.finalOutput?.decision).toBe('deny');
      expect(aggregated.finalOutput?.modelInjection).toBe(
        'Continue working on the active goal.',
      );
      expect(aggregated.finalOutput?.getEffectiveReason()).toBe(
        'Goal still active',
      );
    });

    it('should handle continue=false with precedence', () => {
      const results: HookExecutionResult[] = [
        {
          hookConfig: {
            type: HookType.Command,
            command: 'test-command',
            timeout: 30,
          },
          eventName: HookEventName.PreToolUse,
          success: true,
          output: { decision: 'allow', continue: true },
          duration: 100,
        },
        {
          hookConfig: {
            type: HookType.Command,
            command: 'test-command',
            timeout: 30,
          },
          eventName: HookEventName.PreToolUse,
          success: true,
          output: {
            decision: 'allow',
            continue: false,
            stopReason: 'Stop requested',
          },
          duration: 150,
        },
      ];

      const aggregated = aggregator.aggregateResults(
        results,
        HookEventName.PreToolUse,
      );

      expect(aggregated.success).toBe(true);
      expect(aggregated.finalOutput?.continue).toBe(false);
      expect(aggregated.finalOutput?.stopReason).toBe('Stop requested');
    });
  });

  describe('successfulHookCount', () => {
    it('reports zero for an empty result set', () => {
      const aggregated = aggregator.aggregateResults(
        [],
        HookEventName.WorktreeRemove,
      );

      expect(aggregated.successfulHookCount).toBe(0);
      expect(aggregated.success).toBe(true);
    });

    it('counts every hook when all of them succeed', () => {
      const results: HookExecutionResult[] = [
        createHookExecutionResult(undefined, true, 10),
        createHookExecutionResult(undefined, true, 20),
        createHookExecutionResult(undefined, true, 30),
      ];

      const aggregated = aggregator.aggregateResults(
        results,
        HookEventName.WorktreeRemove,
      );

      expect(aggregated.successfulHookCount).toBe(3);
      expect(aggregated.success).toBe(true);
    });

    it('counts only the successful hooks when some of them fail', () => {
      const results: HookExecutionResult[] = [
        createHookExecutionResult(undefined, false, 10, new Error('boom')),
        createHookExecutionResult(undefined, true, 20),
      ];

      const aggregated = aggregator.aggregateResults(
        results,
        HookEventName.WorktreeRemove,
      );

      expect(aggregated.successfulHookCount).toBe(1);
      expect(aggregated.success).toBe(false);
    });

    it('reports zero when every hook fails without producing an error object', () => {
      // A hook process that exits non-zero without throwing leaves `error`
      // unset, so `success` stays true. Callers that own a resource must rely
      // on the count instead, otherwise a total failure looks like a success.
      const results: HookExecutionResult[] = [
        createHookExecutionResult(undefined, false, 10),
        createHookExecutionResult(undefined, false, 20),
      ];

      const aggregated = aggregator.aggregateResults(
        results,
        HookEventName.WorktreeRemove,
      );

      expect(aggregated.errors).toHaveLength(0);
      expect(aggregated.success).toBe(true);
      expect(aggregated.successfulHookCount).toBe(0);
    });

    it('reports zero when every hook fails with an error object', () => {
      const results: HookExecutionResult[] = [
        createHookExecutionResult(undefined, false, 10, new Error('first')),
        createHookExecutionResult(undefined, false, 20, new Error('second')),
      ];

      const aggregated = aggregator.aggregateResults(
        results,
        HookEventName.WorktreeCreate,
      );

      expect(aggregated.successfulHookCount).toBe(0);
      expect(aggregated.success).toBe(false);
      expect(aggregated.errors).toHaveLength(2);
    });

    it.each([['cancelled'], ['blocking'], ['non_blocking_error'], ['error']])(
      'does not count a hook whose outcome is %s despite success=true',
      (outcome) => {
        // Agent hooks report success=true with a non-success outcome, and
        // `outcome` takes precedence. Counting those would let a resource owner
        // believe work happened when it did not.
        const results: HookExecutionResult[] = [
          {
            ...createHookExecutionResult(undefined, true, 10),
            outcome: outcome as HookExecutionResult['outcome'],
          },
        ];

        const aggregated = aggregator.aggregateResults(
          results,
          HookEventName.WorktreeRemove,
        );

        expect(aggregated.successfulHookCount).toBe(0);
      },
    );

    it('counts a hook whose outcome is explicitly success', () => {
      const results: HookExecutionResult[] = [
        {
          ...createHookExecutionResult(undefined, true, 10),
          outcome: 'success',
        },
      ];

      const aggregated = aggregator.aggregateResults(
        results,
        HookEventName.WorktreeRemove,
      );

      expect(aggregated.successfulHookCount).toBe(1);
    });
  });

  describe('suppressOutput prevents systemMessage propagation (H12)', () => {
    it('should not include systemMessage when suppressOutput is true', () => {
      const results: HookExecutionResult[] = [
        createHookExecutionResult(
          {
            decision: 'allow',
            systemMessage: 'visible message',
            suppressOutput: false,
          },
          true,
          100,
        ),
        createHookExecutionResult(
          {
            decision: 'allow',
            systemMessage: 'suppressed message',
            suppressOutput: true,
          },
          true,
          150,
        ),
      ];

      const aggregated = aggregator.aggregateResults(
        results,
        HookEventName.PreToolUse,
      );

      expect(aggregated.finalOutput?.systemMessage).toBe('visible message');
    });

    it('should have no systemMessage when all hooks suppress output', () => {
      const results: HookExecutionResult[] = [
        createHookExecutionResult(
          {
            decision: 'allow',
            systemMessage: 'suppressed 1',
            suppressOutput: true,
          },
          true,
          100,
        ),
        createHookExecutionResult(
          {
            decision: 'allow',
            systemMessage: 'suppressed 2',
            suppressOutput: true,
          },
          true,
          150,
        ),
      ];

      const aggregated = aggregator.aggregateResults(
        results,
        HookEventName.PreToolUse,
      );

      expect(aggregated.finalOutput?.systemMessage).toBeUndefined();
    });

    it('should still set suppressOutput=true on merged result', () => {
      const results: HookExecutionResult[] = [
        createHookExecutionResult(
          {
            decision: 'allow',
            systemMessage: 'suppressed message',
            suppressOutput: true,
          },
          true,
          100,
        ),
      ];

      const aggregated = aggregator.aggregateResults(
        results,
        HookEventName.PreToolUse,
      );

      expect(aggregated.finalOutput?.suppressOutput).toBe(true);
      expect(aggregated.finalOutput?.systemMessage).toBeUndefined();
    });
  });

  describe('extractAdditionalContext', () => {
    it('should extract additional context from hook outputs', () => {
      const results: HookExecutionResult[] = [
        {
          hookConfig: {
            type: HookType.Command,
            command: 'test-command',
            timeout: 30,
          },
          eventName: HookEventName.PostToolUse,
          success: true,
          output: {
            hookSpecificOutput: {
              hookEventName: 'PostToolUse',
              additionalContext: 'Context from hook 1',
            },
          },
          duration: 100,
        },
        {
          hookConfig: {
            type: HookType.Command,
            command: 'test-command',
            timeout: 30,
          },
          eventName: HookEventName.PostToolUse,
          success: true,
          output: {
            hookSpecificOutput: {
              hookEventName: 'PostToolUse',
              additionalContext: 'Context from hook 2',
            },
          },
          duration: 150,
        },
      ];

      const aggregated = aggregator.aggregateResults(
        results,
        HookEventName.PostToolUse,
      );

      expect(aggregated.success).toBe(true);
      expect(
        aggregated.finalOutput?.hookSpecificOutput?.['additionalContext'],
      ).toBe('Context from hook 1\nContext from hook 2');
    });
  });

  describe('permissionDecision in hookSpecificOutput', () => {
    it('should promote hookSpecificOutput.permissionDecision to merged decision', () => {
      const results: HookExecutionResult[] = [
        createHookExecutionResult(
          {
            decision: 'allow',
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
            },
          },
          true,
          100,
        ),
        createHookExecutionResult(
          {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: 'Security policy violation',
            },
          },
          true,
          150,
        ),
      ];

      const aggregated = aggregator.aggregateResults(
        results,
        HookEventName.PreToolUse,
      );

      expect(aggregated.finalOutput?.decision).toBe('deny');
      expect(aggregated.finalOutput?.reason).toContain(
        'Security policy violation',
      );
    });

    it('should let permissionDecision override allow when deny has higher priority', () => {
      const results: HookExecutionResult[] = [
        createHookExecutionResult(
          {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
            },
          },
          true,
          100,
        ),
        createHookExecutionResult(
          {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
            },
          },
          true,
          150,
        ),
      ];

      const aggregated = aggregator.aggregateResults(
        results,
        HookEventName.PreToolUse,
      );

      expect(aggregated.finalOutput?.decision).toBe('deny');
    });

    it('should let permissionDecision override top-level decision (aligns with reference)', () => {
      const results: HookExecutionResult[] = [
        createHookExecutionResult(
          {
            decision: 'deny',
            reason: 'Top-level deny',
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
            },
          },
          true,
          100,
        ),
      ];

      const aggregated = aggregator.aggregateResults(
        results,
        HookEventName.PreToolUse,
      );

      // permissionDecision overrides top-level decision (aligns with reference)
      expect(aggregated.finalOutput?.decision).toBe('allow');
      // permissionDecisionReason is not set, so top-level reason is preserved
      expect(aggregated.finalOutput?.reason).toBe('Top-level deny');
    });

    it('should handle permissionDecision with continue=false', () => {
      const results: HookExecutionResult[] = [
        createHookExecutionResult(
          {
            continue: false,
            stopReason: 'Execution stop requested',
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: 'Policy violation',
            },
          },
          true,
          100,
        ),
      ];

      const aggregated = aggregator.aggregateResults(
        results,
        HookEventName.PreToolUse,
      );

      expect(aggregated.finalOutput?.decision).toBe('deny');
      expect(aggregated.finalOutput?.continue).toBe(false);
      expect(aggregated.finalOutput?.stopReason).toBe(
        'Execution stop requested',
      );
    });
  });

  describe('allow decision aggregation priority', () => {
    it('should propagate allow when it is the only decision', () => {
      const results: HookExecutionResult[] = [
        createHookExecutionResult(
          { decision: 'allow', reason: 'Approved by policy' },
          true,
          100,
        ),
      ];

      const aggregated = aggregator.aggregateResults(
        results,
        HookEventName.PreToolUse,
      );

      expect(aggregated.finalOutput?.decision).toBe('allow');
    });

    it('should let deny override allow', () => {
      const results: HookExecutionResult[] = [
        createHookExecutionResult(
          { decision: 'allow', reason: 'Hook 1 approved' },
          true,
          100,
        ),
        createHookExecutionResult(
          { decision: 'deny', reason: 'Hook 2 denied' },
          true,
          150,
        ),
      ];

      const aggregated = aggregator.aggregateResults(
        results,
        HookEventName.PreToolUse,
      );

      expect(aggregated.finalOutput?.decision).toBe('deny');
    });

    it('should let ask override allow', () => {
      const results: HookExecutionResult[] = [
        createHookExecutionResult(
          { decision: 'allow', reason: 'Hook 1 approved' },
          true,
          100,
        ),
        createHookExecutionResult(
          { decision: 'ask', reason: 'Hook 2 wants confirmation' },
          true,
          150,
        ),
      ];

      const aggregated = aggregator.aggregateResults(
        results,
        HookEventName.PreToolUse,
      );

      expect(aggregated.finalOutput?.decision).toBe('ask');
    });

    it('should keep allow when multiple hooks all return allow (idempotent)', () => {
      const results: HookExecutionResult[] = [
        createHookExecutionResult(
          { decision: 'allow', reason: 'Hook 1' },
          true,
          100,
        ),
        createHookExecutionResult(
          { decision: 'allow', reason: 'Hook 2' },
          true,
          150,
        ),
        createHookExecutionResult(
          { decision: 'allow', reason: 'Hook 3' },
          true,
          200,
        ),
      ];

      const aggregated = aggregator.aggregateResults(
        results,
        HookEventName.PreToolUse,
      );

      expect(aggregated.finalOutput?.decision).toBe('allow');
    });

    it('should not propagate allow when no decision is explicitly set', () => {
      const results: HookExecutionResult[] = [
        createHookExecutionResult(
          { reason: 'Hook with no decision' },
          true,
          100,
        ),
      ];

      const aggregated = aggregator.aggregateResults(
        results,
        HookEventName.PreToolUse,
      );

      expect(aggregated.finalOutput?.decision).toBeUndefined();
    });

    it('exit 2 deny should not be overridden by allow hook permissionDecision', () => {
      const results: HookExecutionResult[] = [
        // Simulates exit 2 hook: success=false, decision='deny', no hookSpecificOutput
        createHookExecutionResult(
          { decision: 'deny', reason: 'Hook blocked with exit code 2' },
          false,
          100,
        ),
        // Simulates JSON allow hook: permissionDecision in hookSpecificOutput
        createHookExecutionResult(
          {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
              permissionDecisionReason: 'test allow',
            },
          },
          true,
          150,
        ),
      ];

      const aggregated = aggregator.aggregateResults(
        results,
        HookEventName.PreToolUse,
      );

      // deny must win — permissionDecision in hookSpecificOutput must not
      // override the priority-merged top-level decision after aggregation.
      expect(aggregated.finalOutput?.decision).toBe('deny');
      expect(aggregated.finalOutput?.isBlockingDecision()).toBe(true);
    });
  });
});
