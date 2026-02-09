/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  HookEventName,
  HookType,
  createHookOutput,
  DefaultHookOutput,
  BeforeToolHookOutput,
  BeforeModelHookOutput,
  AfterModelHookOutput,
  BeforeToolSelectionHookOutput,
  NotificationType,
  SessionStartSource,
  SessionEndReason,
  PreCompressTrigger,
} from './types.js';

describe('Hook Types', () => {
  describe('HookEventName', () => {
    it('should contain all required event names', () => {
      const expectedEvents = [
        'BeforeTool',
        'AfterTool',
        'BeforeAgent',
        'Notification',
        'AfterAgent',
        'SessionStart',
        'SessionEnd',
        'PreCompress',
        'BeforeModel',
        'AfterModel',
        'BeforeToolSelection',
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
    it('should contain ToolPermission type', () => {
      expect(NotificationType.ToolPermission).toBe('ToolPermission');
    });
  });

  describe('SessionStartSource', () => {
    it('should contain all session start sources', () => {
      expect(SessionStartSource.Startup).toBe('startup');
      expect(SessionStartSource.Resume).toBe('resume');
      expect(SessionStartSource.Clear).toBe('clear');
      expect(SessionStartSource.Compress).toBe('compress');
    });
  });

  describe('SessionEndReason', () => {
    it('should contain all session end reasons', () => {
      expect(SessionEndReason.Exit).toBe('exit');
      expect(SessionEndReason.Clear).toBe('clear');
      expect(SessionEndReason.Logout).toBe('logout');
      expect(SessionEndReason.PromptInputExit).toBe('prompt_input_exit');
      expect(SessionEndReason.Other).toBe('other');
    });
  });

  describe('PreCompressTrigger', () => {
    it('should contain all pre-compress triggers', () => {
      expect(PreCompressTrigger.Manual).toBe('manual');
      expect(PreCompressTrigger.Auto).toBe('auto');
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

  describe('BeforeToolHookOutput', () => {
    it('should check compatibility permissionDecision field', () => {
      const output = new BeforeToolHookOutput({
        hookSpecificOutput: {
          permissionDecision: 'block',
        },
      });
      expect(output.isBlockingDecision()).toBe(true);
    });

    it('should get compatibility permissionDecisionReason field', () => {
      const output = new BeforeToolHookOutput({
        hookSpecificOutput: {
          permissionDecisionReason: 'Compatibility reason',
        },
      });
      expect(output.getEffectiveReason()).toBe('Compatibility reason');
    });

    it('should fall back to standard fields when no compatibility fields', () => {
      const output = new BeforeToolHookOutput({
        decision: 'deny',
        reason: 'Standard reason',
      });
      expect(output.isBlockingDecision()).toBe(true);
      expect(output.getEffectiveReason()).toBe('Standard reason');
    });
  });

  describe('AfterModelHookOutput', () => {
    it('should create synthetic stop response when execution stopped', () => {
      const output = new AfterModelHookOutput({
        continue: false,
        reason: 'User requested stop',
      });
      const modifiedResponse = output.getModifiedResponse();
      expect(modifiedResponse).toBeDefined();
    });

    it('should return undefined when not stopped and no modified response', () => {
      const output = new AfterModelHookOutput({});
      expect(output.getModifiedResponse()).toBeUndefined();
    });
  });

  describe('createHookOutput', () => {
    it('should create BeforeModelHookOutput for BeforeModel event', () => {
      const output = createHookOutput('BeforeModel', {});
      expect(output).toBeInstanceOf(BeforeModelHookOutput);
    });

    it('should create AfterModelHookOutput for AfterModel event', () => {
      const output = createHookOutput('AfterModel', {});
      expect(output).toBeInstanceOf(AfterModelHookOutput);
    });

    it('should create BeforeToolSelectionHookOutput for BeforeToolSelection event', () => {
      const output = createHookOutput('BeforeToolSelection', {});
      expect(output).toBeInstanceOf(BeforeToolSelectionHookOutput);
    });

    it('should create DefaultHookOutput for BeforeTool event', () => {
      const output = createHookOutput('BeforeTool', {});
      expect(output).toBeInstanceOf(DefaultHookOutput);
    });

    it('should create DefaultHookOutput for AfterAgent event', () => {
      const output = createHookOutput('AfterAgent', {});
      expect(output).toBeInstanceOf(DefaultHookOutput);
    });

    it('should create DefaultHookOutput for unknown events', () => {
      const output = createHookOutput('UnknownEvent', {});
      expect(output).toBeInstanceOf(DefaultHookOutput);
    });
  });
});
