/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import {
  createHookOutput,
  DefaultHookOutput,
  HookEventName,
  HookType,
  PreToolUseHookOutput,
  type HookDecision,
} from './types.js';
import { validateHookOutput } from './hookOutputSchema.js';

describe('Hook Types', () => {
  describe('HookEventName', () => {
    it('should contain all required event names', () => {
      const expectedEvents = [
        'PreToolUse',
        'PostToolUse',
        'SubagentStart',
        'Notification',
        'SubagentStop',
        'SessionStart',
        'Setup',
        'SessionEnd',
        'PreCompact',
        'PostCompact',
        'QueryEnd',
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
});

describe('Hook Output Classes', () => {
  describe('createHookOutput', () => {
    it('should return DefaultHookOutput for unknown event names', () => {
      const output = createHookOutput('UnknownEvent', {});
      expect(output).toBeInstanceOf(DefaultHookOutput);
    });

    it('should return PreToolUseHookOutput for PreToolUse event', () => {
      const output = createHookOutput(HookEventName.PreToolUse, {});
      expect(output).toBeInstanceOf(PreToolUseHookOutput);
    });
  });

  describe('DefaultHookOutput', () => {
    it('should construct with provided data', () => {
      const data = {
        async: true as const,
        asyncTimeout: 5000,
        continue: false,
        stopReason: 'test stop',
        suppressOutput: true,
        systemMessage: 'test system message',
        decision: 'deny' as HookDecision,
        reason: 'test reason',
        hookSpecificOutput: { key: 'value' },
      };
      const output = new DefaultHookOutput(data);
      expect(output.async).toBe(data.async);
      expect(output.asyncTimeout).toBe(data.asyncTimeout);
      expect(output.continue).toBe(data.continue);
      expect(output.stopReason).toBe(data.stopReason);
      expect(output.suppressOutput).toBe(data.suppressOutput);
      expect(output.systemMessage).toBe(data.systemMessage);
      expect(output.decision).toBe(data.decision);
      expect(output.reason).toBe(data.reason);
      expect(output.hookSpecificOutput).toEqual(data.hookSpecificOutput);
    });

    it('should return false for isBlockingDecision if decision is not block or deny', () => {
      const output1 = new DefaultHookOutput({ decision: 'allow' });
      expect(output1.isBlockingDecision()).toBe(false);
      const output2 = new DefaultHookOutput({ decision: undefined });
      expect(output2.isBlockingDecision()).toBe(false);
    });

    it('should return true for isBlockingDecision if decision is block or deny', () => {
      const output1 = new DefaultHookOutput({ decision: 'deny' });
      expect(output1.isBlockingDecision()).toBe(true);
      const output2 = new DefaultHookOutput({ decision: 'deny' });
      expect(output2.isBlockingDecision()).toBe(true);
    });

    it('should return true for shouldStopExecution if continue is false', () => {
      const output = new DefaultHookOutput({ continue: false });
      expect(output.shouldStopExecution()).toBe(true);
    });

    it('should return false for shouldStopExecution if continue is true or undefined', () => {
      const output1 = new DefaultHookOutput({ continue: true });
      expect(output1.shouldStopExecution()).toBe(false);
      const output2 = new DefaultHookOutput({});
      expect(output2.shouldStopExecution()).toBe(false);
    });

    it('should return reason if available', () => {
      const output = new DefaultHookOutput({ reason: 'specific reason' });
      expect(output.getEffectiveReason()).toBe('specific reason');
    });

    it('should return stopReason if reason is not available', () => {
      const output = new DefaultHookOutput({ stopReason: 'stop reason' });
      expect(output.getEffectiveReason()).toBe('stop reason');
    });

    it('should return "No reason provided" if neither reason nor stopReason are available', () => {
      const output = new DefaultHookOutput({});
      expect(output.getEffectiveReason()).toBe('No reason provided');
    });

    it('getAdditionalContext should return additional context if present', () => {
      const output = new DefaultHookOutput({
        hookSpecificOutput: { additionalContext: 'some context' },
      });
      expect(output.getAdditionalContext()).toBe('some context');
    });

    it('getAdditionalContext should return raw context without escaping', () => {
      const output = new DefaultHookOutput({
        hookSpecificOutput: {
          additionalContext: 'context with <tag> and </hook_context>',
        },
      });
      expect(output.getAdditionalContext()).toBe(
        'context with <tag> and </hook_context>',
      );
    });

    it('getAdditionalContext should return undefined if additionalContext is not present', () => {
      const output = new DefaultHookOutput({
        hookSpecificOutput: { other: 'value' },
      });
      expect(output.getAdditionalContext()).toBeUndefined();
    });

    it('getAdditionalContext should return undefined if hookSpecificOutput is undefined', () => {
      const output = new DefaultHookOutput({});
      expect(output.getAdditionalContext()).toBeUndefined();
    });

    it('returns structured and empty-string tool replacements by field presence', () => {
      const structured = { stdout: 'replacement', stderr: '' };
      expect(
        new DefaultHookOutput({
          hookSpecificOutput: { updatedToolOutput: structured },
        }).getUpdatedToolOutput(),
      ).toEqual(structured);
      expect(
        new DefaultHookOutput({
          hookSpecificOutput: { updatedToolOutput: '' },
        }).getUpdatedToolOutput(),
      ).toBe('');
    });

    it('getStdoutForModel should truncate long stdout for model-visible events', () => {
      const longMessage = 'x'.repeat(15000);
      const output = new DefaultHookOutput({
        stdoutContent: longMessage,
      });
      const result = output.getStdoutForModel(HookEventName.SessionStart)!;
      const filePath = result.match(/Full output saved to: (.+)\]$/)?.[1];
      expect(filePath).toBeDefined();
      try {
        const slug = process.env['BRAND_TEMP_PATH_SLUG'] || 'qwen-code';
        expect(result.length).toBeLessThan(15000);
        expect(result).toContain('… [output truncated');
        expect(basename(dirname(filePath!))).toBe(`${slug}-hook-output`);
        expect(readFileSync(filePath!, 'utf8')).toBe(longMessage);
      } finally {
        if (filePath) rmSync(filePath, { force: true });
      }
    });

    it('getBlockingError should return blocked: true and reason if blocking decision', () => {
      const output = new DefaultHookOutput({
        decision: 'deny',
        reason: 'blocked by hook',
      });
      expect(output.getBlockingError()).toEqual({
        blocked: true,
        reason: 'blocked by hook',
      });
    });

    it('getBlockingError should return blocked: false if not blocking decision', () => {
      const output = new DefaultHookOutput({ decision: 'allow' });
      expect(output.getBlockingError()).toEqual({ blocked: false, reason: '' });
    });
  });
});

describe('Hook output schema helpers', () => {
  it('normalizes external decision vocabulary to internal', () => {
    expect(validateHookOutput({ decision: 'approve' })).toEqual({
      success: true,
      output: { decision: 'allow' },
    });
    expect(validateHookOutput({ decision: 'block' })).toEqual({
      success: true,
      output: { decision: 'deny' },
    });
  });

  it('rejects internal-only decision values from external input', () => {
    const result = validateHookOutput({ decision: 'ask' });
    expect(result.success).toBe(false);
  });

  it('accepts async hook output without asyncTimeout', () => {
    expect(
      validateHookOutput({
        async: true,
      }),
    ).toEqual({
      success: true,
      output: {
        async: true,
      },
    });
  });

  it('accepts async hook output as a non-control result', () => {
    expect(
      validateHookOutput({
        async: true,
        asyncTimeout: 5000,
      }),
    ).toEqual({
      success: true,
      output: {
        async: true,
        asyncTimeout: 5000,
      },
    });
  });

  it('ignores synchronous control fields when async is true', () => {
    expect(
      validateHookOutput({
        async: true,
        asyncTimeout: 5000,
        continue: false,
        decision: 'block',
        reason: 'should not be consumed',
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'should not be consumed',
        },
      }),
    ).toEqual({
      success: true,
      output: {
        async: true,
        asyncTimeout: 5000,
      },
    });
  });

  it('accepts PreToolUse defer permissionDecision without normalizing to a decision', () => {
    expect(
      validateHookOutput({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'defer',
          updatedInput: { path: '/tmp/updated' },
        },
      }),
    ).toEqual({
      success: true,
      output: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'defer',
          updatedInput: { path: '/tmp/updated' },
        },
      },
    });

    const output = new PreToolUseHookOutput({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'defer',
      },
    });
    expect(output.decision).toBeUndefined();
  });

  it('accepts Setup hookSpecificOutput', () => {
    expect(
      validateHookOutput({
        hookSpecificOutput: {
          hookEventName: 'Setup',
          additionalContext: 'setup context',
        },
      }),
    ).toEqual({
      success: true,
      output: {
        hookSpecificOutput: {
          hookEventName: 'Setup',
          additionalContext: 'setup context',
        },
      },
    });
  });

  it('accepts notification-only QueryEnd hookSpecificOutput', () => {
    expect(
      validateHookOutput({
        hookSpecificOutput: { hookEventName: 'QueryEnd' },
      }),
    ).toEqual({
      success: true,
      output: {
        hookSpecificOutput: { hookEventName: 'QueryEnd' },
      },
    });
  });

  describe('strict hookEventName validation', () => {
    it('accepts a structured PostToolUse replacement value', () => {
      expect(
        validateHookOutput({
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            updatedToolOutput: {
              stdout: 'replacement',
              stderr: '',
              interrupted: false,
              isImage: false,
            },
          },
        }),
      ).toEqual({
        success: true,
        output: {
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            updatedToolOutput: {
              stdout: 'replacement',
              stderr: '',
              interrupted: false,
              isImage: false,
            },
          },
        },
      });
    });

    it('rejects hookSpecificOutput without hookEventName and offers a recovery hint when only additionalContext is present', () => {
      const result = validateHookOutput({
        hookSpecificOutput: { additionalContext: 'x' },
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain(
        'hookSpecificOutput is missing required field "hookEventName"',
      );
      expect(result.error).toContain(
        'Did you mean hookSpecificOutput.additionalContext (with a hookEventName)?',
      );
      expect(result.error).toContain("The hook's output was:");
    });

    it('rejects hookSpecificOutput without hookEventName but omits the recovery hint when extra fields are present', () => {
      const result = validateHookOutput({
        hookSpecificOutput: {
          additionalContext: 'x',
          permissionDecision: 'allow',
        },
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain(
        'hookSpecificOutput is missing required field "hookEventName"',
      );
      expect(result.error).not.toContain('Did you mean');
    });

    it('rejects hookSpecificOutput with an unknown hookEventName value', () => {
      const result = validateHookOutput({
        hookSpecificOutput: { hookEventName: 'NotAnEvent' },
      });
      expect(result.success).toBe(false);
    });

    it('short-circuits async:true even when hookSpecificOutput lacks hookEventName', () => {
      expect(
        validateHookOutput({
          async: true,
          asyncTimeout: 5000,
          hookSpecificOutput: { additionalContext: 'x' },
        }),
      ).toEqual({
        success: true,
        output: { async: true, asyncTimeout: 5000 },
      });
    });

    it('rejects async:true with an invalid asyncTimeout type', () => {
      const result = validateHookOutput({
        async: true,
        asyncTimeout: 'oops' as unknown as number,
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain('async: ');
    });

    it('redacts credential-like keys in the raw dump', () => {
      const result = validateHookOutput({
        apiKey: 'super-secret',
        authorization: 'Bearer xyz',
        hookSpecificOutput: { additionalContext: 'x' },
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain('[REDACTED]');
      expect(result.error).not.toContain('super-secret');
      expect(result.error).not.toContain('Bearer xyz');
    });

    it('truncates large hook output dumps in the error message', () => {
      const big = 'A'.repeat(5000);
      const result = validateHookOutput({
        hookSpecificOutput: { additionalContext: big },
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toMatch(/…\[truncated, total \d+ chars\]/);
    });
  });
});
