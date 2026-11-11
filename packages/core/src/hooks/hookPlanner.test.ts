/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { HookPlanner } from './hookPlanner.js';
import type { HookRegistry, HookRegistryEntry } from './hookRegistry.js';
import { ConfigSource, HookEventName, HookType } from './types.js';
import { initializeShellParsers } from '../utils/shell-utils.js';

// Mock runLogger using vi.hoisted
const mockRunLogger = vi.hoisted(() => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../utils/runLogger.js', () => ({
  runLogger: mockRunLogger,
}));

describe('HookPlanner', () => {
  let hookPlanner: HookPlanner;
  let mockHookRegistry: HookRegistry;

  beforeEach(() => {
    vi.resetAllMocks();

    mockHookRegistry = {
      getHooksForEvent: vi.fn(),
      getInlineSkillSessionHooksForEvent: vi.fn().mockReturnValue([]),
    } as unknown as HookRegistry;

    hookPlanner = new HookPlanner(mockHookRegistry);
  });

  describe('createExecutionPlan', () => {
    it.each(['external', 'command', 'async', 'session'])(
      'uses ordinary planning rules for ImagePrepare: %s',
      (kind) => {
        const entry: HookRegistryEntry = {
          config: { type: HookType.Runtime, internal: true, name: 'images', action: async () => {} },
          source: ConfigSource.System,
          eventName: HookEventName.ImagePrepare,
          enabled: true,
        };
        if (kind === 'external') entry.source = ConfigSource.User;
        if (kind === 'command') entry.config = { type: HookType.Command, command: 'echo' };
        if (kind === 'async') entry.async = true;
        if (kind === 'session') {
          entry.source = ConfigSource.User;
          vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue([]);
          vi.mocked(mockHookRegistry.getInlineSkillSessionHooksForEvent).mockReturnValue([entry]);
        } else {
          vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue([entry]);
        }
        const plan = hookPlanner.createExecutionPlan(HookEventName.ImagePrepare);
        expect(plan).not.toBeNull();
        expect(plan!.hookConfigs).toEqual(kind === 'async' ? [] : [entry.config]);
        expect(plan!.asyncHookConfigs).toEqual(kind === 'async' ? [entry.config] : []);
      },
    );

    it('should return empty plan when no hooks registered', () => {
      vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue([]);

      const plan = hookPlanner.createExecutionPlan(HookEventName.PreToolUse);

      expect(plan).toBeNull();
    });

    it('should create plan for hooks without matchers', () => {
      const mockEntries: HookRegistryEntry[] = [
        {
          config: { type: HookType.Command, command: './hook1.sh' },
          source: ConfigSource.Project,
          eventName: HookEventName.PreToolUse,
          enabled: true,
        },
        {
          config: {
            type: HookType.Command,
            command: './test-hook.sh',
          },
          source: ConfigSource.User,
          eventName: HookEventName.PreToolUse,
          enabled: true,
        },
      ];

      vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(mockEntries);

      const plan = hookPlanner.createExecutionPlan(HookEventName.PreToolUse);

      expect(plan).not.toBeNull();
      expect(plan!.hookConfigs).toHaveLength(2);
      expect(plan!.hookConfigs[0].command).toBe('./hook1.sh');
      expect(plan!.hookConfigs[1].command).toBe('./test-hook.sh');
    });

    it('should filter hooks by tool name matcher', () => {
      const mockEntries: HookRegistryEntry[] = [
        {
          config: { type: HookType.Command, command: './edit_hook.sh' },
          source: ConfigSource.Project,
          eventName: HookEventName.PreToolUse,
          matcher: 'EditTool',
          enabled: true,
        },
        {
          config: { type: HookType.Command, command: './general_hook.sh' },
          source: ConfigSource.Project,
          eventName: HookEventName.PreToolUse,
          enabled: true,
        },
      ];

      vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(mockEntries);

      // Test with EditTool context
      const plan = hookPlanner.createExecutionPlan(HookEventName.PreToolUse, {
        toolName: 'EditTool',
      });

      expect(plan).not.toBeNull();
      expect(plan!.hookConfigs).toHaveLength(2); // Both should match (one specific, one general)
    });

    it('should filter hooks by regex matcher', () => {
      const mockEntries: HookRegistryEntry[] = [
        {
          config: { type: HookType.Command, command: './edit_hook.sh' },
          source: ConfigSource.Project,
          eventName: HookEventName.PreToolUse,
          matcher: 'Edit|Write',
          enabled: true,
        },
        {
          config: { type: HookType.Command, command: './read_hook.sh' },
          source: ConfigSource.Project,
          eventName: HookEventName.PreToolUse,
          matcher: 'ReadTool',
          enabled: true,
        },
      ];

      vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(mockEntries);

      // Test with EditTool - should match first hook
      const editPlan = hookPlanner.createExecutionPlan(
        HookEventName.PreToolUse,
        { toolName: 'EditTool' },
      );
      expect(editPlan).not.toBeNull();
      expect(editPlan!.hookConfigs).toHaveLength(1);
      expect(editPlan!.hookConfigs[0].command).toBe('./edit_hook.sh');

      // Test with WriteTool - should match first hook
      const writePlan = hookPlanner.createExecutionPlan(
        HookEventName.PreToolUse,
        { toolName: 'WriteTool' },
      );
      expect(writePlan).not.toBeNull();
      expect(writePlan!.hookConfigs).toHaveLength(1);
      expect(writePlan!.hookConfigs[0].command).toBe('./edit_hook.sh');

      // Test with ReadTool - should match second hook
      const readPlan = hookPlanner.createExecutionPlan(
        HookEventName.PreToolUse,
        { toolName: 'ReadTool' },
      );
      expect(readPlan).not.toBeNull();
      expect(readPlan!.hookConfigs).toHaveLength(1);
      expect(readPlan!.hookConfigs[0].command).toBe('./read_hook.sh');

      // Test with unmatched tool - should match no hooks
      const otherPlan = hookPlanner.createExecutionPlan(
        HookEventName.PreToolUse,
        { toolName: 'OtherTool' },
      );
      expect(otherPlan).toBeNull();
    });

    it('should handle wildcard matcher', () => {
      const mockEntries: HookRegistryEntry[] = [
        {
          config: { type: HookType.Command, command: './wildcard_hook.sh' },
          source: ConfigSource.Project,
          eventName: HookEventName.PreToolUse,
          matcher: '*',
          enabled: true,
        },
      ];

      vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(mockEntries);

      const plan = hookPlanner.createExecutionPlan(HookEventName.PreToolUse, {
        toolName: 'AnyTool',
      });

      expect(plan).not.toBeNull();
      expect(plan!.hookConfigs).toHaveLength(1);
    });

    it('should handle empty string matcher', () => {
      const mockEntries: HookRegistryEntry[] = [
        {
          config: {
            type: HookType.Command,
            command: './empty_matcher_hook.sh',
          },
          source: ConfigSource.Project,
          eventName: HookEventName.PreToolUse,
          matcher: '',
          enabled: true,
        },
      ];

      vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(mockEntries);

      const plan = hookPlanner.createExecutionPlan(HookEventName.PreToolUse, {
        toolName: 'AnyTool',
      });

      expect(plan).not.toBeNull();
      expect(plan!.hookConfigs).toHaveLength(1);
    });

    it('should handle invalid regex matcher gracefully', () => {
      const mockEntries: HookRegistryEntry[] = [
        {
          config: {
            type: HookType.Command,
            command: './invalid_regex_hook.sh',
          },
          source: ConfigSource.Project,
          eventName: HookEventName.PreToolUse,
          matcher: '[invalid-regex',
          enabled: true,
        },
      ];

      vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(mockEntries);

      // Should match when toolName exactly equals the invalid regex pattern
      const plan = hookPlanner.createExecutionPlan(HookEventName.PreToolUse, {
        toolName: '[invalid-regex',
      });

      expect(plan).not.toBeNull();
      expect(plan!.hookConfigs).toHaveLength(1); // Should fall back to exact match

      // Should not match when toolName doesn't exactly equal the pattern
      const planNoMatch = hookPlanner.createExecutionPlan(
        HookEventName.PreToolUse,
        {
          toolName: 'other-tool',
        },
      );

      expect(planNoMatch).toBeNull();
    });

    it('should deduplicate identical hooks', () => {
      const mockEntries: HookRegistryEntry[] = [
        {
          config: { type: HookType.Command, command: './same_hook.sh' },
          source: ConfigSource.Project,
          eventName: HookEventName.PreToolUse,
          enabled: true,
        },
        {
          config: { type: HookType.Command, command: './same_hook.sh' },
          source: ConfigSource.User,
          eventName: HookEventName.PreToolUse,
          enabled: true,
        },
        {
          config: {
            type: HookType.Command,
            command: './test-hook.sh',
          },
          source: ConfigSource.Project,
          eventName: HookEventName.PreToolUse,
          enabled: true,
        },
        {
          config: {
            type: HookType.Command,
            command: './test-hook.sh',
          },
          source: ConfigSource.User,
          eventName: HookEventName.PreToolUse,
          enabled: true,
        },
      ];

      vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(mockEntries);

      const plan = hookPlanner.createExecutionPlan(HookEventName.PreToolUse);

      expect(plan).not.toBeNull();
      expect(plan!.hookConfigs).toHaveLength(2); // Should be deduplicated to 2 unique hooks
      expect(mockRunLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Deduplicated hook'),
      );
    });

    it('should deduplicate based on command, shell, and if (name is not identity)', () => {
      const mockEntries: HookRegistryEntry[] = [
        {
          config: {
            type: HookType.Command,
            command: './same.sh',
          },
          source: ConfigSource.Project,
          eventName: HookEventName.PreToolUse,
          enabled: true,
        },
        {
          config: {
            type: HookType.Command,
            command: './same.sh',
          },
          source: ConfigSource.User,
          eventName: HookEventName.PreToolUse,
          enabled: true,
        }, // Same command -> deduplicate
        {
          config: {
            type: HookType.Command,
            command: './same.sh',
          },
          source: ConfigSource.Project,
          eventName: HookEventName.PreToolUse,
          enabled: true,
        }, // Same command -> still deduplicate
        {
          config: {
            type: HookType.Command,
            command: './different.sh',
          },
          source: ConfigSource.Project,
          eventName: HookEventName.PreToolUse,
          enabled: true,
        }, // Different command -> distinct
        {
          config: { type: HookType.Command, command: './no-name.sh' },
          source: ConfigSource.Project,
          eventName: HookEventName.PreToolUse,
          enabled: true,
        },
        {
          config: { type: HookType.Command, command: './no-name.sh' },
          source: ConfigSource.User,
          eventName: HookEventName.PreToolUse,
          enabled: true,
        }, // Same command -> deduplicate
      ];

      vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(mockEntries);

      const plan = hookPlanner.createExecutionPlan(HookEventName.PreToolUse);

      expect(plan).not.toBeNull();
      // same.sh (3 entries deduped to 1), different.sh, no-name.sh (deduped)
      expect(plan!.hookConfigs).toHaveLength(3);
    });

    it('should deduplicate exec-form hooks with identical command and args', () => {
      const mockEntries: HookRegistryEntry[] = [
        {
          config: {
            type: HookType.Command,
            command: '/bin/echo',
            args: ['hi', 'there'],
          },
          source: ConfigSource.Project,
          eventName: HookEventName.PreToolUse,
          enabled: true,
        },
        {
          config: {
            type: HookType.Command,
            command: '/bin/echo',
            args: ['hi', 'there'],
          },
          source: ConfigSource.User,
          eventName: HookEventName.PreToolUse,
          enabled: true,
        },
      ];

      vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(mockEntries);
      const plan = hookPlanner.createExecutionPlan(HookEventName.PreToolUse);
      expect(plan).not.toBeNull();
      expect(plan!.hookConfigs).toHaveLength(1);
    });

    it('should NOT deduplicate exec-form hooks with same command but different args', () => {
      const mockEntries: HookRegistryEntry[] = [
        {
          config: {
            type: HookType.Command,
            command: '/bin/echo',
            args: ['a'],
          },
          source: ConfigSource.Project,
          eventName: HookEventName.PreToolUse,
          enabled: true,
        },
        {
          config: {
            type: HookType.Command,
            command: '/bin/echo',
            args: ['b'],
          },
          source: ConfigSource.Project,
          eventName: HookEventName.PreToolUse,
          enabled: true,
        },
      ];

      vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(mockEntries);
      const plan = hookPlanner.createExecutionPlan(HookEventName.PreToolUse);
      expect(plan).not.toBeNull();
      expect(plan!.hookConfigs).toHaveLength(2);
    });

    it('should ignore shell field when deduping exec-form hooks (shell normalized to exec)', () => {
      const mockEntries: HookRegistryEntry[] = [
        {
          config: {
            type: HookType.Command,
            command: '/bin/echo',
            args: ['x'],
            shell: 'bash',
          },
          source: ConfigSource.Project,
          eventName: HookEventName.PreToolUse,
          enabled: true,
        },
        {
          config: {
            type: HookType.Command,
            command: '/bin/echo',
            args: ['x'],
            shell: 'powershell',
          },
          source: ConfigSource.User,
          eventName: HookEventName.PreToolUse,
          enabled: true,
        },
      ];

      vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(mockEntries);
      const plan = hookPlanner.createExecutionPlan(HookEventName.PreToolUse);
      expect(plan).not.toBeNull();
      expect(plan!.hookConfigs).toHaveLength(1);
    });

    it('should NOT dedupe shell-form vs exec-form even with identical command', () => {
      const mockEntries: HookRegistryEntry[] = [
        {
          config: { type: HookType.Command, command: '/bin/echo' },
          source: ConfigSource.Project,
          eventName: HookEventName.PreToolUse,
          enabled: true,
        },
        {
          config: {
            type: HookType.Command,
            command: '/bin/echo',
            args: [],
          },
          source: ConfigSource.Project,
          eventName: HookEventName.PreToolUse,
          enabled: true,
        },
      ];

      vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(mockEntries);
      const plan = hookPlanner.createExecutionPlan(HookEventName.PreToolUse);
      expect(plan).not.toBeNull();
      expect(plan!.hookConfigs).toHaveLength(2);
    });

    describe('if field filtering', () => {
      it('should filter by if condition with tool name only', () => {
        const mockEntries: HookRegistryEntry[] = [
          {
            config: {
              type: HookType.Command,
              command: './hook.sh',
              if: 'Bash',
            },
            source: ConfigSource.Project,
            eventName: HookEventName.PreToolUse,
            enabled: true,
          },
        ];

        vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(
          mockEntries,
        );

        // Should match when toolName is Bash
        const plan = hookPlanner.createExecutionPlan(HookEventName.PreToolUse, {
          toolName: 'Bash',
        });
        expect(plan).not.toBeNull();
        expect(plan!.hookConfigs).toHaveLength(1);

        // Should not match when toolName is Edit
        const planNoMatch = hookPlanner.createExecutionPlan(
          HookEventName.PreToolUse,
          { toolName: 'Edit' },
        );
        expect(planNoMatch).toBeNull();
      });

      it('should filter by if condition with tool name and arg pattern', () => {
        const mockEntries: HookRegistryEntry[] = [
          {
            config: {
              type: HookType.Command,
              command: './hook.sh',
              if: 'Bash(git *)',
            },
            source: ConfigSource.Project,
            eventName: HookEventName.PreToolUse,
            enabled: true,
          },
        ];

        vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(
          mockEntries,
        );

        // Should match when toolName is Bash and command starts with "git "
        const plan = hookPlanner.createExecutionPlan(HookEventName.PreToolUse, {
          toolName: 'Bash',
          toolInput: { command: 'git push origin main' },
        });
        expect(plan).not.toBeNull();
        expect(plan!.hookConfigs).toHaveLength(1);

        // Should not match when command doesn't match pattern
        const planNoMatch = hookPlanner.createExecutionPlan(
          HookEventName.PreToolUse,
          { toolName: 'Bash', toolInput: { command: 'npm install' } },
        );
        expect(planNoMatch).toBeNull();
      });

      it('should filter by if condition with file path pattern', () => {
        const mockEntries: HookRegistryEntry[] = [
          {
            config: {
              type: HookType.Command,
              command: './hook.sh',
              if: 'Edit(*.ts)',
            },
            source: ConfigSource.Project,
            eventName: HookEventName.PreToolUse,
            enabled: true,
          },
        ];

        vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(
          mockEntries,
        );

        // Should match .ts file
        const plan = hookPlanner.createExecutionPlan(HookEventName.PreToolUse, {
          toolName: 'Edit',
          toolInput: { file_path: 'foo.ts' },
        });
        expect(plan).not.toBeNull();
        expect(plan!.hookConfigs).toHaveLength(1);

        // Should not match .js file
        const planNoMatch = hookPlanner.createExecutionPlan(
          HookEventName.PreToolUse,
          { toolName: 'Edit', toolInput: { file_path: 'foo.js' } },
        );
        expect(planNoMatch).toBeNull();
      });

      it('should not match if condition when tool name is wrong', () => {
        const mockEntries: HookRegistryEntry[] = [
          {
            config: {
              type: HookType.Command,
              command: './hook.sh',
              if: 'Bash(git *)',
            },
            source: ConfigSource.Project,
            eventName: HookEventName.PreToolUse,
            enabled: true,
          },
        ];

        vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(
          mockEntries,
        );

        // Wrong tool name, even though command matches pattern
        const plan = hookPlanner.createExecutionPlan(HookEventName.PreToolUse, {
          toolName: 'Edit',
          toolInput: { command: 'git push' },
        });
        expect(plan).toBeNull();
      });

      it('should always match hooks without if field', () => {
        const mockEntries: HookRegistryEntry[] = [
          {
            config: {
              type: HookType.Command,
              command: './no-if-hook.sh',
              // No if field
            },
            source: ConfigSource.Project,
            eventName: HookEventName.PreToolUse,
            enabled: true,
          },
          {
            config: {
              type: HookType.Command,
              command: './with-if-hook.sh',
              if: 'Bash',
            },
            source: ConfigSource.Project,
            eventName: HookEventName.PreToolUse,
            enabled: true,
          },
        ];

        vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(
          mockEntries,
        );

        // Hook without if should always match; hook with if: "Bash" should not match Edit
        const plan = hookPlanner.createExecutionPlan(HookEventName.PreToolUse, {
          toolName: 'Edit',
        });
        expect(plan).not.toBeNull();
        expect(plan!.hookConfigs).toHaveLength(1);
        expect(plan!.hookConfigs[0].command).toBe('./no-if-hook.sh');
      });

      it('should match on tool name alone when toolInput is missing', () => {
        const mockEntries: HookRegistryEntry[] = [
          {
            config: {
              type: HookType.Command,
              command: './hook.sh',
              if: 'Bash(git *)',
            },
            source: ConfigSource.Project,
            eventName: HookEventName.PreToolUse,
            enabled: true,
          },
        ];

        vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(
          mockEntries,
        );

        // toolInput is missing — arg pattern is skipped, matches on tool name alone
        const plan = hookPlanner.createExecutionPlan(HookEventName.PreToolUse, {
          toolName: 'Bash',
        });
        expect(plan).not.toBeNull();
        expect(plan!.hookConfigs).toHaveLength(1);
      });

      it('should not match when toolName is missing in context', () => {
        const mockEntries: HookRegistryEntry[] = [
          {
            config: {
              type: HookType.Command,
              command: './hook.sh',
              if: 'Bash',
            },
            source: ConfigSource.Project,
            eventName: HookEventName.PreToolUse,
            enabled: true,
          },
        ];

        vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(
          mockEntries,
        );

        // No toolName in context — if condition requires a tool name, so it fails
        const plan = hookPlanner.createExecutionPlan(HookEventName.PreToolUse, {
          trigger: 'some-trigger',
        });
        expect(plan).toBeNull();
      });

      it('should handle if condition with regex-like tool name', () => {
        const mockEntries: HookRegistryEntry[] = [
          {
            config: {
              type: HookType.Command,
              command: './hook.sh',
              if: 'Edit|Write',
            },
            source: ConfigSource.Project,
            eventName: HookEventName.PreToolUse,
            enabled: true,
          },
        ];

        vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(
          mockEntries,
        );

        // Should match Edit
        const editPlan = hookPlanner.createExecutionPlan(
          HookEventName.PreToolUse,
          { toolName: 'Edit' },
        );
        expect(editPlan).not.toBeNull();

        // Should match Write
        const writePlan = hookPlanner.createExecutionPlan(
          HookEventName.PreToolUse,
          { toolName: 'Write' },
        );
        expect(writePlan).not.toBeNull();

        // Should not match Read
        const readPlan = hookPlanner.createExecutionPlan(
          HookEventName.PreToolUse,
          { toolName: 'Read' },
        );
        expect(readPlan).toBeNull();
      });

      it('should handle if condition with ? wildcard in arg pattern', () => {
        const mockEntries: HookRegistryEntry[] = [
          {
            config: {
              type: HookType.Command,
              command: './hook.sh',
              if: 'Edit(?.ts)',
            },
            source: ConfigSource.Project,
            eventName: HookEventName.PreToolUse,
            enabled: true,
          },
        ];

        vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(
          mockEntries,
        );

        // Should match single-character prefix
        const plan = hookPlanner.createExecutionPlan(HookEventName.PreToolUse, {
          toolName: 'Edit',
          toolInput: { file_path: 'a.ts' },
        });
        expect(plan).not.toBeNull();

        // Should not match multi-character prefix
        const planNoMatch = hookPlanner.createExecutionPlan(
          HookEventName.PreToolUse,
          { toolName: 'Edit', toolInput: { file_path: 'ab.ts' } },
        );
        expect(planNoMatch).toBeNull();
      });

      it('should use priority order for extracting primary arg', () => {
        const mockEntries: HookRegistryEntry[] = [
          {
            config: {
              type: HookType.Command,
              command: './hook.sh',
              if: 'Bash(git *)',
            },
            source: ConfigSource.Project,
            eventName: HookEventName.PreToolUse,
            enabled: true,
          },
        ];

        vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(
          mockEntries,
        );

        // "command" has higher priority than "path"
        const plan = hookPlanner.createExecutionPlan(HookEventName.PreToolUse, {
          toolName: 'Bash',
          toolInput: {
            path: '/some/path',
            command: 'git status',
          },
        });
        expect(plan).not.toBeNull();
      });

      it('should work with prompt hook configs that have if field', () => {
        const mockEntries: HookRegistryEntry[] = [
          {
            config: {
              type: HookType.Prompt,
              prompt: 'Is this safe?',
              if: 'Bash',
            },
            source: ConfigSource.User,
            eventName: HookEventName.PreToolUse,
            enabled: true,
          },
        ];

        vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(
          mockEntries,
        );

        const plan = hookPlanner.createExecutionPlan(HookEventName.PreToolUse, {
          toolName: 'Bash',
        });
        expect(plan).not.toBeNull();
        expect(plan!.hookConfigs).toHaveLength(1);

        const planNoMatch = hookPlanner.createExecutionPlan(
          HookEventName.PreToolUse,
          { toolName: 'Edit' },
        );
        expect(planNoMatch).toBeNull();
      });

      it('should work with agent hook configs that have if field', () => {
        const mockEntries: HookRegistryEntry[] = [
          {
            config: {
              type: HookType.Agent,
              prompt: 'Evaluate this tool use',
              tools: ['Read'],
              if: 'Bash(rm *)',
            },
            source: ConfigSource.User,
            eventName: HookEventName.PreToolUse,
            enabled: true,
          },
        ];

        vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(
          mockEntries,
        );

        const plan = hookPlanner.createExecutionPlan(HookEventName.PreToolUse, {
          toolName: 'Bash',
          toolInput: { command: 'rm -rf /tmp/test' },
        });
        expect(plan).not.toBeNull();

        const planNoMatch = hookPlanner.createExecutionPlan(
          HookEventName.PreToolUse,
          { toolName: 'Bash', toolInput: { command: 'ls -la' } },
        );
        expect(planNoMatch).toBeNull();
      });
    });

    describe('if condition `:*` prefix syntax', () => {
      const makeEntry = (
        ifValue: string,
      ): HookRegistryEntry[] => [
        {
          config: {
            type: HookType.Command,
            command: './hook.sh',
            if: ifValue,
          },
          source: ConfigSource.Project,
          eventName: HookEventName.PreToolUse,
          enabled: true,
        },
      ];

      it('matches "Bash(git commit:*)" against `git commit -m "x"`', () => {
        vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(
          makeEntry('Bash(git commit:*)'),
        );
        const plan = hookPlanner.createExecutionPlan(
          HookEventName.PreToolUse,
          { toolName: 'Bash', toolInput: { command: 'git commit -m "x"' } },
        );
        expect(plan).not.toBeNull();
      });

      it('matches "Bash(git commit:*)" against bare `git commit`', () => {
        vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(
          makeEntry('Bash(git commit:*)'),
        );
        const plan = hookPlanner.createExecutionPlan(
          HookEventName.PreToolUse,
          { toolName: 'Bash', toolInput: { command: 'git commit' } },
        );
        expect(plan).not.toBeNull();
      });

      it('does NOT match "Bash(git commit:*)" against `git push`', () => {
        vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(
          makeEntry('Bash(git commit:*)'),
        );
        const plan = hookPlanner.createExecutionPlan(
          HookEventName.PreToolUse,
          { toolName: 'Bash', toolInput: { command: 'git push origin main' } },
        );
        expect(plan).toBeNull();
      });

      it('does NOT match "Bash(git commit:*)" against `vgit commit` (anchored)', () => {
        vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(
          makeEntry('Bash(git commit:*)'),
        );
        const plan = hookPlanner.createExecutionPlan(
          HookEventName.PreToolUse,
          { toolName: 'Bash', toolInput: { command: 'vgit commit' } },
        );
        expect(plan).toBeNull();
      });

      it('matches "Bash(git push:*)" against `git push origin main`', () => {
        vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(
          makeEntry('Bash(git push:*)'),
        );
        const plan = hookPlanner.createExecutionPlan(
          HookEventName.PreToolUse,
          { toolName: 'Bash', toolInput: { command: 'git push origin main' } },
        );
        expect(plan).not.toBeNull();
      });

      // Compound commands (e.g. "VAR=1 git push", "ls && git push") rely on
      // tree-sitter parsing in `parseBashCommandDetails`. Force-init the
      // parser before these assertions so the matcher walks each split
      // sub-command instead of falling back to raw whole-string matching.
      describe('compound command splitting via tree-sitter', () => {
        beforeAll(async () => {
          await initializeShellParsers();
        });

        it('matches `VAR=1 git push` against "Bash(git push:*)"', () => {
          vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(
            makeEntry('Bash(git push:*)'),
          );
          const plan = hookPlanner.createExecutionPlan(
            HookEventName.PreToolUse,
            { toolName: 'Bash', toolInput: { command: 'VAR=1 git push' } },
          );
          expect(plan).not.toBeNull();
          expect(plan!.hookConfigs).toHaveLength(1);
        });

        it('matches `ls && git push` against "Bash(git push:*)"', () => {
          vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(
            makeEntry('Bash(git push:*)'),
          );
          const plan = hookPlanner.createExecutionPlan(
            HookEventName.PreToolUse,
            { toolName: 'Bash', toolInput: { command: 'ls && git push' } },
          );
          expect(plan).not.toBeNull();
          expect(plan!.hookConfigs).toHaveLength(1);
        });
      });
    });

    describe('if condition wildcard semantics', () => {
      const makeEntry = (
        ifValue: string,
      ): HookRegistryEntry[] => [
        {
          config: {
            type: HookType.Command,
            command: './hook.sh',
            if: ifValue,
          },
          source: ConfigSource.Project,
          eventName: HookEventName.PreToolUse,
          enabled: true,
        },
      ];

      it('"Bash(\\*)" matches a literal asterisk command', () => {
        vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(
          makeEntry('Bash(\\*)'),
        );
        const plan = hookPlanner.createExecutionPlan(
          HookEventName.PreToolUse,
          { toolName: 'Bash', toolInput: { command: '*' } },
        );
        expect(plan).not.toBeNull();
      });

      it('"Bash(\\*)" does NOT match arbitrary text (escape suppresses wildcard)', () => {
        vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(
          makeEntry('Bash(\\*)'),
        );
        const plan = hookPlanner.createExecutionPlan(
          HookEventName.PreToolUse,
          { toolName: 'Bash', toolInput: { command: 'abc' } },
        );
        expect(plan).toBeNull();
      });

      it('"Bash(git *)" also matches bare `git` (single trailing wildcard tweak)', () => {
        vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(
          makeEntry('Bash(git *)'),
        );
        const plan = hookPlanner.createExecutionPlan(
          HookEventName.PreToolUse,
          { toolName: 'Bash', toolInput: { command: 'git' } },
        );
        expect(plan).not.toBeNull();
      });

      it('"Bash(* run *)" does NOT trim trailing wildcard (multi-wildcard pattern)', () => {
        // Two unescaped `*` → trailing-optional tweak should NOT apply.
        // `npm run` (no trailing arg) must NOT match.
        vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(
          makeEntry('Bash(* run *)'),
        );
        const plan = hookPlanner.createExecutionPlan(
          HookEventName.PreToolUse,
          { toolName: 'Bash', toolInput: { command: 'npm run' } },
        );
        expect(plan).toBeNull();
      });

      it('"Bash(* run *)" matches `npm run build`', () => {
        vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(
          makeEntry('Bash(* run *)'),
        );
        const plan = hookPlanner.createExecutionPlan(
          HookEventName.PreToolUse,
          { toolName: 'Bash', toolInput: { command: 'npm run build' } },
        );
        expect(plan).not.toBeNull();
      });
    });

    describe('asyncRewake gating by canConsumeRewake', () => {
      const rewakeEntry: HookRegistryEntry[] = [
        {
          config: {
            type: HookType.Command,
            command: './rewake.sh',
            asyncRewake: true,
          },
          source: ConfigSource.Project,
          eventName: HookEventName.PreToolUse,
          enabled: true,
        },
      ];

      it('routes asyncRewake to async bucket when canConsumeRewake=true (default)', () => {
        vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(
          rewakeEntry,
        );
        const plan = hookPlanner.createExecutionPlan(
          HookEventName.PreToolUse,
          { toolName: 'Bash' },
          // canConsumeRewake defaults to true
        );
        expect(plan).not.toBeNull();
        expect(plan!.asyncHookConfigs).toHaveLength(1);
        expect(plan!.hookConfigs).toHaveLength(0);
      });

      it('routes asyncRewake to async bucket when canConsumeRewake=true explicitly', () => {
        vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(
          rewakeEntry,
        );
        const plan = hookPlanner.createExecutionPlan(
          HookEventName.PreToolUse,
          { toolName: 'Bash' },
          true,
        );
        expect(plan).not.toBeNull();
        expect(plan!.asyncHookConfigs).toHaveLength(1);
        expect(plan!.hookConfigs).toHaveLength(0);
      });

      it('downgrades asyncRewake to sync bucket when canConsumeRewake=false', () => {
        vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(
          rewakeEntry,
        );
        const plan = hookPlanner.createExecutionPlan(
          HookEventName.PreToolUse,
          { toolName: 'Bash' },
          false,
        );
        expect(plan).not.toBeNull();
        expect(plan!.asyncHookConfigs).toHaveLength(0);
        expect(plan!.hookConfigs).toHaveLength(1);
      });

      it('downgrades asyncRewake even when definition-level async:true + canConsumeRewake=false', () => {
        const entryWithDefAsync: HookRegistryEntry[] = [
          {
            config: {
              type: HookType.Command,
              command: './rewake.sh',
              asyncRewake: true,
            },
            source: ConfigSource.Project,
            eventName: HookEventName.PreToolUse,
            enabled: true,
            async: true, // definition-level async
          },
        ];
        vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(
          entryWithDefAsync,
        );
        const plan = hookPlanner.createExecutionPlan(
          HookEventName.PreToolUse,
          { toolName: 'Bash' },
          false,
        );
        expect(plan).not.toBeNull();
        expect(plan!.asyncHookConfigs).toHaveLength(0);
        expect(plan!.hookConfigs).toHaveLength(1);
      });
    });

    it('should match trigger for session events', () => {
      const mockEntries: HookRegistryEntry[] = [
        {
          config: { type: HookType.Command, command: './startup_hook.sh' },
          source: ConfigSource.Project,
          eventName: HookEventName.SessionStart,
          matcher: 'startup',
          enabled: true,
        },
        {
          config: { type: HookType.Command, command: './resume_hook.sh' },
          source: ConfigSource.Project,
          eventName: HookEventName.SessionStart,
          matcher: 'resume',
          enabled: true,
        },
      ];

      vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(mockEntries);

      // Test startup trigger
      const startupPlan = hookPlanner.createExecutionPlan(
        HookEventName.SessionStart,
        { trigger: 'startup' },
      );
      expect(startupPlan).not.toBeNull();
      expect(startupPlan!.hookConfigs).toHaveLength(1);
      expect(startupPlan!.hookConfigs[0].command).toBe('./startup_hook.sh');

      // Test resume trigger
      const resumePlan = hookPlanner.createExecutionPlan(
        HookEventName.SessionStart,
        { trigger: 'resume' },
      );
      expect(resumePlan).not.toBeNull();
      expect(resumePlan!.hookConfigs).toHaveLength(1);
      expect(resumePlan!.hookConfigs[0].command).toBe('./resume_hook.sh');
    });

    it('should match pipe-separated trigger values', () => {
      const mockEntries: HookRegistryEntry[] = [
        {
          config: { type: HookType.Command, command: './multi_trigger.sh' },
          source: ConfigSource.Project,
          eventName: HookEventName.SessionStart,
          matcher: 'startup|resume',
          enabled: true,
        },
      ];

      vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(mockEntries);

      // Should match 'startup'
      const startupPlan = hookPlanner.createExecutionPlan(
        HookEventName.SessionStart,
        { trigger: 'startup' },
      );
      expect(startupPlan).not.toBeNull();
      expect(startupPlan!.hookConfigs).toHaveLength(1);

      // Should match 'resume'
      const resumePlan = hookPlanner.createExecutionPlan(
        HookEventName.SessionStart,
        { trigger: 'resume' },
      );
      expect(resumePlan).not.toBeNull();
      expect(resumePlan!.hookConfigs).toHaveLength(1);

      // Should NOT match 'other'
      const otherPlan = hookPlanner.createExecutionPlan(
        HookEventName.SessionStart,
        { trigger: 'other' },
      );
      expect(otherPlan).toBeNull();
    });

    it('should match regex trigger patterns', () => {
      const mockEntries: HookRegistryEntry[] = [
        {
          config: { type: HookType.Command, command: './regex_trigger.sh' },
          source: ConfigSource.Project,
          eventName: HookEventName.PreCompact,
          matcher: 'auto.*',
          enabled: true,
        },
      ];

      vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue(mockEntries);

      // Should match 'auto' (regex .* matches empty)
      const autoPlan = hookPlanner.createExecutionPlan(
        HookEventName.PreCompact,
        { trigger: 'auto' },
      );
      expect(autoPlan).not.toBeNull();

      // Should match 'auto_scheduled'
      const autoSchedPlan = hookPlanner.createExecutionPlan(
        HookEventName.PreCompact,
        { trigger: 'auto_scheduled' },
      );
      expect(autoSchedPlan).not.toBeNull();

      // Should NOT match 'manual'
      const manualPlan = hookPlanner.createExecutionPlan(
        HookEventName.PreCompact,
        { trigger: 'manual' },
      );
      expect(manualPlan).toBeNull();
    });

    it('should include inline skill session hooks when no agentId in context', () => {
      const skillHookEntry: HookRegistryEntry = {
        config: { type: HookType.Command, command: './skill-hook.sh' },
        source: ConfigSource.Runtime,
        eventName: HookEventName.PreToolUse,
        matcher: 'Bash',
        enabled: true,
      };

      vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue([]);
      vi.mocked(
        mockHookRegistry.getInlineSkillSessionHooksForEvent,
      ).mockReturnValue([skillHookEntry]);

      // No agentId — simulates main agent context
      const plan = hookPlanner.createExecutionPlan(HookEventName.PreToolUse, {
        toolName: 'Bash',
      });

      expect(plan).not.toBeNull();
      expect(plan!.hookConfigs).toHaveLength(1);
      expect(plan!.hookConfigs[0].command).toBe('./skill-hook.sh');
    });

    it('should not include inline skill hooks that do not match the tool', () => {
      const skillHookEntry: HookRegistryEntry = {
        config: { type: HookType.Command, command: './skill-hook.sh' },
        source: ConfigSource.Runtime,
        eventName: HookEventName.PreToolUse,
        matcher: 'Edit',
        enabled: true,
      };

      vi.mocked(mockHookRegistry.getHooksForEvent).mockReturnValue([]);
      vi.mocked(
        mockHookRegistry.getInlineSkillSessionHooksForEvent,
      ).mockReturnValue([skillHookEntry]);

      const plan = hookPlanner.createExecutionPlan(HookEventName.PreToolUse, {
        toolName: 'Bash',
      });

      expect(plan).toBeNull();
    });
  });
});
