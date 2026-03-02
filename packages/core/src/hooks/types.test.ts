/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { HookOutput } from './types.js';
import {
  HookEventName,
  HookType,
  HooksConfigSource,
  PermissionMode,
  NotificationType,
  SessionStartSource,
  SessionEndReason,
  PreCompactTrigger,
  AgentType,
  createHookOutput,
  getHookKey,
  PreToolUseHookOutput,
  PostToolUseHookOutput,
  PostToolUseFailureHookOutput,
  NotificationHookOutput,
  DefaultHookOutput,
} from './types.js';

describe('Hook Types', () => {
  describe('HookEventName', () => {
    it('should have correct event names', () => {
      expect(HookEventName.PreToolUse).toBe('PreToolUse');
      expect(HookEventName.PostToolUse).toBe('PostToolUse');
      expect(HookEventName.PostToolUseFailure).toBe('PostToolUseFailure');
      expect(HookEventName.Notification).toBe('Notification');
      expect(HookEventName.UserPromptSubmit).toBe('UserPromptSubmit');
      expect(HookEventName.SessionStart).toBe('SessionStart');
      expect(HookEventName.Stop).toBe('Stop');
      expect(HookEventName.SubagentStart).toBe('SubagentStart');
      expect(HookEventName.SubagentStop).toBe('SubagentStop');
      expect(HookEventName.PreCompact).toBe('PreCompact');
      expect(HookEventName.SessionEnd).toBe('SessionEnd');
      expect(HookEventName.PermissionRequest).toBe('PermissionRequest');
    });
  });

  describe('HookType', () => {
    it('should have correct hook types', () => {
      expect(HookType.Command).toBe('command');
    });
  });

  describe('HooksConfigSource', () => {
    it('should have correct config sources', () => {
      expect(HooksConfigSource.Project).toBe('project');
      expect(HooksConfigSource.User).toBe('user');
      expect(HooksConfigSource.System).toBe('system');
      expect(HooksConfigSource.Extensions).toBe('extensions');
    });
  });

  describe('PermissionMode', () => {
    it('should have correct permission modes', () => {
      expect(PermissionMode.Default).toBe('default');
      expect(PermissionMode.Plan).toBe('plan');
      expect(PermissionMode.AcceptEdit).toBe('accept_edit');
      expect(PermissionMode.DontAsk).toBe('dont_ask');
      expect(PermissionMode.BypassPermissions).toBe('bypass_permissions');
    });
  });

  describe('NotificationType', () => {
    it('should have correct notification types', () => {
      expect(NotificationType.ToolPermission).toBe('ToolPermission');
    });
  });

  describe('SessionStartSource', () => {
    it('should have correct session start sources', () => {
      expect(SessionStartSource.Startup).toBe('startup');
      expect(SessionStartSource.Resume).toBe('resume');
      expect(SessionStartSource.Clear).toBe('clear');
      expect(SessionStartSource.Compact).toBe('compact');
    });
  });

  describe('SessionEndReason', () => {
    it('should have correct session end reasons', () => {
      expect(SessionEndReason.Clear).toBe('clear');
      expect(SessionEndReason.Logout).toBe('logout');
      expect(SessionEndReason.PromptInputExit).toBe('prompt_input_exit');
      expect(SessionEndReason.Bypass_permissions_disabled).toBe(
        'bypass_permissions_disabled',
      );
      expect(SessionEndReason.Other).toBe('other');
    });
  });

  describe('PreCompactTrigger', () => {
    it('should have correct pre compact triggers', () => {
      expect(PreCompactTrigger.Manual).toBe('manual');
      expect(PreCompactTrigger.Auto).toBe('auto');
    });
  });

  describe('AgentType', () => {
    it('should have correct agent types', () => {
      expect(AgentType.Bash).toBe('Bash');
      expect(AgentType.Explorer).toBe('Explorer');
      expect(AgentType.Plan).toBe('Plan');
      expect(AgentType.Custom).toBe('Custom');
    });
  });

  describe('getHookKey', () => {
    it('should return command as key when name is not provided', () => {
      const hook = { type: HookType.Command, command: 'echo test' };
      expect(getHookKey(hook)).toBe('echo test');
    });

    it('should return name:command when name is provided', () => {
      const hook = {
        type: HookType.Command,
        command: 'echo test',
        name: 'my-hook',
      };
      expect(getHookKey(hook)).toBe('my-hook:echo test');
    });
  });

  describe('createHookOutput', () => {
    it('should create PreToolUseHookOutput for PreToolUse event', () => {
      const output = createHookOutput('PreToolUse', {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      });
      expect(output).toBeInstanceOf(PreToolUseHookOutput);
    });

    it('should create PostToolUseHookOutput for PostToolUse event', () => {
      const output = createHookOutput('PostToolUse', {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: 'test',
        },
      });
      expect(output).toBeInstanceOf(PostToolUseHookOutput);
    });

    it('should create PostToolUseFailureHookOutput for PostToolUseFailure event', () => {
      const output = createHookOutput('PostToolUseFailure', {
        hookSpecificOutput: {
          hookEventName: 'PostToolUseFailure',
          additionalContext: 'error details',
        },
      });
      expect(output).toBeInstanceOf(PostToolUseFailureHookOutput);
    });

    it('should create NotificationHookOutput for Notification event', () => {
      const output = createHookOutput('Notification', {
        hookSpecificOutput: {
          hookEventName: 'Notification',
          additionalContext: 'notification logged',
        },
      });
      expect(output).toBeInstanceOf(NotificationHookOutput);
    });

    it('should create DefaultHookOutput for unknown event', () => {
      const output = createHookOutput('UnknownEvent', {});
      expect(output).toBeInstanceOf(DefaultHookOutput);
    });
  });
});

describe('PreToolUseHookOutput', () => {
  describe('getPermissionDecision', () => {
    it('should return permission decision when present', () => {
      const output = new PreToolUseHookOutput({
        hookSpecificOutput: {
          permissionDecision: 'deny',
          permissionDecisionReason: 'Security policy',
        },
      });
      expect(output.getPermissionDecision()).toBe('deny');
    });

    it('should return undefined when permission decision is not present', () => {
      const output = new PreToolUseHookOutput({});
      expect(output.getPermissionDecision()).toBeUndefined();
    });

    it('should return undefined for invalid permission decision values', () => {
      const output = new PreToolUseHookOutput({
        hookSpecificOutput: {
          permissionDecision: 'invalid',
        },
      } as unknown as Partial<HookOutput>);
      expect(output.getPermissionDecision()).toBeUndefined();
    });
  });

  describe('getPermissionDecisionReason', () => {
    it('should return reason when present', () => {
      const output = new PreToolUseHookOutput({
        hookSpecificOutput: {
          permissionDecision: 'deny',
          permissionDecisionReason: 'Security policy violation',
        },
      });
      expect(output.getPermissionDecisionReason()).toBe(
        'Security policy violation',
      );
    });

    it('should return undefined when reason is not present', () => {
      const output = new PreToolUseHookOutput({});
      expect(output.getPermissionDecisionReason()).toBeUndefined();
    });
  });

  describe('getModifiedToolInput', () => {
    it('should return updatedInput when present', () => {
      const modifiedInput = { command: 'safe-command' };
      const output = new PreToolUseHookOutput({
        hookSpecificOutput: {
          updatedInput: modifiedInput,
        },
      });
      expect(output.getModifiedToolInput()).toEqual(modifiedInput);
    });

    it('should fallback to tool_input when updatedInput is not present', () => {
      const input = { command: 'original-command' };
      const output = new PreToolUseHookOutput({
        hookSpecificOutput: {
          tool_input: input,
        },
      });
      expect(output.getModifiedToolInput()).toEqual(input);
    });

    it('should return undefined when neither is present', () => {
      const output = new PreToolUseHookOutput({});
      expect(output.getModifiedToolInput()).toBeUndefined();
    });
  });

  describe('isDenied', () => {
    it('should return true when permissionDecision is deny', () => {
      const output = new PreToolUseHookOutput({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
      expect(output.isDenied()).toBe(true);
    });

    it('should return false when permissionDecision is allow', () => {
      const output = new PreToolUseHookOutput({
        hookSpecificOutput: { permissionDecision: 'allow' },
      });
      expect(output.isDenied()).toBe(false);
    });
  });

  describe('isAsk', () => {
    it('should return true when permissionDecision is ask', () => {
      const output = new PreToolUseHookOutput({
        hookSpecificOutput: { permissionDecision: 'ask' },
      });
      expect(output.isAsk()).toBe(true);
    });

    it('should return false when permissionDecision is not ask', () => {
      const output = new PreToolUseHookOutput({
        hookSpecificOutput: { permissionDecision: 'allow' },
      });
      expect(output.isAsk()).toBe(false);
    });
  });

  describe('isAllowed', () => {
    it('should return true when permissionDecision is allow', () => {
      const output = new PreToolUseHookOutput({
        hookSpecificOutput: { permissionDecision: 'allow' },
      });
      expect(output.isAllowed()).toBe(true);
    });

    it('should return true when permissionDecision is undefined', () => {
      const output = new PreToolUseHookOutput({});
      expect(output.isAllowed()).toBe(true);
    });

    it('should return false when permissionDecision is deny', () => {
      const output = new PreToolUseHookOutput({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
      expect(output.isAllowed()).toBe(false);
    });
  });
});

describe('PostToolUseHookOutput', () => {
  describe('getAdditionalContext', () => {
    it('should return additional context when present', () => {
      const output = new PostToolUseHookOutput({
        hookSpecificOutput: {
          additionalContext: 'Result processed successfully',
        },
      });
      expect(output.getAdditionalContext()).toBe(
        'Result processed successfully',
      );
    });

    it('should return undefined when not present', () => {
      const output = new PostToolUseHookOutput({});
      expect(output.getAdditionalContext()).toBeUndefined();
    });
  });

  describe('getTailToolCallRequest', () => {
    it('should return tail tool call request when present', () => {
      const output = new PostToolUseHookOutput({
        hookSpecificOutput: {
          tailToolCallRequest: {
            name: 'Read',
            args: { file_path: '/test/file.txt' },
          },
        },
      });
      const request = output.getTailToolCallRequest();
      expect(request).toEqual({
        name: 'Read',
        args: { file_path: '/test/file.txt' },
      });
    });

    it('should return undefined when not present', () => {
      const output = new PostToolUseHookOutput({});
      expect(output.getTailToolCallRequest()).toBeUndefined();
    });
  });
});

describe('PostToolUseFailureHookOutput', () => {
  describe('getAdditionalContext', () => {
    it('should return additional context when present', () => {
      const output = new PostToolUseFailureHookOutput({
        hookSpecificOutput: {
          additionalContext: 'Error handled',
        },
      });
      expect(output.getAdditionalContext()).toBe('Error handled');
    });

    it('should return undefined when not present', () => {
      const output = new PostToolUseFailureHookOutput({});
      expect(output.getAdditionalContext()).toBeUndefined();
    });
  });
});

describe('NotificationHookOutput', () => {
  describe('getAdditionalContext', () => {
    it('should return additional context when present', () => {
      const output = new NotificationHookOutput({
        hookSpecificOutput: {
          additionalContext: 'Notification logged',
        },
      });
      expect(output.getAdditionalContext()).toBe('Notification logged');
    });

    it('should return undefined when not present', () => {
      const output = new NotificationHookOutput({});
      expect(output.getAdditionalContext()).toBeUndefined();
    });
  });
});

describe('DefaultHookOutput', () => {
  describe('isBlockingDecision', () => {
    it('should return true for block decision', () => {
      const output = new DefaultHookOutput({ decision: 'block' });
      expect(output.isBlockingDecision()).toBe(true);
    });

    it('should return true for deny decision', () => {
      const output = new DefaultHookOutput({ decision: 'deny' });
      expect(output.isBlockingDecision()).toBe(true);
    });

    it('should return false for allow decision', () => {
      const output = new DefaultHookOutput({ decision: 'allow' });
      expect(output.isBlockingDecision()).toBe(false);
    });
  });

  describe('shouldStopExecution', () => {
    it('should return true when continue is false', () => {
      const output = new DefaultHookOutput({ continue: false });
      expect(output.shouldStopExecution()).toBe(true);
    });

    it('should return false when continue is true', () => {
      const output = new DefaultHookOutput({ continue: true });
      expect(output.shouldStopExecution()).toBe(false);
    });
  });

  describe('getEffectiveReason', () => {
    it('should return stopReason when present', () => {
      const output = new DefaultHookOutput({ stopReason: 'Stopped by user' });
      expect(output.getEffectiveReason()).toBe('Stopped by user');
    });

    it('should return reason when stopReason is not present', () => {
      const output = new DefaultHookOutput({ reason: 'Denied by policy' });
      expect(output.getEffectiveReason()).toBe('Denied by policy');
    });

    it('should return default message when neither is present', () => {
      const output = new DefaultHookOutput({});
      expect(output.getEffectiveReason()).toBe('No reason provided');
    });
  });

  describe('getAdditionalContext', () => {
    it('should return and sanitize additionalContext', () => {
      const output = new DefaultHookOutput({
        hookSpecificOutput: { additionalContext: '<script>alert(1)</script>' },
      });
      expect(output.getAdditionalContext()).toBe(
        '&lt;script&gt;alert(1)&lt;/script&gt;',
      );
    });
  });

  describe('getBlockingError', () => {
    it('should return blocking info when decision is block', () => {
      const output = new DefaultHookOutput({
        decision: 'block',
        reason: 'Test block',
      });
      expect(output.getBlockingError()).toEqual({
        blocked: true,
        reason: 'Test block',
      });
    });

    it('should return non-blocking info when decision is allow', () => {
      const output = new DefaultHookOutput({ decision: 'allow' });
      expect(output.getBlockingError()).toEqual({ blocked: false, reason: '' });
    });
  });

  describe('shouldClearContext', () => {
    it('should return false by default', () => {
      const output = new DefaultHookOutput({});
      expect(output.shouldClearContext()).toBe(false);
    });
  });
});
