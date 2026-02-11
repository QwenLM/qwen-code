/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  HookEventName,
  HookType,
  createHookOutput,
  DefaultHookOutput,
  PreToolUseHookOutput,
  PostToolUseHookOutput,
  UserPromptSubmitHookOutput,
  StopHookOutput,
  NotificationType,
  SessionStartSource,
  SessionEndReason,
  PreCompactTrigger,
} from './types.js';

describe('Hook Types', () => {
  describe('HookEventName', () => {
    it('should contain event names', () => {
      const expectedEvents = [
        'PreToolUse',
        'PostToolUse',
        'PermissionRequest',
        'UserPromptSubmit',
        'Stop',
        'SubagentStop',
        'Notification',
        'PreCompact',
        'SessionStart',
        'SessionEnd',
      ];

      for (const event of expectedEvents) {
        expect(Object.values(HookEventName)).toContain(event);
      }
    });
  });

  describe('HookType', () => {
    it('should contain command type', () => {
      expect(HookType.Command).toBe('command');
    });
  });

  describe('NotificationType', () => {
    it('should contain all notification types', () => {
      expect(NotificationType.PermissionPrompt).toBe('permission_prompt');
      expect(NotificationType.IdlePrompt).toBe('idle_prompt');
      expect(NotificationType.AuthSuccess).toBe('auth_success');
      expect(NotificationType.ElicitationDialog).toBe('elicitation_dialog');
    });
  });

  describe('SessionStartSource', () => {
    it('should contain all session start sources', () => {
      expect(SessionStartSource.Startup).toBe('startup');
      expect(SessionStartSource.Resume).toBe('resume');
      expect(SessionStartSource.Clear).toBe('clear');
      expect(SessionStartSource.Compact).toBe('compact');
    });
  });

  describe('SessionEndReason', () => {
    it('should contain all session end reasons', () => {
      expect(SessionEndReason.Clear).toBe('clear');
      expect(SessionEndReason.Logout).toBe('logout');
      expect(SessionEndReason.PromptInputExit).toBe('prompt_input_exit');
      expect(SessionEndReason.Other).toBe('other');
    });
  });

  describe('PreCompactTrigger', () => {
    it('should contain all pre-compact triggers', () => {
      expect(PreCompactTrigger.Manual).toBe('manual');
      expect(PreCompactTrigger.Auto).toBe('auto');
    });
  });

  describe('DefaultHookOutput', () => {
    it('should initialize with default values', () => {
      const output = new DefaultHookOutput();
      expect(output.continue).toBeUndefined();
      expect(output.decision).toBeUndefined();
      expect(output.isBlockingDecision()).toBe(false);
      expect(output.shouldStopExecution()).toBe(false);
    });

    it('should initialize with provided data', () => {
      const output = new DefaultHookOutput({
        continue: false,
        decision: 'block',
        reason: 'Test reason',
      });
      expect(output.continue).toBe(false);
      expect(output.decision).toBe('block');
      expect(output.isBlockingDecision()).toBe(true);
      expect(output.shouldStopExecution()).toBe(true);
      expect(output.getEffectiveReason()).toBe('Test reason');
    });

    it('should return default reason when not provided', () => {
      const output = new DefaultHookOutput();
      expect(output.getEffectiveReason()).toBe('No reason provided');
    });

    it('should use reason over stopReason for getEffectiveReason', () => {
      const output = new DefaultHookOutput({
        stopReason: 'Stop reason',
        reason: 'Regular reason',
      });
      expect(output.getEffectiveReason()).toBe('Regular reason');
    });

    it('should identify blocking decisions', () => {
      expect(
        new DefaultHookOutput({ decision: 'block' }).isBlockingDecision(),
      ).toBe(true);
      expect(
        new DefaultHookOutput({ decision: 'deny' }).isBlockingDecision(),
      ).toBe(true);
      expect(
        new DefaultHookOutput({ decision: 'allow' }).isBlockingDecision(),
      ).toBe(false);
      expect(
        new DefaultHookOutput({ decision: 'approve' }).isBlockingDecision(),
      ).toBe(false);
    });

    it('should get blocking error info', () => {
      const blockingOutput = new DefaultHookOutput({
        decision: 'block',
        reason: 'Blocked by policy',
      });
      expect(blockingOutput.getBlockingError()).toEqual({
        blocked: true,
        reason: 'Blocked by policy',
      });

      const nonBlockingOutput = new DefaultHookOutput();
      expect(nonBlockingOutput.getBlockingError()).toEqual({
        blocked: false,
        reason: '',
      });
    });

    it('should get additional context', () => {
      const output = new DefaultHookOutput({
        hookSpecificOutput: {
          additionalContext: 'Test context',
        },
      });
      expect(output.getAdditionalContext()).toBe('Test context');
    });

    it('should return undefined for non-string additionalContext', () => {
      const output = new DefaultHookOutput({
        hookSpecificOutput: {
          additionalContext: 123 as unknown as string,
        },
      });
      expect(output.getAdditionalContext()).toBeUndefined();
    });
  });

  describe('PreToolUseHookOutput', () => {
    it('should check permissionDecision field for blocking', () => {
      const output = new PreToolUseHookOutput({
        hookSpecificOutput: {
          permissionDecision: 'deny',
        },
      });
      expect(output.isBlockingDecision()).toBe(true);
      expect(output.getPermissionDecision()).toBe('deny');
    });

    it('should check decision.behavior field for blocking (PermissionRequest style)', () => {
      const output = new PreToolUseHookOutput({
        hookSpecificOutput: {
          decision: {
            behavior: 'deny',
            message: 'Access denied',
          },
        },
      });
      expect(output.isBlockingDecision()).toBe(true);
      expect(output.getEffectiveReason()).toBe('Access denied');
    });

    it('should get permissionDecisionReason field', () => {
      const output = new PreToolUseHookOutput({
        hookSpecificOutput: {
          permissionDecisionReason: 'Permission denied by policy',
        },
      });
      expect(output.getEffectiveReason()).toBe('Permission denied by policy');
    });

    it('should get updated tool input (PreToolUse style)', () => {
      const updatedInput = { path: '/updated/path' };
      const output = new PreToolUseHookOutput({
        hookSpecificOutput: {
          updatedInput,
        },
      });
      expect(output.getUpdatedToolInput()).toEqual(updatedInput);
    });

    it('should get updated tool input (PermissionRequest style)', () => {
      const updatedInput = { path: '/updated/path' };
      const output = new PreToolUseHookOutput({
        hookSpecificOutput: {
          decision: {
            behavior: 'allow',
            updatedInput,
          },
        },
      });
      expect(output.getUpdatedToolInput()).toEqual(updatedInput);
    });

    it('should fall back to standard fields when no compatibility fields', () => {
      const output = new PreToolUseHookOutput({
        decision: 'block',
        reason: 'Standard reason',
      });
      expect(output.isBlockingDecision()).toBe(true);
      expect(output.getEffectiveReason()).toBe('Standard reason');
    });
  });

  describe('PostToolUseHookOutput', () => {
    it('should get additional context', () => {
      const output = new PostToolUseHookOutput({
        hookSpecificOutput: {
          additionalContext: 'Additional context from hook',
        },
      });
      expect(output.getAdditionalContext()).toBe(
        'Additional context from hook',
      );
    });

    it('should return undefined when no additional context', () => {
      const output = new PostToolUseHookOutput({});
      expect(output.getAdditionalContext()).toBeUndefined();
    });
  });

  describe('UserPromptSubmitHookOutput', () => {
    it('should get additional context', () => {
      const output = new UserPromptSubmitHookOutput({
        hookSpecificOutput: {
          additionalContext: 'User prompt context',
        },
      });
      expect(output.getAdditionalContext()).toBe('User prompt context');
    });

    it('should return undefined when no additional context', () => {
      const output = new UserPromptSubmitHookOutput({});
      expect(output.getAdditionalContext()).toBeUndefined();
    });
  });

  describe('StopHookOutput', () => {
    it('should check if stop should be blocked (continue execution)', () => {
      const output = new StopHookOutput({
        decision: 'block',
        reason: 'Continue working',
      });
      expect(output.shouldContinueExecution()).toBe(true);
      expect(output.getContinueReason()).toBe('Continue working');
    });

    it('should check continue field for stopping', () => {
      const output = new StopHookOutput({
        continue: false,
        reason: 'Please continue',
      });
      expect(output.shouldContinueExecution()).toBe(true);
      expect(output.getContinueReason()).toBe('Please continue');
    });
  });

  describe('createHookOutput', () => {
    it('should create PreToolUseHookOutput for PreToolUse event', () => {
      const output = createHookOutput('PreToolUse', {});
      expect(output).toBeInstanceOf(PreToolUseHookOutput);
    });

    it('should create PreToolUseHookOutput for PermissionRequest event', () => {
      const output = createHookOutput('PermissionRequest', {});
      expect(output).toBeInstanceOf(PreToolUseHookOutput);
    });

    it('should create PostToolUseHookOutput for PostToolUse event', () => {
      const output = createHookOutput('PostToolUse', {});
      expect(output).toBeInstanceOf(PostToolUseHookOutput);
    });

    it('should create UserPromptSubmitHookOutput for UserPromptSubmit event', () => {
      const output = createHookOutput('UserPromptSubmit', {});
      expect(output).toBeInstanceOf(UserPromptSubmitHookOutput);
    });

    it('should create StopHookOutput for Stop event', () => {
      const output = createHookOutput('Stop', {});
      expect(output).toBeInstanceOf(StopHookOutput);
    });

    it('should create StopHookOutput for SubagentStop event', () => {
      const output = createHookOutput('SubagentStop', {});
      expect(output).toBeInstanceOf(StopHookOutput);
    });

    it('should create DefaultHookOutput for Notification event', () => {
      const output = createHookOutput('Notification', {});
      expect(output).toBeInstanceOf(DefaultHookOutput);
    });

    it('should create DefaultHookOutput for SessionStart event', () => {
      const output = createHookOutput('SessionStart', {});
      expect(output).toBeInstanceOf(DefaultHookOutput);
    });

    it('should create DefaultHookOutput for SessionEnd event', () => {
      const output = createHookOutput('SessionEnd', {});
      expect(output).toBeInstanceOf(DefaultHookOutput);
    });

    it('should create DefaultHookOutput for PreCompact event', () => {
      const output = createHookOutput('PreCompact', {});
      expect(output).toBeInstanceOf(DefaultHookOutput);
    });

    it('should create DefaultHookOutput for unknown events', () => {
      const output = createHookOutput('UnknownEvent', {});
      expect(output).toBeInstanceOf(DefaultHookOutput);
    });
  });
});
