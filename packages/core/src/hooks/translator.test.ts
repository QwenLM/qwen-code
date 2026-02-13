/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { HookTranslator, createHookTranslator } from './translator.js';
import {
  HookEventName,
  NotificationType,
  SessionStartSource,
  SessionEndReason,
  PreCompactTrigger,
} from './types.js';
import type { HookInput } from './types.js';

describe('HookTranslator', () => {
  const baseInput: HookInput = {
    session_id: 'test-session',
    transcript_path: '/test/transcript',
    cwd: '/test',
    hook_event_name: HookEventName.PreToolUse,
    timestamp: '2024-01-01T00:00:00Z',
  };

  describe('translatePreToolUse', () => {
    it('should translate SDK tool use to hook input', () => {
      const toolUse = {
        id: 'tool-123',
        name: 'WriteFile',
        input: { path: '/test/file.txt', content: 'hello' },
      };

      const result = HookTranslator.translatePreToolUse(baseInput, toolUse);

      expect(result.tool_name).toBe('WriteFile');
      expect(result.tool_input).toEqual({
        path: '/test/file.txt',
        content: 'hello',
      });
      expect(result.tool_use_id).toBe('tool-123');
      expect(result.session_id).toBe('test-session');
    });
  });

  describe('translatePreToolUseOutput', () => {
    it('should translate PreToolUse hook output to SDK format', () => {
      const output = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason: 'Access denied by policy',
          updatedInput: { path: '/modified/path.txt' },
        },
      };

      const result = HookTranslator.translatePreToolUseOutput(output);

      expect(result.decision).toBe('deny');
      expect(result.reason).toBe('Access denied by policy');
      expect(result.updatedInput).toEqual({ path: '/modified/path.txt' });
    });

    it('should fallback to top-level decision field', () => {
      const output = {
        decision: 'block' as const,
        reason: 'Blocked by rule',
      };

      const result = HookTranslator.translatePreToolUseOutput(output);

      expect(result.decision).toBe('deny');
      expect(result.reason).toBe('Blocked by rule');
    });

    it('should map allow/approve to allow', () => {
      const output = {
        decision: 'approve' as const,
      };

      const result = HookTranslator.translatePreToolUseOutput(output);

      expect(result.decision).toBe('allow');
    });

    it('should preserve ask decision', () => {
      const output = {
        decision: 'ask' as const,
      };

      const result = HookTranslator.translatePreToolUseOutput(output);

      expect(result.decision).toBe('ask');
    });

    it('should default to allow when no decision specified', () => {
      const output = {};

      const result = HookTranslator.translatePreToolUseOutput(output);

      expect(result.decision).toBe('allow');
    });
  });

  describe('translatePostToolUse', () => {
    it('should translate SDK tool use and response to hook input', () => {
      const toolUse = {
        id: 'tool-123',
        name: 'ReadFile',
        input: { path: '/test/file.txt' },
      };

      const toolResponse = {
        id: 'tool-123',
        output: { content: 'file contents' },
      };

      const result = HookTranslator.translatePostToolUse(
        baseInput,
        toolUse,
        toolResponse,
      );

      expect(result.tool_name).toBe('ReadFile');
      expect(result.tool_response).toEqual({ content: 'file contents' });
    });

    it('should handle error responses', () => {
      const toolUse = {
        id: 'tool-123',
        name: 'ReadFile',
        input: { path: '/test/file.txt' },
      };

      const toolResponse = {
        id: 'tool-123',
        output: { error: 'File not found' },
        isError: true,
      };

      const result = HookTranslator.translatePostToolUse(
        baseInput,
        toolUse,
        toolResponse,
      );

      expect(result.tool_response).toEqual({ error: 'File not found' });
    });
  });

  describe('translatePostToolUseOutput', () => {
    it('should extract additional context', () => {
      const output = {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse' as const,
          additionalContext: 'The file was successfully read',
        },
      };

      const result = HookTranslator.translatePostToolUseOutput(output);

      expect(result.additionalContext).toBe('The file was successfully read');
    });

    it('should handle empty output', () => {
      const output = {};

      const result = HookTranslator.translatePostToolUseOutput(output);

      expect(result.additionalContext).toBeUndefined();
    });
  });

  describe('translatePermissionRequest', () => {
    it('should translate permission request to hook input', () => {
      const toolUse = {
        id: 'tool-456',
        name: 'DeleteFile',
        input: { path: '/test/file.txt' },
      };

      const result = HookTranslator.translatePermissionRequest(
        baseInput,
        toolUse,
      );

      expect(result.tool_name).toBe('DeleteFile');
      expect(result.tool_input).toEqual({ path: '/test/file.txt' });
    });
  });

  describe('translatePermissionRequestOutput', () => {
    it('should translate PermissionRequest hook output to SDK format', () => {
      const output = {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest' as const,
          decision: {
            behavior: 'deny' as const,
            updatedInput: { path: '/safe/path.txt' },
            message: 'Access denied for security reasons',
            interrupt: true,
          },
        },
      };

      const result = HookTranslator.translatePermissionRequestOutput(output);

      expect(result.behavior).toBe('deny');
      expect(result.updatedInput).toEqual({ path: '/safe/path.txt' });
      expect(result.message).toBe('Access denied for security reasons');
      expect(result.interrupt).toBe(true);
    });

    it('should fallback to top-level decision field', () => {
      const output = {
        decision: 'block' as const,
        reason: 'Blocked by policy',
      };

      const result = HookTranslator.translatePermissionRequestOutput(output);

      expect(result.behavior).toBe('deny');
      expect(result.message).toBe('Blocked by policy');
    });

    it('should default to allow when no decision specified', () => {
      const output = {};

      const result = HookTranslator.translatePermissionRequestOutput(output);

      expect(result.behavior).toBe('allow');
    });
  });

  describe('translateUserPromptSubmit', () => {
    it('should translate user prompt to hook input', () => {
      const userPrompt = {
        prompt: 'Hello, how are you?',
        context: { previousMessages: [] },
      };

      const result = HookTranslator.translateUserPromptSubmit(
        baseInput,
        userPrompt,
      );

      expect(result.prompt).toBe('Hello, how are you?');
    });
  });

  describe('translateUserPromptSubmitOutput', () => {
    it('should extract additional context', () => {
      const output = {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit' as const,
          additionalContext: 'Context from hook',
        },
      };

      const result = HookTranslator.translateUserPromptSubmitOutput(output);

      expect(result.additionalContext).toBe('Context from hook');
    });
  });

  describe('translateStop', () => {
    it('should translate Stop event to hook input', () => {
      const result = HookTranslator.translateStop(baseInput, true);

      expect(result.stop_hook_active).toBe(true);
    });

    it('should handle inactive stop hook', () => {
      const result = HookTranslator.translateStop(baseInput, false);

      expect(result.stop_hook_active).toBe(false);
    });
  });

  describe('translateStopOutput', () => {
    it('should block stop when decision is block', () => {
      const output = {
        decision: 'block' as const,
        reason: 'Continue working',
      };

      const result = HookTranslator.translateStopOutput(output);

      expect(result.shouldStop).toBe(false);
      expect(result.reason).toBe('Continue working');
    });

    it('should block stop when continue is false', () => {
      const output = {
        continue: false,
        reason: 'Continue working',
      };

      const result = HookTranslator.translateStopOutput(output);

      expect(result.shouldStop).toBe(false);
    });

    it('should allow stop when no blocking decision', () => {
      const output = {};

      const result = HookTranslator.translateStopOutput(output);

      expect(result.shouldStop).toBe(true);
    });
  });

  describe('translateSubagentStop', () => {
    it('should translate SubagentStop event to hook input', () => {
      const result = HookTranslator.translateSubagentStop(baseInput, true);

      expect(result.stop_hook_active).toBe(true);
    });
  });

  describe('translateSubagentStopOutput', () => {
    it('should behave same as Stop output', () => {
      const output = {
        decision: 'block' as const,
        reason: 'Continue subagent',
      };

      const result = HookTranslator.translateSubagentStopOutput(output);

      expect(result.shouldStop).toBe(false);
      expect(result.reason).toBe('Continue subagent');
    });
  });

  describe('translateNotification', () => {
    it('should translate Notification event to hook input', () => {
      const result = HookTranslator.translateNotification(
        baseInput,
        NotificationType.PermissionPrompt,
        'Permission required',
      );

      expect(result.notification_type).toBe(NotificationType.PermissionPrompt);
      expect(result.message).toBe('Permission required');
    });
  });

  describe('translateNotificationOutput', () => {
    it('should extract suppress flag', () => {
      const output = {
        suppressOutput: true,
      };

      const result = HookTranslator.translateNotificationOutput(output);

      expect(result.suppress).toBe(true);
    });

    it('should default to not suppress', () => {
      const output = {};

      const result = HookTranslator.translateNotificationOutput(output);

      expect(result.suppress).toBe(false);
    });
  });

  describe('translateSessionStart', () => {
    it('should translate SessionStart event to hook input', () => {
      const result = HookTranslator.translateSessionStart(
        baseInput,
        SessionStartSource.Startup,
      );

      expect(result.source).toBe(SessionStartSource.Startup);
    });

    it('should handle different sources', () => {
      const resumeResult = HookTranslator.translateSessionStart(
        baseInput,
        SessionStartSource.Resume,
      );
      expect(resumeResult.source).toBe(SessionStartSource.Resume);

      const clearResult = HookTranslator.translateSessionStart(
        baseInput,
        SessionStartSource.Clear,
      );
      expect(clearResult.source).toBe(SessionStartSource.Clear);
    });
  });

  describe('translateSessionStartOutput', () => {
    it('should extract additional context', () => {
      const output = {
        hookSpecificOutput: {
          hookEventName: 'SessionStart' as const,
          additionalContext: 'Session started from startup',
        },
      };

      const result = HookTranslator.translateSessionStartOutput(output);

      expect(result.additionalContext).toBe('Session started from startup');
    });
  });

  describe('translateSessionEnd', () => {
    it('should translate SessionEnd event to hook input', () => {
      const result = HookTranslator.translateSessionEnd(
        baseInput,
        SessionEndReason.Logout,
      );

      expect(result.reason).toBe(SessionEndReason.Logout);
    });

    it('should handle different reasons', () => {
      const clearResult = HookTranslator.translateSessionEnd(
        baseInput,
        SessionEndReason.Clear,
      );
      expect(clearResult.reason).toBe(SessionEndReason.Clear);
    });
  });

  describe('translateSessionEndOutput', () => {
    it('should return empty object (SessionEnd cannot block)', () => {
      const output = {};

      const result = HookTranslator.translateSessionEndOutput(output);

      expect(result).toEqual({});
    });
  });

  describe('translatePreCompact', () => {
    it('should translate PreCompact event to hook input', () => {
      const result = HookTranslator.translatePreCompact(
        baseInput,
        PreCompactTrigger.Manual,
        'Custom compact instructions',
      );

      expect(result.trigger).toBe(PreCompactTrigger.Manual);
      expect(result.custom_instructions).toBe('Custom compact instructions');
    });

    it('should handle auto trigger', () => {
      const result = HookTranslator.translatePreCompact(
        baseInput,
        PreCompactTrigger.Auto,
        '',
      );

      expect(result.trigger).toBe(PreCompactTrigger.Auto);
    });
  });

  describe('translatePreCompactOutput', () => {
    it('should extract suppress flag', () => {
      const output = {
        suppressOutput: true,
      };

      const result = HookTranslator.translatePreCompactOutput(output);

      expect(result.suppress).toBe(true);
    });

    it('should default to not suppress', () => {
      const output = {};

      const result = HookTranslator.translatePreCompactOutput(output);

      expect(result.suppress).toBe(false);
    });
  });
});

describe('createHookTranslator', () => {
  it('should return the HookTranslator class', () => {
    const translator = createHookTranslator();
    expect(translator).toBe(HookTranslator);
  });
});
