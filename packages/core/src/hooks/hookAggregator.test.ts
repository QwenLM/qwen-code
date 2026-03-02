/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { HookAggregator } from './hookAggregator.js';
import { HookEventName, HookType, createHookOutput } from './types.js';
import type {
  HookExecutionResult,
  HookOutput,
  PermissionRequestHookOutput,
} from './types.js';

describe('HookAggregator', () => {
  const aggregator = new HookAggregator();

  describe('aggregateResults', () => {
    it('should return undefined finalOutput when no results', () => {
      const result = aggregator.aggregateResults([], HookEventName.PreToolUse);
      expect(result.success).toBe(true);
      expect(result.finalOutput).toBeUndefined();
      expect(result.allOutputs).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it('should aggregate successful results', () => {
      const results: HookExecutionResult[] = [
        {
          hookConfig: { type: HookType.Command, command: 'echo test' },
          eventName: HookEventName.PreToolUse,
          success: true,
          output: { continue: true },
          duration: 100,
        },
      ];

      const result = aggregator.aggregateResults(
        results,
        HookEventName.PreToolUse,
      );
      expect(result.success).toBe(true);
      expect(result.finalOutput).toBeDefined();
    });

    it('should set success false when there are errors', () => {
      const results: HookExecutionResult[] = [
        {
          hookConfig: { type: HookType.Command, command: 'echo test' },
          eventName: HookEventName.PreToolUse,
          success: false,
          error: new Error('Hook failed'),
          duration: 100,
        },
      ];

      const result = aggregator.aggregateResults(
        results,
        HookEventName.PreToolUse,
      );
      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
    });

    it('should calculate total duration', () => {
      const results: HookExecutionResult[] = [
        {
          hookConfig: { type: HookType.Command, command: 'echo 1' },
          eventName: HookEventName.PreToolUse,
          success: true,
          duration: 100,
        },
        {
          hookConfig: { type: HookType.Command, command: 'echo 2' },
          eventName: HookEventName.PreToolUse,
          success: true,
          duration: 200,
        },
      ];

      const result = aggregator.aggregateResults(
        results,
        HookEventName.PreToolUse,
      );
      expect(result.totalDuration).toBe(300);
    });
  });

  describe('mergeWithOrLogic - PreToolUse', () => {
    it('should concatenate reasons', () => {
      const outputs: HookOutput[] = [
        { reason: 'first reason', decision: 'allow' },
        { reason: 'second reason', decision: 'allow' },
      ];

      const results: HookExecutionResult[] = outputs.map((output) => ({
        hookConfig: { type: HookType.Command, command: 'echo test' },
        eventName: HookEventName.PreToolUse,
        success: true,
        output,
        duration: 100,
      }));

      const result = aggregator.aggregateResults(
        results,
        HookEventName.PreToolUse,
      );
      expect(result.finalOutput?.reason).toBe('first reason\nsecond reason');
    });

    it('should block when any hook blocks', () => {
      const outputs: HookOutput[] = [
        { reason: 'allowed', decision: 'allow' },
        { reason: 'blocked', decision: 'block' },
      ];

      const results: HookExecutionResult[] = outputs.map((output) => ({
        hookConfig: { type: HookType.Command, command: 'echo test' },
        eventName: HookEventName.PreToolUse,
        success: true,
        output,
        duration: 100,
      }));

      const result = aggregator.aggregateResults(
        results,
        HookEventName.PreToolUse,
      );
      expect(result.finalOutput?.decision).toBe('block');
    });

    it('should use last stopReason', () => {
      const outputs: HookOutput[] = [
        { continue: false, stopReason: 'first stop' },
        { continue: false, stopReason: 'second stop' },
      ];

      const results: HookExecutionResult[] = outputs.map((output) => ({
        hookConfig: { type: HookType.Command, command: 'echo test' },
        eventName: HookEventName.Stop,
        success: true,
        output,
        duration: 100,
      }));

      const result = aggregator.aggregateResults(results, HookEventName.Stop);
      expect(result.finalOutput?.stopReason).toBe('second stop');
    });

    it('should concatenate additionalContext', () => {
      const outputs: HookOutput[] = [
        { hookSpecificOutput: { additionalContext: 'context 1' } },
        { hookSpecificOutput: { additionalContext: 'context 2' } },
      ];

      const results: HookExecutionResult[] = outputs.map((output) => ({
        hookConfig: { type: HookType.Command, command: 'echo test' },
        eventName: HookEventName.PreToolUse,
        success: true,
        output,
        duration: 100,
      }));

      const result = aggregator.aggregateResults(
        results,
        HookEventName.PreToolUse,
      );
      expect(
        result.finalOutput?.hookSpecificOutput?.['additionalContext'],
      ).toBe('context 1\ncontext 2');
    });

    it('should preserve other hookSpecificOutput fields', () => {
      const outputs: HookOutput[] = [
        {
          hookSpecificOutput: {
            additionalContext: 'ctx',
            tailToolCallRequest: { name: 'A' },
          },
        },
        { hookSpecificOutput: { additionalContext: 'ctx2' } },
      ];

      const results: HookExecutionResult[] = outputs.map((output) => ({
        hookConfig: { type: HookType.Command, command: 'echo test' },
        eventName: HookEventName.PostToolUse,
        success: true,
        output,
        duration: 100,
      }));

      const result = aggregator.aggregateResults(
        results,
        HookEventName.PostToolUse,
      );
      expect(
        result.finalOutput?.hookSpecificOutput?.['tailToolCallRequest'],
      ).toEqual({ name: 'A' });
      expect(
        result.finalOutput?.hookSpecificOutput?.['additionalContext'],
      ).toBe('ctx\nctx2');
    });
  });

  describe('mergePermissionRequestOutputs', () => {
    it('should prioritize deny over allow', () => {
      const outputs: HookOutput[] = [
        { hookSpecificOutput: { decision: { behavior: 'allow' } } },
        { hookSpecificOutput: { decision: { behavior: 'deny' } } },
      ];

      const results: HookExecutionResult[] = outputs.map((output) => ({
        hookConfig: { type: HookType.Command, command: 'echo test' },
        eventName: HookEventName.PermissionRequest,
        success: true,
        output,
        duration: 100,
      }));

      const result = aggregator.aggregateResults(
        results,
        HookEventName.PermissionRequest,
      );

      // Use accessor to verify - this ensures output is consumable by PermissionRequestHookOutput
      const hookOutput = createHookOutput(
        HookEventName.PermissionRequest,
        result.finalOutput ?? {},
      ) as PermissionRequestHookOutput;
      expect(hookOutput.isPermissionDenied()).toBe(true);
    });

    it('should concatenate messages', () => {
      const outputs: HookOutput[] = [
        {
          hookSpecificOutput: {
            decision: { message: 'msg1', behavior: 'allow' },
          },
        },
        {
          hookSpecificOutput: {
            decision: { message: 'msg2', behavior: 'allow' },
          },
        },
      ];

      const results: HookExecutionResult[] = outputs.map((output) => ({
        hookConfig: { type: HookType.Command, command: 'echo test' },
        eventName: HookEventName.PermissionRequest,
        success: true,
        output,
        duration: 100,
      }));

      const result = aggregator.aggregateResults(
        results,
        HookEventName.PermissionRequest,
      );

      const hookOutput = createHookOutput(
        HookEventName.PermissionRequest,
        result.finalOutput ?? {},
      ) as PermissionRequestHookOutput;
      expect(hookOutput.getDenyMessage()).toBe('msg1\nmsg2');
    });

    it('should use last updatedInput', () => {
      const outputs: HookOutput[] = [
        {
          hookSpecificOutput: {
            decision: { updatedInput: { arg: '1' }, behavior: 'allow' },
          },
        },
        {
          hookSpecificOutput: {
            decision: { updatedInput: { arg: '2' }, behavior: 'allow' },
          },
        },
      ];

      const results: HookExecutionResult[] = outputs.map((output) => ({
        hookConfig: { type: HookType.Command, command: 'echo test' },
        eventName: HookEventName.PermissionRequest,
        success: true,
        output,
        duration: 100,
      }));

      const result = aggregator.aggregateResults(
        results,
        HookEventName.PermissionRequest,
      );

      const hookOutput = createHookOutput(
        HookEventName.PermissionRequest,
        result.finalOutput ?? {},
      ) as PermissionRequestHookOutput;
      expect(hookOutput.getUpdatedToolInput()).toEqual({ arg: '2' });
    });

    it('should concatenate updatedPermissions', () => {
      const outputs: HookOutput[] = [
        {
          hookSpecificOutput: {
            decision: {
              updatedPermissions: [{ type: 'read' }],
              behavior: 'allow',
            },
          },
        },
        {
          hookSpecificOutput: {
            decision: {
              updatedPermissions: [{ type: 'write' }],
              behavior: 'allow',
            },
          },
        },
      ];

      const results: HookExecutionResult[] = outputs.map((output) => ({
        hookConfig: { type: HookType.Command, command: 'echo test' },
        eventName: HookEventName.PermissionRequest,
        success: true,
        output,
        duration: 100,
      }));

      const result = aggregator.aggregateResults(
        results,
        HookEventName.PermissionRequest,
      );

      const hookOutput = createHookOutput(
        HookEventName.PermissionRequest,
        result.finalOutput ?? {},
      ) as PermissionRequestHookOutput;
      expect(hookOutput.getUpdatedPermissions()).toEqual([
        { type: 'read' },
        { type: 'write' },
      ]);
    });

    it('should set interrupt true if any hook sets it', () => {
      const outputs: HookOutput[] = [
        {
          hookSpecificOutput: {
            decision: { behavior: 'deny', interrupt: false },
          },
        },
        {
          hookSpecificOutput: {
            decision: { behavior: 'deny', interrupt: true },
          },
        },
      ];

      const results: HookExecutionResult[] = outputs.map((output) => ({
        hookConfig: { type: HookType.Command, command: 'echo test' },
        eventName: HookEventName.PermissionRequest,
        success: true,
        output,
        duration: 100,
      }));

      const result = aggregator.aggregateResults(
        results,
        HookEventName.PermissionRequest,
      );

      const hookOutput = createHookOutput(
        HookEventName.PermissionRequest,
        result.finalOutput ?? {},
      ) as PermissionRequestHookOutput;
      expect(hookOutput.shouldInterrupt()).toBe(true);
    });

    it('should produce output consumable by PermissionRequestHookOutput accessors', () => {
      const outputs: HookOutput[] = [
        {
          hookSpecificOutput: {
            decision: {
              behavior: 'allow',
              message: 'first msg',
              updatedInput: { arg: '1' },
            },
          },
        },
        {
          hookSpecificOutput: {
            decision: {
              behavior: 'deny',
              message: 'second msg',
              updatedInput: { arg: '2' },
            },
          },
        },
      ];

      const results: HookExecutionResult[] = outputs.map((output) => ({
        hookConfig: { type: HookType.Command, command: 'echo test' },
        eventName: HookEventName.PermissionRequest,
        success: true,
        output,
        duration: 100,
      }));

      const result = aggregator.aggregateResults(
        results,
        HookEventName.PermissionRequest,
      );

      // Verify the output can be consumed by PermissionRequestHookOutput accessors
      const hookOutput = createHookOutput(
        HookEventName.PermissionRequest,
        result.finalOutput ?? {},
      ) as PermissionRequestHookOutput;

      expect(hookOutput.isPermissionDenied()).toBe(true);
      expect(hookOutput.getUpdatedToolInput()).toEqual({ arg: '2' });
      expect(hookOutput.getDenyMessage()).toBe('first msg\nsecond msg');
    });
  });

  describe('mergeSimple (default case)', () => {
    it('should use later values for simple fields', () => {
      const outputs: HookOutput[] = [
        { reason: 'first', continue: true },
        { reason: 'second', continue: false },
      ];

      const results: HookExecutionResult[] = outputs.map((output) => ({
        hookConfig: { type: HookType.Command, command: 'echo test' },
        eventName: HookEventName.Notification,
        success: true,
        output,
        duration: 100,
      }));

      const result = aggregator.aggregateResults(
        results,
        HookEventName.Notification,
      );
      expect(result.finalOutput?.reason).toBe('second');
      expect(result.finalOutput?.continue).toBe(false);
    });

    it('should concatenate additionalContext from multiple hooks', () => {
      const outputs: HookOutput[] = [
        {
          hookSpecificOutput: {
            additionalContext: 'ctx1',
            otherField: 'value1',
          },
        },
        { hookSpecificOutput: { additionalContext: 'ctx2' } },
      ];

      const results: HookExecutionResult[] = outputs.map((output) => ({
        hookConfig: { type: HookType.Command, command: 'echo test' },
        eventName: HookEventName.Notification,
        success: true,
        output,
        duration: 100,
      }));

      const result = aggregator.aggregateResults(
        results,
        HookEventName.Notification,
      );
      // mergeSimple concatenates additionalContext with newlines
      expect(
        result.finalOutput?.hookSpecificOutput?.['additionalContext'],
      ).toBe('ctx1\nctx2');
      // otherField is overwritten (later value wins since it's not special-cased)
      expect(
        result.finalOutput?.hookSpecificOutput?.['otherField'],
      ).toBeUndefined();
    });
  });

  describe('createSpecificHookOutput', () => {
    it('should create PreToolUseHookOutput for PreToolUse', () => {
      const output: HookOutput = { continue: true };
      const results: HookExecutionResult[] = [
        {
          hookConfig: { type: HookType.Command, command: 'echo test' },
          eventName: HookEventName.PreToolUse,
          success: true,
          output,
          duration: 100,
        },
      ];

      const result = aggregator.aggregateResults(
        results,
        HookEventName.PreToolUse,
      );
      // The finalOutput should be an instance of PreToolUseHookOutput
      expect(result.finalOutput).toBeDefined();
      expect((result.finalOutput as { continue?: boolean }).continue).toBe(
        true,
      );
    });

    it('should create StopHookOutput for Stop', () => {
      const output: HookOutput = { stopReason: 'test' };
      const results: HookExecutionResult[] = [
        {
          hookConfig: { type: HookType.Command, command: 'echo test' },
          eventName: HookEventName.Stop,
          success: true,
          output,
          duration: 100,
        },
      ];

      const result = aggregator.aggregateResults(results, HookEventName.Stop);
      expect(result.finalOutput).toBeDefined();
      expect((result.finalOutput as { stopReason?: string }).stopReason).toBe(
        'test',
      );
    });

    it('should create PermissionRequestHookOutput for PermissionRequest', () => {
      const output: HookOutput = {
        hookSpecificOutput: { decision: { behavior: 'allow' } },
      };
      const results: HookExecutionResult[] = [
        {
          hookConfig: { type: HookType.Command, command: 'echo test' },
          eventName: HookEventName.PermissionRequest,
          success: true,
          output,
          duration: 100,
        },
      ];

      const result = aggregator.aggregateResults(
        results,
        HookEventName.PermissionRequest,
      );
      expect(result.finalOutput).toBeDefined();
    });
  });

  describe('edge cases', () => {
    it('should handle empty outputs array', () => {
      const results: HookExecutionResult[] = [];
      const result = aggregator.aggregateResults(
        results,
        HookEventName.PreToolUse,
      );
      expect(result.finalOutput).toBeUndefined();
    });

    it('should handle single output', () => {
      const output: HookOutput = { decision: 'allow', reason: 'single' };
      const results: HookExecutionResult[] = [
        {
          hookConfig: { type: HookType.Command, command: 'echo test' },
          eventName: HookEventName.PreToolUse,
          success: true,
          output,
          duration: 100,
        },
      ];

      const result = aggregator.aggregateResults(
        results,
        HookEventName.PreToolUse,
      );
      expect(result.finalOutput?.decision).toBe('allow');
      expect(result.finalOutput?.reason).toBe('single');
    });

    it('should handle outputs without hookSpecificOutput', () => {
      const outputs: HookOutput[] = [{ decision: 'allow' }, { reason: 'test' }];

      const results: HookExecutionResult[] = outputs.map((output) => ({
        hookConfig: { type: HookType.Command, command: 'echo test' },
        eventName: HookEventName.PreToolUse,
        success: true,
        output,
        duration: 100,
      }));

      const result = aggregator.aggregateResults(
        results,
        HookEventName.PreToolUse,
      );
      expect(result.finalOutput?.decision).toBe('allow');
      expect(result.finalOutput?.reason).toBe('test');
    });

    it('should handle decision allow when no block', () => {
      const outputs: HookOutput[] = [
        { decision: 'allow' },
        { decision: 'allow' },
      ];

      const results: HookExecutionResult[] = outputs.map((output) => ({
        hookConfig: { type: HookType.Command, command: 'echo test' },
        eventName: HookEventName.PreToolUse,
        success: true,
        output,
        duration: 100,
      }));

      const result = aggregator.aggregateResults(
        results,
        HookEventName.PreToolUse,
      );
      expect(result.finalOutput?.decision).toBe('allow');
    });
  });
});
