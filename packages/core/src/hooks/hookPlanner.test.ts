/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HookRegistry, HookRegistryEntry } from './hookRegistry.js';
import { HookPlanner } from './hookPlanner.js';
import { HookEventName, HookType, HooksConfigSource } from './types.js';

describe('HookPlanner', () => {
  let mockRegistry: HookRegistry;
  let planner: HookPlanner;

  beforeEach(() => {
    mockRegistry = {
      getHooksForEvent: vi.fn(),
    } as unknown as HookRegistry;
    planner = new HookPlanner(mockRegistry);
  });

  describe('createExecutionPlan', () => {
    it('should return null when no hooks for event', () => {
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([]);

      const result = planner.createExecutionPlan(HookEventName.PreToolUse);

      expect(result).toBeNull();
    });

    it('should return null when no hooks match context', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.PreToolUse,
        matcher: 'bash',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.PreToolUse, {
        toolName: 'glob',
      });

      expect(result).toBeNull();
    });

    it('should create plan with matching hooks', () => {
      const entry: HookRegistryEntry = {
        config: {
          type: HookType.Command,
          command: 'echo test',
          name: 'test-hook',
        },
        source: HooksConfigSource.Project,
        eventName: HookEventName.PreToolUse,
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.PreToolUse);

      expect(result).not.toBeNull();
      expect(result!.eventName).toBe(HookEventName.PreToolUse);
      expect(result!.hookConfigs).toHaveLength(1);
      expect(result!.sequential).toBe(false);
    });

    it('should set sequential to true when any hook has sequential=true', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.PreToolUse,
        sequential: true,
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.PreToolUse);

      expect(result!.sequential).toBe(true);
    });

    it('should deduplicate hooks with same config', () => {
      const config = { type: HookType.Command as const, command: 'echo test' };
      const entry1: HookRegistryEntry = {
        config,
        source: HooksConfigSource.Project,
        eventName: HookEventName.PreToolUse,
        enabled: true,
      };
      const entry2: HookRegistryEntry = {
        config,
        source: HooksConfigSource.Project,
        eventName: HookEventName.PreToolUse,
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([
        entry1,
        entry2,
      ]);

      const result = planner.createExecutionPlan(HookEventName.PreToolUse);

      expect(result!.hookConfigs).toHaveLength(1);
    });

    it('should not deduplicate prompt hooks that only share the first 50 characters', () => {
      const sharedPrefix = 'a'.repeat(50);
      const entry1: HookRegistryEntry = {
        config: {
          type: HookType.Prompt,
          prompt: `${sharedPrefix}-first prompt`,
        },
        source: HooksConfigSource.Project,
        eventName: HookEventName.UserPromptSubmit,
        enabled: true,
      };
      const entry2: HookRegistryEntry = {
        config: {
          type: HookType.Prompt,
          prompt: `${sharedPrefix}-second prompt`,
        },
        source: HooksConfigSource.Project,
        eventName: HookEventName.UserPromptSubmit,
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([
        entry1,
        entry2,
      ]);

      const result = planner.createExecutionPlan(
        HookEventName.UserPromptSubmit,
      );

      expect(result).not.toBeNull();
      expect(result!.hookConfigs).toHaveLength(2);
      expect(result!.hookConfigs).toEqual([entry1.config, entry2.config]);
    });
  });

  describe('matchesContext', () => {
    it('should match all when no matcher', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.PreToolUse,
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.PreToolUse, {
        toolName: 'bash',
      });

      expect(result).not.toBeNull();
    });

    it('should match all when no context', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.PreToolUse,
        matcher: 'bash',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.PreToolUse);

      expect(result).not.toBeNull();
    });

    it('should match empty string as wildcard', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.PreToolUse,
        matcher: '',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.PreToolUse, {
        toolName: 'bash',
      });

      expect(result).not.toBeNull();
    });

    it('should match asterisk as wildcard', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.PreToolUse,
        matcher: '*',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.PreToolUse, {
        toolName: 'bash',
      });

      expect(result).not.toBeNull();
    });

    it('should match tool name with exact string', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.PreToolUse,
        matcher: 'bash',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.PreToolUse, {
        toolName: 'bash',
      });

      expect(result).not.toBeNull();
    });

    it('should not match tool name with different exact string', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.PreToolUse,
        matcher: 'bash',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.PreToolUse, {
        toolName: 'glob',
      });

      expect(result).toBeNull();
    });

    it('should match tool name with regex', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.PreToolUse,
        matcher: '^bash.*',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.PreToolUse, {
        toolName: 'bash',
      });

      expect(result).not.toBeNull();
    });

    it('should match tool name with regex wildcard', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.PreToolUse,
        matcher: '.*',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.PreToolUse, {
        toolName: 'any-tool',
      });

      expect(result).not.toBeNull();
    });

    it('should match trigger with exact string', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.PreCompact,
        matcher: 'auto',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.PreCompact, {
        trigger: 'auto',
      });

      expect(result).not.toBeNull();
    });

    it('should not match trigger with different string', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.PreCompact,
        matcher: 'auto',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.PreCompact, {
        trigger: 'manual',
      });

      expect(result).toBeNull();
    });

    it('should match when context has both toolName and trigger (prefers toolName)', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.PreToolUse,
        matcher: 'bash',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.PreToolUse, {
        toolName: 'bash',
        trigger: 'api',
      });

      expect(result).not.toBeNull();
    });

    it('should match with trimmed matcher', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.PreToolUse,
        matcher: '  bash  ',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.PreToolUse, {
        toolName: 'bash',
      });

      expect(result).not.toBeNull();
    });

    it('should fallback to exact match when regex is invalid', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.PreToolUse,
        matcher: '[invalid(regex', // Invalid regex
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      // Should fallback to exact match - should NOT match 'bash'
      const result = planner.createExecutionPlan(HookEventName.PreToolUse, {
        toolName: 'bash',
      });

      expect(result).toBeNull();
    });

    it('should match using fallback exact match when regex is invalid', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.PreToolUse,
        matcher: '[invalid(regex', // Invalid regex
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      // Should fallback to exact match - should match '[invalid(regex'
      const result = planner.createExecutionPlan(HookEventName.PreToolUse, {
        toolName: '[invalid(regex',
      });

      expect(result).not.toBeNull();
    });

    it('should handle complex invalid regex gracefully', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.PreToolUse,
        matcher: '(unclosed',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.PreToolUse, {
        toolName: 'bash',
      });

      expect(result).toBeNull();
    });

    it('should match notification type with exact string', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.Notification,
        matcher: 'permission_prompt',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.Notification, {
        notificationType: 'permission_prompt',
      });

      expect(result).not.toBeNull();
    });

    it('should not match notification type with different string', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.Notification,
        matcher: 'permission_prompt',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.Notification, {
        notificationType: 'idle_prompt',
      });

      expect(result).toBeNull();
    });

    it('should match idle_prompt notification type', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.Notification,
        matcher: 'idle_prompt',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.Notification, {
        notificationType: 'idle_prompt',
      });

      expect(result).not.toBeNull();
    });

    it('should match auth_success notification type', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.Notification,
        matcher: 'auth_success',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.Notification, {
        notificationType: 'auth_success',
      });

      expect(result).not.toBeNull();
    });

    it('should match elicitation_dialog notification type', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.Notification,
        matcher: 'elicitation_dialog',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.Notification, {
        notificationType: 'elicitation_dialog',
      });

      expect(result).not.toBeNull();
    });

    it('should match all notification types when matcher is wildcard', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.Notification,
        matcher: '*',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.Notification, {
        notificationType: 'any_notification_type',
      });

      expect(result).not.toBeNull();
    });

    it('should match all notification types when matcher is empty', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.Notification,
        matcher: '',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.Notification, {
        notificationType: 'any_notification_type',
      });

      expect(result).not.toBeNull();
    });

    it('should match all notification types when no matcher provided', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.Notification,
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.Notification, {
        notificationType: 'any_notification_type',
      });

      expect(result).not.toBeNull();
    });

    it('should match all notification types when no context provided', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.Notification,
        matcher: 'permission_prompt',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.Notification);

      expect(result).not.toBeNull();
    });

    it('should match agent type with exact string for SubagentStart', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.SubagentStart,
        matcher: 'code-reviewer',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.SubagentStart, {
        agentType: 'code-reviewer',
      });

      expect(result).not.toBeNull();
    });

    it('should not match agent type with different string for SubagentStart', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.SubagentStart,
        matcher: 'code-reviewer',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.SubagentStart, {
        agentType: 'qwen-tester',
      });

      expect(result).toBeNull();
    });

    it('should match agent type with regex for SubagentStart', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.SubagentStart,
        matcher: '^code-.*',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.SubagentStart, {
        agentType: 'code-reviewer',
      });

      expect(result).not.toBeNull();
    });

    it('should match agent type with wildcard for SubagentStart', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.SubagentStart,
        matcher: '*',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.SubagentStart, {
        agentType: 'any-agent',
      });

      expect(result).not.toBeNull();
    });

    it('should match all agent types when no context for SubagentStart', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.SubagentStart,
        matcher: 'code-reviewer',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.SubagentStart);

      expect(result).not.toBeNull();
    });

    it('should match all agent types when no matcher for SubagentStart', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.SubagentStart,
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.SubagentStart, {
        agentType: 'any-agent',
      });

      expect(result).not.toBeNull();
    });

    it('should match agent type with exact string for SubagentStop', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.SubagentStop,
        matcher: 'qwen-tester',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.SubagentStop, {
        agentType: 'qwen-tester',
      });

      expect(result).not.toBeNull();
    });

    it('should not match agent type with different string for SubagentStop', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.SubagentStop,
        matcher: 'qwen-tester',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.SubagentStop, {
        agentType: 'code-reviewer',
      });

      expect(result).toBeNull();
    });

    it('should match agent type with regex for SubagentStop', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.SubagentStop,
        matcher: '.*tester$',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.SubagentStop, {
        agentType: 'qwen-tester',
      });

      expect(result).not.toBeNull();
    });

    it('should fallback to exact match when regex is invalid for SubagentStart', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.SubagentStart,
        matcher: '[invalid(regex',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.SubagentStart, {
        agentType: 'code-reviewer',
      });

      expect(result).toBeNull();
    });

    it('should match using fallback exact match when regex is invalid for SubagentStart', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.SubagentStart,
        matcher: '[invalid(regex',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.SubagentStart, {
        agentType: '[invalid(regex',
      });

      expect(result).not.toBeNull();
    });

    it('should match regex wildcard .* for SubagentStop', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.SubagentStop,
        matcher: '.*',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.SubagentStop, {
        agentType: 'any-agent-type',
      });

      expect(result).not.toBeNull();
    });

    // StopFailure matcher tests
    it('should match error type with exact string for StopFailure', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.StopFailure,
        matcher: 'rate_limit',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.StopFailure, {
        error: 'rate_limit',
      });

      expect(result).not.toBeNull();
    });

    it('should not match error type with different string for StopFailure', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.StopFailure,
        matcher: 'rate_limit',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.StopFailure, {
        error: 'authentication_failed',
      });

      expect(result).toBeNull();
    });

    it('should match all error types when no matcher for StopFailure', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.StopFailure,
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.StopFailure, {
        error: 'server_error',
      });

      expect(result).not.toBeNull();
    });

    it('should match all error types when matcher is wildcard for StopFailure', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.StopFailure,
        matcher: '*',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.StopFailure, {
        error: 'billing_error',
      });

      expect(result).not.toBeNull();
    });

    // PostCompact matcher tests
    it('should match trigger with exact string for PostCompact', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.PostCompact,
        matcher: 'manual',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.PostCompact, {
        trigger: 'manual',
      });

      expect(result).not.toBeNull();
    });

    it('should not match trigger with different string for PostCompact', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.PostCompact,
        matcher: 'manual',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.PostCompact, {
        trigger: 'auto',
      });

      expect(result).toBeNull();
    });

    it('should match all triggers when no matcher for PostCompact', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.PostCompact,
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.PostCompact, {
        trigger: 'auto',
      });

      expect(result).not.toBeNull();
    });

    it('should match all triggers when matcher is wildcard for PostCompact', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.PostCompact,
        matcher: '*',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.PostCompact, {
        trigger: 'manual',
      });

      expect(result).not.toBeNull();
    });

    it('should match auto trigger for PostCompact', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.PostCompact,
        matcher: 'auto',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.PostCompact, {
        trigger: 'auto',
      });

      expect(result).not.toBeNull();
    });
  });
});
