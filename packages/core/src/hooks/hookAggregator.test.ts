/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { HookAggregator } from './hookAggregator.js';
import { HookEventName, HookType, createHookOutput } from './types.js';
import type {
  DefaultHookOutput,
  HookExecutionResult,
  HookOutput,
  PermissionRequestHookOutput,
  PostToolBatchHookOutput,
  PreToolUseHookOutput,
} from './types.js';

describe('HookAggregator', () => {
  const aggregator = new HookAggregator();

  type ResultFields = Partial<
    Pick<HookExecutionResult, 'success' | 'output' | 'error' | 'duration'>
  > & { command?: string };

  /** Aggregates `event` results; defaults: `echo test`, success, 100ms. */
  const aggregateAll = (event: HookEventName, ...fields: ResultFields[]) =>
    aggregator.aggregateResults(
      fields.map(
        ({ command = 'echo test', ...rest }): HookExecutionResult => ({
          hookConfig: { type: HookType.Command, command },
          eventName: event,
          success: true,
          duration: 100,
          ...rest,
        }),
      ),
      event,
    );

  /** Aggregates one successful `echo test` result per output. */
  const aggregate = (
    event: HookEventName,
    outputs: HookOutput[],
    duration = 100,
  ) => aggregateAll(event, ...outputs.map((output) => ({ output, duration })));

  /** The aggregate of `outputs`, read back through `event`'s output class. */
  const accessorsFor = <T extends DefaultHookOutput = DefaultHookOutput>(
    event: HookEventName,
    outputs: HookOutput[],
  ) =>
    createHookOutput(event, aggregate(event, outputs).finalOutput ?? {}) as T;

  describe('aggregateResults', () => {
    it('should return undefined finalOutput when no results', () => {
      const result = aggregator.aggregateResults([], HookEventName.PreToolUse);
      expect(result.success).toBe(true);
      expect(result.finalOutput).toBeUndefined();
      expect(result.allOutputs).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it('should aggregate successful results', () => {
      const result = aggregate(HookEventName.PreToolUse, [{ continue: true }]);
      expect(result.success).toBe(true);
      expect(result.finalOutput).toBeDefined();
    });

    it('should set success false when there are errors', () => {
      const result = aggregateAll(HookEventName.PreToolUse, {
        success: false,
        error: new Error('Hook failed'),
      });
      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
    });

    it('should calculate total duration', () => {
      const result = aggregateAll(
        HookEventName.PreToolUse,
        { command: 'echo 1' },
        { command: 'echo 2', duration: 200 },
      );
      expect(result.totalDuration).toBe(300);
    });
  });

  describe('mergeWithOrLogic - PreToolUse', () => {
    it('should concatenate reasons', () => {
      const result = aggregate(HookEventName.PreToolUse, [
        { reason: 'first reason', decision: 'allow' },
        { reason: 'second reason', decision: 'allow' },
      ]);
      expect(result.finalOutput?.reason).toBe('first reason\nsecond reason');
    });

    it('should block when any hook blocks', () => {
      const result = aggregate(HookEventName.PreToolUse, [
        { reason: 'allowed', decision: 'allow' },
        { reason: 'blocked', decision: 'block' },
      ]);
      expect(result.finalOutput?.decision).toBe('block');
    });

    it('should use last stopReason', () => {
      const result = aggregate(HookEventName.Stop, [
        { continue: false, stopReason: 'first stop' },
        { continue: false, stopReason: 'second stop' },
      ]);
      expect(result.finalOutput?.stopReason).toBe('second stop');
    });

    it('should concatenate additionalContext', () => {
      const result = aggregate(HookEventName.PreToolUse, [
        { hookSpecificOutput: { additionalContext: 'context 1' } },
        { hookSpecificOutput: { additionalContext: 'context 2' } },
      ]);
      expect(
        result.finalOutput?.hookSpecificOutput?.['additionalContext'],
      ).toBe('context 1\ncontext 2');
    });

    it('should preserve other hookSpecificOutput fields', () => {
      const result = aggregate(HookEventName.PostToolUse, [
        {
          decision: 'allow',
          reason: 'Test reason 1',
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: 'ctx',
          },
        },
        {
          decision: 'allow',
          reason: 'Test reason 2',
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: 'ctx2',
          },
        },
      ]);
      expect(
        result.finalOutput?.hookSpecificOutput?.['additionalContext'],
      ).toBe('ctx\nctx2');
    });

    it('should concatenate artifact arrays and drop malformed artifacts fields', () => {
      const result = aggregate(HookEventName.PostToolUse, [
        {
          hookSpecificOutput: {
            artifacts: [
              { title: 'Report', workspacePath: 'report.html' },
              { workspacePath: 'missing-title.html' },
              null,
            ],
          },
        },
        {
          hookSpecificOutput: {
            artifacts: { title: 'Malformed' },
            other: 'kept',
          },
        },
      ]);

      expect(result.finalOutput?.hookSpecificOutput).toMatchObject({
        artifacts: [{ title: 'Report', workspacePath: 'report.html' }],
        other: 'kept',
      });
    });

    it('should preserve PostToolBatch stop decisions across multiple hooks', () => {
      const hookOutput = accessorsFor<PostToolBatchHookOutput>(
        HookEventName.PostToolBatch,
        [
          { continue: false, stopReason: 'first hook stopped' },
          { continue: true },
        ],
      );
      expect(hookOutput.shouldStopExecution()).toBe(true);
      expect(hookOutput.getEffectiveReason()).toBe('first hook stopped');
    });

    it('should preserve PostToolBatch deny decisions after aggregation', () => {
      const hookOutput = accessorsFor<PostToolBatchHookOutput>(
        HookEventName.PostToolBatch,
        [{ decision: 'deny', reason: 'blocked' }, { decision: 'allow' }],
      );
      expect(hookOutput.shouldStopExecution()).toBe(true);
      expect(hookOutput.getEffectiveReason()).toBe('blocked');
    });
  });

  // Verified through PermissionRequestHookOutput's accessors, which ensures
  // the merged output is consumable by that class.
  describe('mergePermissionRequestOutputs', () => {
    const permission = (...decisions: Array<Record<string, unknown>>) =>
      accessorsFor<PermissionRequestHookOutput>(
        HookEventName.PermissionRequest,
        decisions.map((decision) => ({ hookSpecificOutput: { decision } })),
      );

    it('should prioritize deny over allow', () => {
      const hookOutput = permission(
        { behavior: 'allow' },
        { behavior: 'deny' },
      );
      expect(hookOutput.isPermissionDenied()).toBe(true);
    });

    it('should concatenate messages', () => {
      const hookOutput = permission(
        { message: 'msg1', behavior: 'allow' },
        { message: 'msg2', behavior: 'allow' },
      );
      expect(hookOutput.getDenyMessage()).toBe('msg1\nmsg2');
    });

    it('should use last updatedInput', () => {
      const hookOutput = permission(
        { updatedInput: { arg: '1' }, behavior: 'allow' },
        { updatedInput: { arg: '2' }, behavior: 'allow' },
      );
      expect(hookOutput.getUpdatedToolInput()).toEqual({ arg: '2' });
    });

    it('should concatenate updatedPermissions', () => {
      const hookOutput = permission(
        { updatedPermissions: [{ type: 'read' }], behavior: 'allow' },
        { updatedPermissions: [{ type: 'write' }], behavior: 'allow' },
      );
      expect(hookOutput.getUpdatedPermissions()).toEqual([
        { type: 'read' },
        { type: 'write' },
      ]);
    });

    it('should set interrupt true if any hook sets it', () => {
      const hookOutput = permission(
        { behavior: 'deny', interrupt: false },
        { behavior: 'deny', interrupt: true },
      );
      expect(hookOutput.shouldInterrupt()).toBe(true);
    });

    it('should produce output consumable by PermissionRequestHookOutput accessors', () => {
      const hookOutput = permission(
        { behavior: 'allow', message: 'first msg', updatedInput: { arg: '1' } },
        { behavior: 'deny', message: 'second msg', updatedInput: { arg: '2' } },
      );

      expect(hookOutput.isPermissionDenied()).toBe(true);
      expect(hookOutput.getUpdatedToolInput()).toEqual({ arg: '2' });
      expect(hookOutput.getDenyMessage()).toBe('first msg\nsecond msg');
    });
  });

  describe('mergeSimple (default case)', () => {
    it('should use later values for simple fields', () => {
      const result = aggregate(HookEventName.Notification, [
        { reason: 'first', continue: true },
        { reason: 'second', continue: false },
      ]);
      expect(result.finalOutput?.reason).toBe('second');
      expect(result.finalOutput?.continue).toBe(false);
    });

    it('should concatenate additionalContext from multiple hooks', () => {
      const result = aggregate(HookEventName.Notification, [
        {
          hookSpecificOutput: {
            additionalContext: 'ctx1',
            otherField: 'value1',
          },
        },
        { hookSpecificOutput: { additionalContext: 'ctx2' } },
      ]);
      // mergeSimple concatenates additionalContext with newlines
      expect(
        result.finalOutput?.hookSpecificOutput?.['additionalContext'],
      ).toBe('ctx1\nctx2');
      // otherField is overwritten (later value wins since it's not special-cased)
      expect(
        result.finalOutput?.hookSpecificOutput?.['otherField'],
      ).toBeUndefined();
    });

    it('falls through to mergeSimple/DefaultHookOutput for MessageDisplay (no control-effect merge logic)', () => {
      // MessageDisplay is fire-and-forget with no control effects, so it has no
      // case in aggregateResults's switch nor in createSpecificHookOutput. This
      // pins it to the same default path as Notification/PostCompact, not the
      // OR-logic (mergeWithOrLogic) path of control-affecting events.
      const result = aggregate(
        HookEventName.MessageDisplay,
        [
          { hookSpecificOutput: { additionalContext: 'a' } },
          { hookSpecificOutput: { additionalContext: 'b' } },
        ],
        10,
      );

      expect(
        result.finalOutput?.hookSpecificOutput?.['additionalContext'],
      ).toBe('a\nb');
      expect(result.finalOutput?.constructor.name).toBe('DefaultHookOutput');
    });
  });

  describe('createSpecificHookOutput', () => {
    it('should create PreToolUseHookOutput for PreToolUse', () => {
      const result = aggregate(HookEventName.PreToolUse, [{ continue: true }]);
      // The finalOutput should be an instance of PreToolUseHookOutput
      expect(result.finalOutput).toBeDefined();
      expect((result.finalOutput as { continue?: boolean }).continue).toBe(
        true,
      );
    });

    it('should create StopHookOutput for Stop', () => {
      const result = aggregate(HookEventName.Stop, [{ stopReason: 'test' }]);
      expect(result.finalOutput).toBeDefined();
      expect((result.finalOutput as { stopReason?: string }).stopReason).toBe(
        'test',
      );
    });

    it('should create PermissionRequestHookOutput for PermissionRequest', () => {
      const result = aggregate(HookEventName.PermissionRequest, [
        { hookSpecificOutput: { decision: { behavior: 'allow' } } },
      ]);
      expect(result.finalOutput).toBeDefined();
    });
  });

  describe('edge cases', () => {
    it('should handle empty outputs array', () => {
      const result = aggregate(HookEventName.PreToolUse, []);
      expect(result.finalOutput).toBeUndefined();
    });

    it('should handle single output', () => {
      const result = aggregate(HookEventName.PreToolUse, [
        { decision: 'allow', reason: 'single' },
      ]);
      expect(result.finalOutput?.decision).toBe('allow');
      expect(result.finalOutput?.reason).toBe('single');
    });

    it('should handle outputs without hookSpecificOutput', () => {
      const result = aggregate(HookEventName.PreToolUse, [
        { decision: 'allow' },
        { reason: 'test' },
      ]);
      expect(result.finalOutput?.decision).toBe('allow');
      expect(result.finalOutput?.reason).toBe('test');
    });

    it('should handle decision allow when no block', () => {
      const result = aggregate(HookEventName.PreToolUse, [
        { decision: 'allow' },
        { decision: 'allow' },
      ]);
      expect(result.finalOutput?.decision).toBe('allow');
    });
  });

  describe('SubagentStop - mergeWithOrLogic', () => {
    it('should use mergeWithOrLogic for SubagentStop event', () => {
      const result = aggregate(HookEventName.SubagentStop, [
        { reason: 'first reason', decision: 'allow' },
        { reason: 'second reason', decision: 'allow' },
      ]);
      expect(result.finalOutput?.reason).toBe('first reason\nsecond reason');
    });

    it('should block when any SubagentStop hook blocks', () => {
      const result = aggregate(HookEventName.SubagentStop, [
        { reason: 'output looks good', decision: 'allow' },
        { reason: 'output too short', decision: 'block' },
      ]);
      expect(result.finalOutput?.decision).toBe('block');
    });

    it('should concatenate additionalContext for SubagentStop', () => {
      const result = aggregate(HookEventName.SubagentStop, [
        { hookSpecificOutput: { additionalContext: 'context from hook 1' } },
        { hookSpecificOutput: { additionalContext: 'context from hook 2' } },
      ]);
      expect(
        result.finalOutput?.hookSpecificOutput?.['additionalContext'],
      ).toBe('context from hook 1\ncontext from hook 2');
    });

    it('should handle continue=false for SubagentStop', () => {
      const result = aggregate(HookEventName.SubagentStop, [
        { continue: true },
        { continue: false, stopReason: 'subagent should stop' },
      ]);
      expect(result.finalOutput?.continue).toBe(false);
      expect(result.finalOutput?.stopReason).toBe('subagent should stop');
    });
  });

  describe('createSpecificHookOutput - SubagentStop', () => {
    it('should create StopHookOutput for SubagentStop', () => {
      const result = aggregate(HookEventName.SubagentStop, [
        { decision: 'block', reason: 'Output too short' },
      ]);
      expect(result.finalOutput).toBeDefined();
      expect(result.finalOutput?.decision).toBe('block');
      expect(result.finalOutput?.reason).toBe('Output too short');
    });

    // These two verify the output is consumable by StopHookOutput accessors.
    it('should create StopHookOutput with isBlockingDecision for SubagentStop', () => {
      const hookOutput = accessorsFor(HookEventName.SubagentStop, [
        { decision: 'block', reason: 'Continue working on the task' },
      ]);
      expect(hookOutput.isBlockingDecision()).toBe(true);
      expect(hookOutput.getEffectiveReason()).toBe(
        'Continue working on the task',
      );
    });

    it('should create StopHookOutput with allow decision for SubagentStop', () => {
      const hookOutput = accessorsFor(HookEventName.SubagentStop, [
        { decision: 'allow', reason: 'Output looks complete' },
      ]);
      expect(hookOutput.isBlockingDecision()).toBe(false);
    });
  });

  describe('Todo events - mergeWithOrLogic', () => {
    it('should block TodoCreated when any hook blocks', () => {
      const result = aggregate(HookEventName.TodoCreated, [
        { reason: 'policy violation', decision: 'block' },
        { reason: 'looks fine', decision: 'allow' },
      ]);
      expect(result.finalOutput?.decision).toBe('block');
      expect(result.finalOutput?.reason).toBe('policy violation\nlooks fine');
    });

    it('should block TodoCompleted when a later hook allows', () => {
      const result = aggregate(HookEventName.TodoCompleted, [
        { reason: 'already completed elsewhere', decision: 'block' },
        { reason: 'completion approved', decision: 'allow' },
      ]);
      expect(result.finalOutput?.decision).toBe('block');
      expect(result.finalOutput?.reason).toBe(
        'already completed elsewhere\ncompletion approved',
      );
    });
  });

  describe('StopFailure - fire-and-forget special handling', () => {
    it('should always return success true for StopFailure', () => {
      const result = aggregateAll(HookEventName.StopFailure, {
        success: false,
        error: new Error('Hook failed'),
      });
      expect(result.success).toBe(true);
    });

    it('should ignore all outputs for StopFailure', () => {
      const result = aggregate(HookEventName.StopFailure, [
        { decision: 'block', reason: 'should be ignored' },
        { continue: false, stopReason: 'also ignored' },
      ]);
      expect(result.allOutputs).toEqual([]);
      expect(result.finalOutput).toBeUndefined();
    });

    it('should ignore all errors for StopFailure', () => {
      const result = aggregateAll(
        HookEventName.StopFailure,
        {
          command: 'hook1.sh',
          success: false,
          error: new Error('First error'),
          duration: 50,
        },
        {
          command: 'hook2.sh',
          success: false,
          error: new Error('Second error'),
          duration: 75,
        },
      );
      expect(result.success).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should calculate total duration for StopFailure', () => {
      const result = aggregateAll(
        HookEventName.StopFailure,
        { command: 'hook1.sh' },
        { command: 'hook2.sh', duration: 200 },
      );
      expect(result.totalDuration).toBe(300);
    });

    it('should return empty result for StopFailure with no hooks', () => {
      const result = aggregator.aggregateResults([], HookEventName.StopFailure);
      expect(result.success).toBe(true);
      expect(result.allOutputs).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(result.totalDuration).toBe(0);
      expect(result.finalOutput).toBeUndefined();
    });
  });

  describe('PostCompact - mergeSimple', () => {
    it('should use mergeSimple for PostCompact event', () => {
      const result = aggregate(HookEventName.PostCompact, [
        { reason: 'first', continue: true },
        { reason: 'second', continue: false },
      ]);
      // mergeSimple uses later values for simple fields
      expect(result.finalOutput?.reason).toBe('second');
      expect(result.finalOutput?.continue).toBe(false);
    });

    it('should concatenate additionalContext for PostCompact', () => {
      const result = aggregate(HookEventName.PostCompact, [
        { hookSpecificOutput: { additionalContext: 'context 1' } },
        { hookSpecificOutput: { additionalContext: 'context 2' } },
      ]);
      expect(
        result.finalOutput?.hookSpecificOutput?.['additionalContext'],
      ).toBe('context 1\ncontext 2');
    });

    it('should handle single output for PostCompact', () => {
      const result = aggregate(HookEventName.PostCompact, [
        {
          hookSpecificOutput: {
            hookEventName: 'PostCompact',
            additionalContext: 'single context',
          },
        },
      ]);
      expect(result.finalOutput).toBeDefined();
      expect(
        result.finalOutput?.hookSpecificOutput?.['additionalContext'],
      ).toBe('single context');
    });
  });

  describe('terminalSequence merging', () => {
    // One 10ms result per [command, output] pair.
    const aggregateTerminal = (
      event: HookEventName,
      ...hooks: Array<[string, HookOutput]>
    ) =>
      aggregateAll(
        event,
        ...hooks.map(([command, output]) => ({
          command,
          output,
          duration: 10,
        })),
      );

    it('preserves single terminalSequence in OR-logic events', () => {
      const result = aggregateTerminal(HookEventName.Notification, [
        'echo test',
        { terminalSequence: '\x07' },
      ]);
      expect(result.finalOutput?.terminalSequence).toBe('\x07');
    });

    it('concatenates terminalSequence from multiple outputs', () => {
      const result = aggregateTerminal(
        HookEventName.PreToolUse,
        ['hook1', { terminalSequence: '\x07' }],
        ['hook2', { terminalSequence: '\x1b]9;hello\x07' }],
      );
      expect(result.finalOutput?.terminalSequence).toBe('\x07\x1b]9;hello\x07');
    });

    it('omits terminalSequence when no outputs have it', () => {
      const result = aggregateTerminal(HookEventName.Stop, [
        'echo test',
        { continue: true },
      ]);
      expect(result.finalOutput?.terminalSequence).toBeUndefined();
    });

    it('preserves terminalSequence in simple merge events', () => {
      const result = aggregateTerminal(
        HookEventName.SessionStart,
        ['hook1', { terminalSequence: '\x1b]0;title\x07' }],
        ['hook2', { terminalSequence: '\x07' }],
      );
      expect(result.finalOutput?.terminalSequence).toBe('\x1b]0;title\x07\x07');
    });

    it('preserves terminalSequence in PermissionRequest merge', () => {
      const result = aggregateTerminal(HookEventName.PermissionRequest, [
        'hook1',
        {
          terminalSequence: '\x07',
          hookSpecificOutput: { decision: { behavior: 'allow' } },
        },
      ]);
      expect(result.finalOutput?.terminalSequence).toBe('\x07');
    });

    it('does not affect decision fields when terminalSequence is present', () => {
      const result = aggregateTerminal(HookEventName.PreToolUse, [
        'hook1',
        { decision: 'block', reason: 'blocked', terminalSequence: '\x07' },
      ]);
      expect(result.finalOutput?.decision).toBe('block');
      expect(result.finalOutput?.reason).toBe('blocked');
      expect(result.finalOutput?.terminalSequence).toBe('\x07');
    });
  });

  describe('mergeWithOrLogic - PreToolUse permissionDecision ranking', () => {
    const aggregatePreToolUse = (outputs: HookOutput[]) => {
      const results: HookExecutionResult[] = outputs.map((output) => ({
        hookConfig: { type: HookType.Command, command: 'echo test' },
        eventName: HookEventName.PreToolUse,
        success: true,
        output,
        duration: 100,
      }));
      return aggregator.aggregateResults(results, HookEventName.PreToolUse);
    };

    const preToolUseOutput = (
      permissionDecision: 'allow' | 'deny' | 'ask',
      permissionDecisionReason: string,
    ): HookOutput => ({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision,
        permissionDecisionReason,
      },
    });

    it('deny wins over allow regardless of hook order (deny first)', () => {
      const result = aggregatePreToolUse([
        preToolUseOutput('deny', 'deny-hook: DENY'),
        preToolUseOutput('allow', 'allow-hook: ALLOW'),
      ]);

      const finalOutput = result.finalOutput as PreToolUseHookOutput;
      expect(finalOutput.getPermissionDecision()).toBe('deny');
      expect(finalOutput.isDenied()).toBe(true);
    });

    it('deny wins over allow regardless of hook order (allow first)', () => {
      const result = aggregatePreToolUse([
        preToolUseOutput('allow', 'allow-hook: ALLOW'),
        preToolUseOutput('deny', 'deny-hook: DENY'),
      ]);

      const finalOutput = result.finalOutput as PreToolUseHookOutput;
      expect(finalOutput.getPermissionDecision()).toBe('deny');
      expect(finalOutput.isDenied()).toBe(true);
    });

    it('deny wins over ask', () => {
      const result = aggregatePreToolUse([
        preToolUseOutput('ask', 'ask-hook: ASK'),
        preToolUseOutput('deny', 'deny-hook: DENY'),
      ]);

      const finalOutput = result.finalOutput as PreToolUseHookOutput;
      expect(finalOutput.getPermissionDecision()).toBe('deny');
    });

    it('ask wins over allow', () => {
      const result = aggregatePreToolUse([
        preToolUseOutput('ask', 'ask-hook: ASK'),
        preToolUseOutput('allow', 'allow-hook: ALLOW'),
      ]);

      const finalOutput = result.finalOutput as PreToolUseHookOutput;
      expect(finalOutput.getPermissionDecision()).toBe('ask');
      expect(finalOutput.isAsk()).toBe(true);
    });

    it('reason comes from the winning decision; same-rank reasons concatenate', () => {
      const result = aggregatePreToolUse([
        preToolUseOutput('allow', 'allow-hook: ALLOW'),
        preToolUseOutput('deny', 'deny-hook-1: DENY'),
        preToolUseOutput('deny', 'deny-hook-2: DENY'),
      ]);

      const finalOutput = result.finalOutput as PreToolUseHookOutput;
      expect(finalOutput.getPermissionDecision()).toBe('deny');
      expect(finalOutput.getPermissionDecisionReason()).toBe(
        'deny-hook-1: DENY\ndeny-hook-2: DENY',
      );
    });

    it('single hook output is unchanged', () => {
      const result = aggregatePreToolUse([
        preToolUseOutput('allow', 'allow-hook: ALLOW'),
      ]);

      const finalOutput = result.finalOutput as PreToolUseHookOutput;
      expect(finalOutput.getPermissionDecision()).toBe('allow');
      expect(finalOutput.getPermissionDecisionReason()).toBe(
        'allow-hook: ALLOW',
      );
    });

    it('keeps last-wins for unrelated hookSpecificOutput fields', () => {
      const outputs: HookOutput[] = [
        {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'deny-hook: DENY',
            updatedInput: { url: 'https://first.example' },
          },
        },
        {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: 'allow-hook: ALLOW',
            updatedInput: { url: 'https://second.example' },
          },
        },
      ];

      const result = aggregatePreToolUse(outputs);

      const finalOutput = result.finalOutput as PreToolUseHookOutput;
      expect(finalOutput.getPermissionDecision()).toBe('deny');
      expect(finalOutput.hookSpecificOutput?.['updatedInput']).toEqual({
        url: 'https://second.example',
      });
    });

    it('hooks without permissionDecision do not lower the merged rank', () => {
      const outputs: HookOutput[] = [
        preToolUseOutput('deny', 'deny-hook: DENY'),
        { hookSpecificOutput: { additionalContext: 'ctx only' } },
      ];

      const result = aggregatePreToolUse(outputs);

      const finalOutput = result.finalOutput as PreToolUseHookOutput;
      expect(finalOutput.getPermissionDecision()).toBe('deny');
      expect(finalOutput.hookSpecificOutput?.['additionalContext']).toBe(
        'ctx only',
      );
    });
  });
});
