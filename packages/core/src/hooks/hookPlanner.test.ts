/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HookRegistry, HookRegistryEntry } from './hookRegistry.js';
import {
  getHookMatcherTarget,
  getToolMatcherTargets,
  HookPlanner,
} from './hookPlanner.js';
import type { HookEventContext } from './hookPlanner.js';
import { HookEventName, HookType, HooksConfigSource } from './types.js';

const {
  InstructionsLoaded,
  MessageDisplay,
  Notification,
  PermissionDenied,
  PostCompact,
  PostToolBatch,
  PostToolUse,
  PreCompact,
  PreToolUse,
  SessionDelete,
  SessionStart,
  StopFailure,
  SubagentStart,
  SubagentStop,
  UserPromptExpansion,
  UserPromptSubmit,
} = HookEventName;

describe('HookPlanner', () => {
  let mockRegistry: HookRegistry;
  let planner: HookPlanner;

  beforeEach(() => {
    mockRegistry = {
      getHooksForEvent: vi.fn(),
    } as unknown as HookRegistry;
    planner = new HookPlanner(mockRegistry);
  });

  /** An enabled project `echo test` command hook; `fields` add or override. */
  const entry = (
    eventName: HookEventName,
    fields: Partial<HookRegistryEntry> = {},
  ): HookRegistryEntry => ({
    config: { type: HookType.Command, command: 'echo test' },
    source: HooksConfigSource.Project,
    eventName,
    enabled: true,
    ...fields,
  });

  const register = (...entries: HookRegistryEntry[]) =>
    vi.mocked(mockRegistry.getHooksForEvent).mockReturnValue(entries);

  // Registers one hook (with `matcher` only when given) and plans `context`.
  const planOne = (
    eventName: HookEventName,
    matcher?: string,
    context?: HookEventContext,
  ) => {
    register(entry(eventName, matcher === undefined ? {} : { matcher }));
    return planner.createExecutionPlan(eventName, context);
  };
  const expectMatch = (...args: Parameters<typeof planOne>) =>
    expect(planOne(...args)).not.toBeNull();
  const expectNoMatch = (...args: Parameters<typeof planOne>) =>
    expect(planOne(...args)).toBeNull();

  describe('getHookMatcherTarget', () => {
    it('returns tool name targets for tool events', () => {
      expect(getHookMatcherTarget(PreToolUse, { toolName: 'shell' })).toEqual({
        kind: 'toolName',
        target: 'shell',
      });
      expect(getHookMatcherTarget(PostToolUse)).toEqual({
        kind: 'toolName',
        target: '',
      });
      // PermissionDenied is permission-related, so it uses the same tool-name
      // matcher as PermissionRequest rather than a classifier-reason matcher.
      expect(
        getHookMatcherTarget(PermissionDenied, { toolName: 'Bash' }),
      ).toEqual({ kind: 'toolName', target: 'Bash' });
    });

    it('returns agent type targets for subagent events', () => {
      expect(
        getHookMatcherTarget(SubagentStart, { agentType: 'explorer' }),
      ).toEqual({ kind: 'agentType', target: 'explorer' });
    });

    it('returns trigger targets for compact events', () => {
      expect(getHookMatcherTarget(PreCompact, { trigger: 'manual' })).toEqual({
        kind: 'trigger',
        target: 'manual',
      });
    });

    it('returns session trigger targets for session events', () => {
      expect(
        getHookMatcherTarget(SessionStart, { trigger: 'startup' }),
      ).toEqual({ kind: 'sessionTrigger', target: 'startup' });
    });

    it('returns error targets for stop failure events', () => {
      expect(
        getHookMatcherTarget(StopFailure, { error: 'rate_limit' }),
      ).toEqual({ kind: 'error', target: 'rate_limit' });
    });

    it('returns notification type targets for notification events', () => {
      expect(
        getHookMatcherTarget(Notification, {
          notificationType: 'permission_prompt',
        }),
      ).toEqual({ kind: 'notificationType', target: 'permission_prompt' });
    });

    it('returns file path targets for instruction load events', () => {
      expect(
        getHookMatcherTarget(InstructionsLoaded, {
          filePath: '/repo/.qwen/QWEN.local.md',
        }),
      ).toEqual({ kind: 'filePath', target: '/repo/.qwen/QWEN.local.md' });
    });

    it('returns command name targets for user prompt expansion events', () => {
      expect(
        getHookMatcherTarget(UserPromptExpansion, { commandName: 'goal' }),
      ).toEqual({ kind: 'commandName', target: 'goal' });
    });

    it('returns undefined for events without matcher semantics', () => {
      expect(getHookMatcherTarget(UserPromptSubmit)).toBe(undefined);
      expect(getHookMatcherTarget(PostToolBatch)).toBe(undefined);
      expect(getHookMatcherTarget(SessionDelete)).toBe(undefined);
      expect(getHookMatcherTarget(MessageDisplay)).toBe(undefined);
    });
  });

  describe('createExecutionPlan', () => {
    it('should return null when no hooks for event', () => {
      register();
      expect(planner.createExecutionPlan(PreToolUse)).toBeNull();
    });

    it('should return null when no hooks match context', () => {
      expectNoMatch(PreToolUse, 'bash', { toolName: 'glob' });
    });

    it('should create plan with matching hooks', () => {
      register(
        entry(PreToolUse, {
          config: {
            type: HookType.Command,
            command: 'echo test',
            name: 'test-hook',
          },
        }),
      );

      const result = planner.createExecutionPlan(PreToolUse);

      expect(result).not.toBeNull();
      expect(result!.eventName).toBe(PreToolUse);
      expect(result!.hookConfigs).toHaveLength(1);
      expect(result!.sequential).toBe(false);
    });

    it('should set sequential to true when any hook has sequential=true', () => {
      register(entry(PreToolUse, { sequential: true }));
      expect(planner.createExecutionPlan(PreToolUse)!.sequential).toBe(true);
    });

    it('should deduplicate hooks with same config', () => {
      const config = { type: HookType.Command as const, command: 'echo test' };
      register(entry(PreToolUse, { config }), entry(PreToolUse, { config }));
      const result = planner.createExecutionPlan(PreToolUse);
      expect(result!.hookConfigs).toHaveLength(1);
    });

    it('should not deduplicate prompt hooks that only share the first 50 characters', () => {
      const sharedPrefix = 'a'.repeat(50);
      const [entry1, entry2] = ['first', 'second'].map((which) =>
        entry(UserPromptSubmit, {
          config: {
            type: HookType.Prompt,
            prompt: `${sharedPrefix}-${which} prompt`,
          },
        }),
      );
      register(entry1, entry2);

      const result = planner.createExecutionPlan(UserPromptSubmit);

      expect(result).not.toBeNull();
      expect(result!.hookConfigs).toHaveLength(2);
      expect(result!.hookConfigs).toEqual([entry1.config, entry2.config]);
    });

    it('matches user prompt expansion hooks by command name', () => {
      const hook = entry(UserPromptExpansion, { matcher: 'goal' });
      register(hook);
      const result = planner.createExecutionPlan(UserPromptExpansion, {
        commandName: 'goal',
      });
      expect(result).not.toBeNull();
      expect(result!.hookConfigs).toEqual([hook.config]);
    });

    it('matches user prompt expansion command names with invalid-regex fallback', () => {
      const hook = entry(UserPromptExpansion, { matcher: '[invalid(regex' });
      register(hook);
      const result = planner.createExecutionPlan(UserPromptExpansion, {
        commandName: '[invalid(regex',
      });
      expect(result).not.toBeNull();
      expect(result!.hookConfigs).toEqual([hook.config]);
    });
  });

  describe('matchesContext', () => {
    it('should match all when no matcher', () => {
      expectMatch(PreToolUse, undefined, { toolName: 'bash' });
    });

    it('should match all when no context', () => {
      expectMatch(PreToolUse, 'bash');
    });

    it('should match empty string as wildcard', () => {
      expectMatch(PreToolUse, '', { toolName: 'bash' });
    });

    it('should match asterisk as wildcard', () => {
      expectMatch(PreToolUse, '*', { toolName: 'bash' });
    });

    it('should match tool name with exact string', () => {
      expectMatch(PreToolUse, 'bash', { toolName: 'bash' });
    });

    it('matches built-in tool display names against runtime tool ids', () => {
      expectMatch(PreToolUse, 'WriteFile', {
        toolName: 'write_file',
      });
    });

    it('matches pipe-separated display names against runtime tool ids', () => {
      expectMatch(PreToolUse, 'WriteFile|Edit', {
        toolName: 'write_file',
      });
    });

    it('matches legacy tool aliases against runtime tool ids', () => {
      expectMatch(PreToolUse, 'SearchFiles', {
        toolName: 'grep_search',
      });
    });

    it('matches legacy runtime aliases against runtime tool ids', () => {
      expectMatch(PreToolUse, 'search_file_content', {
        toolName: 'grep_search',
      });
    });

    it.each([
      ['Bash', 'run_shell_command'],
      ['Read', 'read_file'],
      ['Write', 'write_file'],
      ['Write|Edit', 'write_file'],
    ])(
      'matches the Claude Code tool name %s against %s',
      (matcher, toolName) => {
        expectMatch(PreToolUse, matcher, { toolName });
      },
    );

    it.each([
      ['Read', 'grep_search'],
      ['Read', 'list_directory'],
      ['Edit', 'write_file'],
      ['Bash', 'monitor'],
    ])(
      'does not expand the Claude Code tool name %s to %s',
      (matcher, toolName) => {
        expectNoMatch(PreToolUse, matcher, { toolName });
      },
    );

    it('lists each tool matcher target once', () => {
      const targets = getToolMatcherTargets('run_shell_command');

      expect(targets).toEqual(
        expect.arrayContaining(['run_shell_command', 'Shell', 'Bash']),
      );
      expect(new Set(targets).size).toBe(targets.length);
    });

    it('does not match regex against tool aliases', () => {
      expectNoMatch(PreToolUse, 'Edit', { toolName: 'notebook_edit' });
    });

    it('does not let alias expansion bypass runtime id regex exclusions', () => {
      expectNoMatch(PreToolUse, '^(?!write_file).*$', {
        toolName: 'write_file',
      });
    });

    it('passes through unknown tool ids without aliases', () => {
      expect(getToolMatcherTargets('third_party__click')).toEqual([
        'third_party__click',
      ]);
    });

    it('should not match tool name with different exact string', () => {
      expectNoMatch(PreToolUse, 'bash', { toolName: 'glob' });
    });

    it('should match tool name with regex', () => {
      expectMatch(PreToolUse, '^bash.*', { toolName: 'bash' });
    });

    it('should match tool name with regex wildcard', () => {
      expectMatch(PreToolUse, '.*', { toolName: 'any-tool' });
    });

    it('should match trigger with exact string', () => {
      expectMatch(PreCompact, 'auto', { trigger: 'auto' });
    });

    it('should not match trigger with different string', () => {
      expectNoMatch(PreCompact, 'auto', { trigger: 'manual' });
    });

    it('should match when context has both toolName and trigger (prefers toolName)', () => {
      expectMatch(PreToolUse, 'bash', {
        toolName: 'bash',
        trigger: 'api',
      });
    });

    it('should match with trimmed matcher', () => {
      expectMatch(PreToolUse, '  bash  ', { toolName: 'bash' });
    });

    // Invalid regex falls back to exact match: 'bash' must NOT match...
    it('should fallback to exact match when regex is invalid', () => {
      expectNoMatch(PreToolUse, '[invalid(regex', {
        toolName: 'bash',
      });
    });

    // ...while the literal '[invalid(regex' must.
    it('should match using fallback exact match when regex is invalid', () => {
      expectMatch(PreToolUse, '[invalid(regex', {
        toolName: '[invalid(regex',
      });
    });

    it('should handle complex invalid regex gracefully', () => {
      expectNoMatch(PreToolUse, '(unclosed', { toolName: 'bash' });
    });

    it('should match notification type with exact string', () => {
      expectMatch(Notification, 'permission_prompt', {
        notificationType: 'permission_prompt',
      });
    });

    it('should not match notification type with different string', () => {
      expectNoMatch(Notification, 'permission_prompt', {
        notificationType: 'idle_prompt',
      });
    });

    it('should match idle_prompt notification type', () => {
      expectMatch(Notification, 'idle_prompt', {
        notificationType: 'idle_prompt',
      });
    });

    it('should match instruction loaded file paths with regex', () => {
      expectMatch(InstructionsLoaded, '\\.qwen/QWEN\\.local\\.md$', {
        filePath: '/repo/.qwen/QWEN.local.md',
      });
    });

    it('should not match unrelated instruction loaded file paths', () => {
      expectNoMatch(InstructionsLoaded, '\\.qwen/QWEN\\.local\\.md$', {
        filePath: '/repo/QWEN.md',
      });
    });

    it('should match auth_success notification type', () => {
      expectMatch(Notification, 'auth_success', {
        notificationType: 'auth_success',
      });
    });

    it('should match elicitation_dialog notification type', () => {
      expectMatch(Notification, 'elicitation_dialog', {
        notificationType: 'elicitation_dialog',
      });
    });

    it('should match all notification types when matcher is wildcard', () => {
      expectMatch(Notification, '*', {
        notificationType: 'any_notification_type',
      });
    });

    it('should match agent type with exact string for SubagentStart', () => {
      expectMatch(SubagentStart, 'code-reviewer', {
        agentType: 'code-reviewer',
      });
    });

    it('should not match agent type with different string for SubagentStart', () => {
      expectNoMatch(SubagentStart, 'code-reviewer', {
        agentType: 'qwen-tester',
      });
    });

    it('should match agent type with regex for SubagentStart', () => {
      expectMatch(SubagentStart, '^code-.*', {
        agentType: 'code-reviewer',
      });
    });

    it('should match agent type with wildcard for SubagentStart', () => {
      expectMatch(SubagentStart, '*', { agentType: 'any-agent' });
    });

    it('should match agent type with exact string for SubagentStop', () => {
      expectMatch(SubagentStop, 'qwen-tester', {
        agentType: 'qwen-tester',
      });
    });

    it('should not match agent type with different string for SubagentStop', () => {
      expectNoMatch(SubagentStop, 'qwen-tester', {
        agentType: 'code-reviewer',
      });
    });

    it('should match agent type with regex for SubagentStop', () => {
      expectMatch(SubagentStop, '.*tester$', {
        agentType: 'qwen-tester',
      });
    });

    it('should fallback to exact match when regex is invalid for SubagentStart', () => {
      expectNoMatch(SubagentStart, '[invalid(regex', {
        agentType: 'code-reviewer',
      });
    });

    it('should match using fallback exact match when regex is invalid for SubagentStart', () => {
      expectMatch(SubagentStart, '[invalid(regex', {
        agentType: '[invalid(regex',
      });
    });

    it('should match regex wildcard .* for SubagentStop', () => {
      expectMatch(SubagentStop, '.*', {
        agentType: 'any-agent-type',
      });
    });

    // StopFailure matcher tests
    it('should match error type with exact string for StopFailure', () => {
      expectMatch(StopFailure, 'rate_limit', {
        error: 'rate_limit',
      });
    });

    it('should not match error type with different string for StopFailure', () => {
      expectNoMatch(StopFailure, 'rate_limit', {
        error: 'authentication_failed',
      });
    });

    it('should match all error types when matcher is wildcard for StopFailure', () => {
      expectMatch(StopFailure, '*', { error: 'billing_error' });
    });

    it('matches a pipe-separated list of notification types', () => {
      register(
        entry(Notification, { matcher: 'permission_prompt|idle_prompt' }),
      );

      expect(
        planner.createExecutionPlan(Notification, {
          notificationType: 'idle_prompt',
        }),
      ).not.toBeNull();
      expect(
        planner.createExecutionPlan(Notification, {
          notificationType: 'auth_success',
        }),
      ).toBeNull();
    });

    it('matches notification types with a regex', () => {
      register(entry(Notification, { matcher: '^elicitation_' }));

      expect(
        planner.createExecutionPlan(Notification, {
          notificationType: 'elicitation_dialog',
        }),
      ).not.toBeNull();
      expect(
        planner.createExecutionPlan(Notification, {
          notificationType: 'idle_prompt',
        }),
      ).toBeNull();
    });

    it('matches a pipe-separated list of compact triggers', () => {
      expectMatch(PreCompact, 'manual|auto', { trigger: 'auto' });
    });

    it('matches a pipe-separated list of stop failure error types', () => {
      register(entry(StopFailure, { matcher: 'rate_limit|server_error' }));

      expect(
        planner.createExecutionPlan(StopFailure, { error: 'server_error' }),
      ).not.toBeNull();
      expect(
        planner.createExecutionPlan(StopFailure, { error: 'unknown' }),
      ).toBeNull();
    });

    // PostCompact matcher tests
    it('should match trigger with exact string for PostCompact', () => {
      expectMatch(PostCompact, 'manual', { trigger: 'manual' });
    });

    it('should not match trigger with different string for PostCompact', () => {
      expectNoMatch(PostCompact, 'manual', { trigger: 'auto' });
    });

    it('should match all triggers when matcher is wildcard for PostCompact', () => {
      expectMatch(PostCompact, '*', { trigger: 'manual' });
    });

    it('should match auto trigger for PostCompact', () => {
      expectMatch(PostCompact, 'auto', { trigger: 'auto' });
    });
  });
});

describe('agent hook ownership with a real registry', () => {
  it('filters before dedup and preserves exact session/agent identity through reload and dispose', async () => {
    const { HookRegistry } = await import('./hookRegistry.js');
    const registry = new HookRegistry({
      getProjectRoot: () => '/source',
      isTrustedFolder: () => true,
      getSystemHooks: () => ({}),
      getUserHooks: () => ({
        [HookEventName.PreToolUse]: [
          { hooks: [{ type: HookType.Command, command: 'global' }] },
        ],
      }),
      getProjectHooks: () => ({}),
      getExtensions: () => [],
    });
    await registry.initialize();
    const planner = new HookPlanner(registry);
    let trusted = true;
    const local = (description: string) => ({
      [HookEventName.PreToolUse]: [
        {
          matcher: 'Read',
          hooks: [
            {
              type: HookType.Command as const,
              command: 'same',
              name: 'same',
              description,
            },
          ],
        },
      ],
    });
    const disposeA = registry.addAgentHooks(local('A'), 'registration-A', {
      owner: { sessionId: 's1', agentId: 'A' },
      isSourceTrusted: () => trusted,
    });
    registry.addAgentHooks(local('B'), 'registration-B', {
      owner: { sessionId: 's1', agentId: 'B' },
    });
    const plan = (agentId: string | null, sessionId = 's1') =>
      planner
        .createExecutionPlan(
          HookEventName.PreToolUse,
          { toolName: 'read_file' },
          { runtimeId: 'runtime', sessionId, agentId },
        )
        ?.hookConfigs.map(
          (hook) =>
            hook.description ??
            (hook.type === HookType.Command ? hook.command : hook.type),
        );
    expect(plan(null)).toEqual(['global']);
    expect(plan('A')).toEqual(['global', 'A']);
    expect(plan('B')).toEqual(['global', 'B']);
    expect(plan('C')).toEqual(['global']);
    expect(plan('A', 's2')).toEqual(['global']);
    expect(
      planner.createExecutionPlan(HookEventName.PreToolUse)?.hookConfigs,
    ).toHaveLength(1);
    trusted = false;
    expect(plan('A')).toEqual(['global']);
    expect(plan('B')).toEqual(['global', 'B']);
    await registry.reloadConfiguredHooks();
    expect(plan('A')).toEqual(['global']);
    trusted = true;
    expect(plan('A')).toEqual(['global', 'A']);
    registry.addAgentHooks(local('resumed A'), 'registration-A-new', {
      owner: { sessionId: 's1', agentId: 'A' },
    });
    disposeA();
    disposeA();
    expect(plan('A')).toEqual(['global', 'resumed A']);
    expect(plan('B')).toEqual(['global', 'B']);
  });
});
