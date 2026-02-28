/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  HookEventName,
  HookType,
  HooksConfigSource,
  PermissionMode,
} from './types.js';
import type {
  HookDecision,
  CommandHookConfig,
  PreToolUseInput,
  PostToolUseInput,
  NotificationInput,
} from './types.js';
import {
  NotificationType,
  SessionStartSource,
  SessionEndReason,
  PreCompactTrigger,
  AgentType,
} from './types.js';
import {
  getHookKey,
  createHookOutput,
  DefaultHookOutput,
  PreToolUseHookOutput,
  StopHookOutput,
  PermissionRequestHookOutput,
} from './types.js';

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
  it('should have correct sources', () => {
    expect(HooksConfigSource.Project).toBe('project');
    expect(HooksConfigSource.User).toBe('user');
    expect(HooksConfigSource.System).toBe('system');
    expect(HooksConfigSource.Extensions).toBe('extensions');
  });
});

describe('HookDecision', () => {
  it('should have correct decision types', () => {
    const decisions: HookDecision[] = [
      'ask',
      'block',
      'deny',
      'approve',
      'allow',
    ];
    expect(decisions).toContain('ask');
    expect(decisions).toContain('block');
    expect(decisions).toContain('deny');
    expect(decisions).toContain('approve');
    expect(decisions).toContain('allow');
  });

  it('should not allow undefined', () => {
    // @ts-expect-error - undefined should not be allowed
    const invalidDecision: HookDecision = undefined;
    expect(invalidDecision).toBeUndefined();
  });
});

describe('getHookKey', () => {
  it('should return command when name is not provided', () => {
    const hook: CommandHookConfig = {
      type: HookType.Command,
      command: 'echo test',
    };
    expect(getHookKey(hook)).toBe('echo test');
  });

  it('should return name:command when name is provided', () => {
    const hook: CommandHookConfig = {
      type: HookType.Command,
      command: 'echo test',
      name: 'my-hook',
    };
    expect(getHookKey(hook)).toBe('my-hook:echo test');
  });

  it('should handle empty name string', () => {
    const hook: CommandHookConfig = {
      type: HookType.Command,
      command: 'echo test',
      name: '',
    };
    expect(getHookKey(hook)).toBe('echo test');
  });
});

describe('createHookOutput', () => {
  it('should create DefaultHookOutput for unknown events', () => {
    const output = createHookOutput('UnknownEvent', {});
    expect(output).toBeInstanceOf(DefaultHookOutput);
    expect(output).not.toBeInstanceOf(PreToolUseHookOutput);
    expect(output).not.toBeInstanceOf(StopHookOutput);
    expect(output).not.toBeInstanceOf(PermissionRequestHookOutput);
  });

  it('should create PreToolUseHookOutput for PreToolUse event', () => {
    const output = createHookOutput(HookEventName.PreToolUse, {
      continue: true,
    });
    expect(output).toBeInstanceOf(PreToolUseHookOutput);
    expect(output.continue).toBe(true);
  });

  it('should create StopHookOutput for Stop event', () => {
    const output = createHookOutput(HookEventName.Stop, {
      stopReason: 'User requested stop',
    });
    expect(output).toBeInstanceOf(StopHookOutput);
    expect(output.stopReason).toBe('User requested stop');
  });

  it('should create PermissionRequestHookOutput for PermissionRequest event', () => {
    const output = createHookOutput(HookEventName.PermissionRequest, {
      decision: 'allow',
    });
    expect(output).toBeInstanceOf(PermissionRequestHookOutput);
    expect(output.decision).toBe('allow');
  });
});

describe('DefaultHookOutput', () => {
  it('should create instance with provided data', () => {
    const output = new DefaultHookOutput({
      continue: false,
      stopReason: 'test reason',
      suppressOutput: true,
      systemMessage: 'System message',
      decision: 'block',
      reason: 'Blocked by hook',
      hookSpecificOutput: { key: 'value' },
    });

    expect(output.continue).toBe(false);
    expect(output.stopReason).toBe('test reason');
    expect(output.suppressOutput).toBe(true);
    expect(output.systemMessage).toBe('System message');
    expect(output.decision).toBe('block');
    expect(output.reason).toBe('Blocked by hook');
    expect(output.hookSpecificOutput).toEqual({ key: 'value' });
  });

  it('should handle undefined data', () => {
    const output = new DefaultHookOutput();
    expect(output.continue).toBeUndefined();
    expect(output.decision).toBeUndefined();
  });

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

    it('should return false for undefined decision', () => {
      const output = new DefaultHookOutput({});
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

    it('should return false when continue is undefined', () => {
      const output = new DefaultHookOutput({});
      expect(output.shouldStopExecution()).toBe(false);
    });
  });

  describe('getEffectiveReason', () => {
    it('should return stopReason when available', () => {
      const output = new DefaultHookOutput({ stopReason: 'stop reason' });
      expect(output.getEffectiveReason()).toBe('stop reason');
    });

    it('should return reason when stopReason is not available', () => {
      const output = new DefaultHookOutput({ reason: 'reason' });
      expect(output.getEffectiveReason()).toBe('reason');
    });

    it('should return default message when neither is available', () => {
      const output = new DefaultHookOutput({});
      expect(output.getEffectiveReason()).toBe('No reason provided');
    });
  });

  describe('getAdditionalContext', () => {
    it('should return sanitized additional context', () => {
      const output = new DefaultHookOutput({
        hookSpecificOutput: { additionalContext: '<script>alert(1)</script>' },
      });
      expect(output.getAdditionalContext()).toBe(
        '&lt;script&gt;alert(1)&lt;/script&gt;',
      );
    });

    it('should return undefined when additionalContext is not a string', () => {
      const output = new DefaultHookOutput({
        hookSpecificOutput: { additionalContext: 123 },
      });
      expect(output.getAdditionalContext()).toBeUndefined();
    });

    it('should return undefined when additionalContext is missing', () => {
      const output = new DefaultHookOutput({});
      expect(output.getAdditionalContext()).toBeUndefined();
    });
  });

  describe('getBlockingError', () => {
    it('should return blocked info for block decision', () => {
      const output = new DefaultHookOutput({
        decision: 'block',
        reason: 'Blocked by hook',
      });
      expect(output.getBlockingError()).toEqual({
        blocked: true,
        reason: 'Blocked by hook',
      });
    });

    it('should return blocked info for deny decision', () => {
      const output = new DefaultHookOutput({
        decision: 'deny',
        reason: 'Denied by hook',
      });
      expect(output.getBlockingError()).toEqual({
        blocked: true,
        reason: 'Denied by hook',
      });
    });

    it('should return not blocked for allow decision', () => {
      const output = new DefaultHookOutput({ decision: 'allow' });
      expect(output.getBlockingError()).toEqual({
        blocked: false,
        reason: '',
      });
    });
  });

  describe('shouldClearContext', () => {
    it('should always return false in base class', () => {
      const output = new DefaultHookOutput({});
      expect(output.shouldClearContext()).toBe(false);
    });
  });
});

describe('PreToolUseHookOutput', () => {
  it('should create instance with provided data', () => {
    const output = new PreToolUseHookOutput({
      continue: true,
      hookSpecificOutput: { tool_input: { arg: 'value' } },
    });

    expect(output.continue).toBe(true);
  });

  describe('getModifiedToolInput', () => {
    it('should return modified tool input when provided', () => {
      const output = new PreToolUseHookOutput({
        hookSpecificOutput: { tool_input: { arg: 'modified' } },
      });
      expect(output.getModifiedToolInput()).toEqual({ arg: 'modified' });
    });

    it('should return undefined when tool_input is not an object', () => {
      const output = new PreToolUseHookOutput({
        hookSpecificOutput: { tool_input: 'not an object' },
      });
      expect(output.getModifiedToolInput()).toBeUndefined();
    });

    it('should return undefined when tool_input is missing', () => {
      const output = new PreToolUseHookOutput({});
      expect(output.getModifiedToolInput()).toBeUndefined();
    });

    it('should return undefined when tool_input is null', () => {
      const output = new PreToolUseHookOutput({
        hookSpecificOutput: { tool_input: null },
      });
      expect(output.getModifiedToolInput()).toBeUndefined();
    });

    it('should return undefined when tool_input is an array', () => {
      const output = new PreToolUseHookOutput({
        hookSpecificOutput: { tool_input: ['array'] },
      });
      expect(output.getModifiedToolInput()).toBeUndefined();
    });
  });
});

describe('StopHookOutput', () => {
  it('should create instance with provided data', () => {
    const output = new StopHookOutput({
      stopReason: 'User requested stop',
    });

    expect(output.stopReason).toBe('User requested stop');
  });

  describe('getStopReason', () => {
    it('should return formatted stop reason', () => {
      const output = new StopHookOutput({ stopReason: 'test reason' });
      expect(output.getStopReason()).toBe('Stop hook feedback:\ntest reason');
    });

    it('should return undefined when stopReason is not available', () => {
      const output = new StopHookOutput({});
      expect(output.getStopReason()).toBeUndefined();
    });
  });
});

describe('PermissionRequestHookOutput', () => {
  it('should create instance with provided data', () => {
    const output = new PermissionRequestHookOutput({
      decision: 'allow',
    });

    expect(output.decision).toBe('allow');
  });

  describe('getPermissionDecision', () => {
    it('should return decision object when provided', () => {
      const output = new PermissionRequestHookOutput({
        hookSpecificOutput: {
          decision: {
            behavior: 'allow',
            updatedInput: { arg: 'modified' },
          },
        },
      });

      expect(output.getPermissionDecision()).toEqual({
        behavior: 'allow',
        updatedInput: { arg: 'modified' },
      });
    });

    it('should return undefined when decision is not an object', () => {
      const output = new PermissionRequestHookOutput({
        hookSpecificOutput: { decision: 'not an object' },
      });
      expect(output.getPermissionDecision()).toBeUndefined();
    });

    it('should return undefined when decision is missing', () => {
      const output = new PermissionRequestHookOutput({});
      expect(output.getPermissionDecision()).toBeUndefined();
    });
  });

  describe('isPermissionDenied', () => {
    it('should return true when behavior is deny', () => {
      const output = new PermissionRequestHookOutput({
        hookSpecificOutput: { decision: { behavior: 'deny' } },
      });
      expect(output.isPermissionDenied()).toBe(true);
    });

    it('should return false when behavior is allow', () => {
      const output = new PermissionRequestHookOutput({
        hookSpecificOutput: { decision: { behavior: 'allow' } },
      });
      expect(output.isPermissionDenied()).toBe(false);
    });
  });

  describe('getDenyMessage', () => {
    it('should return message when permission denied', () => {
      const output = new PermissionRequestHookOutput({
        hookSpecificOutput: {
          decision: { behavior: 'deny', message: 'Permission denied' },
        },
      });
      expect(output.getDenyMessage()).toBe('Permission denied');
    });

    it('should return undefined when permission allowed', () => {
      const output = new PermissionRequestHookOutput({
        hookSpecificOutput: { decision: { behavior: 'allow' } },
      });
      expect(output.getDenyMessage()).toBeUndefined();
    });
  });

  describe('shouldInterrupt', () => {
    it('should return true when interrupt is true', () => {
      const output = new PermissionRequestHookOutput({
        hookSpecificOutput: { decision: { behavior: 'deny', interrupt: true } },
      });
      expect(output.shouldInterrupt()).toBe(true);
    });

    it('should return false when interrupt is not set', () => {
      const output = new PermissionRequestHookOutput({
        hookSpecificOutput: { decision: { behavior: 'deny' } },
      });
      expect(output.shouldInterrupt()).toBe(false);
    });
  });

  describe('getUpdatedToolInput', () => {
    it('should return updated tool input when provided', () => {
      const output = new PermissionRequestHookOutput({
        hookSpecificOutput: {
          decision: { behavior: 'allow', updatedInput: { arg: 'new' } },
        },
      });
      expect(output.getUpdatedToolInput()).toEqual({ arg: 'new' });
    });

    it('should return undefined when not provided', () => {
      const output = new PermissionRequestHookOutput({
        hookSpecificOutput: { decision: { behavior: 'allow' } },
      });
      expect(output.getUpdatedToolInput()).toBeUndefined();
    });
  });

  describe('getUpdatedPermissions', () => {
    it('should return updated permissions when provided', () => {
      const output = new PermissionRequestHookOutput({
        hookSpecificOutput: {
          decision: {
            behavior: 'allow',
            updatedPermissions: [{ type: 'read' }],
          },
        },
      });
      expect(output.getUpdatedPermissions()).toEqual([{ type: 'read' }]);
    });

    it('should return undefined when not provided', () => {
      const output = new PermissionRequestHookOutput({
        hookSpecificOutput: { decision: { behavior: 'allow' } },
      });
      expect(output.getUpdatedPermissions()).toBeUndefined();
    });
  });
});

describe('Input types', () => {
  describe('PreToolUseInput', () => {
    it('should have required fields', () => {
      const input: PreToolUseInput = {
        session_id: 'session-1',
        transcript_path: '/path/to/transcript',
        cwd: '/workspace',
        hook_event_name: HookEventName.PreToolUse,
        timestamp: '2026-01-01T00:00:00Z',
        tool_name: 'ReadFileTool',
        tool_input: { path: '/file.txt' },
      };

      expect(input.tool_name).toBe('ReadFileTool');
      expect(input.tool_input).toEqual({ path: '/file.txt' });
    });

    it('should have optional mcp_context', () => {
      const input: PreToolUseInput = {
        session_id: 'session-1',
        transcript_path: '/path/to/transcript',
        cwd: '/workspace',
        hook_event_name: HookEventName.PreToolUse,
        timestamp: '2026-01-01T00:00:00Z',
        tool_name: 'ReadFileTool',
        tool_input: {},
        mcp_context: {
          server_name: 'mcp-server',
          tool_name: 'remote_read',
          command: 'node',
          args: ['server.js'],
        },
      };

      expect(input.mcp_context?.server_name).toBe('mcp-server');
    });

    it('should have optional original_request_name', () => {
      const input: PreToolUseInput = {
        session_id: 'session-1',
        transcript_path: '/path/to/transcript',
        cwd: '/workspace',
        hook_event_name: HookEventName.PreToolUse,
        timestamp: '2026-01-01T00:00:00Z',
        tool_name: 'ReadFileTool',
        tool_input: {},
        original_request_name: 'original-tool',
      };

      expect(input.original_request_name).toBe('original-tool');
    });
  });

  describe('PostToolUseInput', () => {
    it('should have required fields', () => {
      const input: PostToolUseInput = {
        session_id: 'session-1',
        transcript_path: '/path/to/transcript',
        cwd: '/workspace',
        hook_event_name: HookEventName.PostToolUse,
        timestamp: '2026-01-01T00:00:00Z',
        tool_name: 'ReadFileTool',
        tool_input: { path: '/file.txt' },
        tool_response: { content: 'file content' },
      };

      expect(input.tool_response).toEqual({ content: 'file content' });
    });
  });

  describe('NotificationInput', () => {
    it('should have required fields', () => {
      const input: NotificationInput = {
        session_id: 'session-1',
        transcript_path: '/path/to/transcript',
        cwd: '/workspace',
        hook_event_name: HookEventName.Notification,
        timestamp: '2026-01-01T00:00:00Z',
        notification_type: NotificationType.ToolPermission,
        message: 'Tool permission required',
        details: { tool: 'ReadFileTool' },
      };

      expect(input.notification_type).toBe(NotificationType.ToolPermission);
    });

    it('should have optional permission_mode', () => {
      const input: NotificationInput = {
        session_id: 'session-1',
        transcript_path: '/path/to/transcript',
        cwd: '/workspace',
        hook_event_name: HookEventName.Notification,
        timestamp: '2026-01-01T00:00:00Z',
        permission_mode: PermissionMode.Default,
        notification_type: NotificationType.ToolPermission,
        message: 'Tool permission required',
        details: {},
      };

      expect(input.permission_mode).toBe('default');
    });
  });

  describe('SessionStartSource', () => {
    it('should have correct sources', () => {
      expect(SessionStartSource.Startup).toBe('startup');
      expect(SessionStartSource.Resume).toBe('resume');
      expect(SessionStartSource.Clear).toBe('clear');
      expect(SessionStartSource.Compact).toBe('compact');
    });
  });

  describe('SessionEndReason', () => {
    it('should have correct reasons', () => {
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
    it('should have correct triggers', () => {
      expect(PreCompactTrigger.Manual).toBe('manual');
      expect(PreCompactTrigger.Auto).toBe('auto');
    });
  });

  describe('AgentType', () => {
    it('should have correct types', () => {
      expect(AgentType.Bash).toBe('Bash');
      expect(AgentType.Explorer).toBe('Explorer');
      expect(AgentType.Plan).toBe('Plan');
      expect(AgentType.Custom).toBe('Custom');
    });
  });
});
