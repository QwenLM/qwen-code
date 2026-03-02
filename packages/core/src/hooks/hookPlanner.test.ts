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
      // PreToolUse hooks default to sequential execution to allow input modifications
      expect(result!.sequential).toBe(true);
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
      const config = { type: HookType.Command, command: 'echo test' };
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
        eventName: HookEventName.SessionStart,
        matcher: 'user',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.SessionStart, {
        trigger: 'user',
      });

      expect(result).not.toBeNull();
    });

    it('should not match trigger with different string', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.SessionStart,
        matcher: 'user',
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.SessionStart, {
        trigger: 'api',
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
  });

  describe('sequential execution behavior for different hook types', () => {
    const createEntry = (eventName: HookEventName) => ({
      config: { type: HookType.Command, command: 'echo test' } as const,
      source: HooksConfigSource.Project,
      eventName,
      enabled: true,
    });

    it('should set sequential=true for PreToolUse hooks', () => {
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([
        createEntry(HookEventName.PreToolUse),
      ]);

      const result = planner.createExecutionPlan(HookEventName.PreToolUse);

      expect(result!.sequential).toBe(true);
    });

    it('should set sequential=false for PostToolUse hooks', () => {
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([
        createEntry(HookEventName.PostToolUse),
      ]);

      const result = planner.createExecutionPlan(HookEventName.PostToolUse);

      expect(result!.sequential).toBe(false);
    });

    it('should set sequential=false for PostToolUseFailure hooks', () => {
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([
        createEntry(HookEventName.PostToolUseFailure),
      ]);

      const result = planner.createExecutionPlan(
        HookEventName.PostToolUseFailure,
      );

      expect(result!.sequential).toBe(false);
    });

    it('should set sequential=false for Notification hooks', () => {
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([
        createEntry(HookEventName.Notification),
      ]);

      const result = planner.createExecutionPlan(HookEventName.Notification);

      expect(result!.sequential).toBe(false);
    });

    it('should set sequential=false for SessionStart hooks', () => {
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([
        createEntry(HookEventName.SessionStart),
      ]);

      const result = planner.createExecutionPlan(HookEventName.SessionStart);

      expect(result!.sequential).toBe(false);
    });

    it('should set sequential=false for SessionEnd hooks', () => {
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([
        createEntry(HookEventName.SessionEnd),
      ]);

      const result = planner.createExecutionPlan(HookEventName.SessionEnd);

      expect(result!.sequential).toBe(false);
    });

    it('should set sequential=false for PreCompact hooks', () => {
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([
        createEntry(HookEventName.PreCompact),
      ]);

      const result = planner.createExecutionPlan(HookEventName.PreCompact);

      expect(result!.sequential).toBe(false);
    });

    it('should set sequential=false for SubagentStart hooks', () => {
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([
        createEntry(HookEventName.SubagentStart),
      ]);

      const result = planner.createExecutionPlan(HookEventName.SubagentStart);

      expect(result!.sequential).toBe(false);
    });

    it('should set sequential=false for SubagentStop hooks', () => {
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([
        createEntry(HookEventName.SubagentStop),
      ]);

      const result = planner.createExecutionPlan(HookEventName.SubagentStop);

      expect(result!.sequential).toBe(false);
    });

    it('should set sequential=false for PermissionRequest hooks', () => {
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([
        createEntry(HookEventName.PermissionRequest),
      ]);

      const result = planner.createExecutionPlan(
        HookEventName.PermissionRequest,
      );

      expect(result!.sequential).toBe(false);
    });

    it('should set sequential=false for UserPromptSubmit hooks', () => {
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([
        createEntry(HookEventName.UserPromptSubmit),
      ]);

      const result = planner.createExecutionPlan(
        HookEventName.UserPromptSubmit,
      );

      expect(result!.sequential).toBe(false);
    });

    it('should set sequential=false for Stop hooks', () => {
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([
        createEntry(HookEventName.Stop),
      ]);

      const result = planner.createExecutionPlan(HookEventName.Stop);

      expect(result!.sequential).toBe(false);
    });

    it('should override sequential=false with hook-level sequential=true', () => {
      const entry: HookRegistryEntry = {
        config: { type: HookType.Command, command: 'echo test' },
        source: HooksConfigSource.Project,
        eventName: HookEventName.SessionStart,
        sequential: true, // Override to sequential
        enabled: true,
      };
      vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue([entry]);

      const result = planner.createExecutionPlan(HookEventName.SessionStart);

      // Hook-level sequential=true should override the default
      expect(result!.sequential).toBe(true);
    });
  });
});
