/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionHooksManager } from './sessionHooksManager.js';
import { HookEventName, HookType } from './types.js';
import type { CommandHookConfig, HttpHookConfig } from './types.js';

describe('SessionHooksManager', () => {
  let manager: SessionHooksManager;

  beforeEach(() => {
    manager = new SessionHooksManager();
  });

  /** Adds a function hook with a fresh `{ continue: true }` callback; session-1 PreToolUse by default. */
  const addHook = (
    matcher: string,
    {
      session = 'session-1',
      event = HookEventName.PreToolUse,
      error = 'Test error',
      options,
    }: {
      session?: string;
      event?: HookEventName;
      error?: string;
      options?: Parameters<SessionHooksManager['addFunctionHook']>[5];
    } = {},
  ) =>
    manager.addFunctionHook(
      session,
      event,
      matcher,
      vi.fn().mockResolvedValue({ continue: true }),
      error,
      options,
    );

  const hooksFor = (event: HookEventName) =>
    manager.getHooksForEvent('session-1', event);

  const matching = (tool: string) =>
    manager.getMatchingHooks('session-1', HookEventName.PreToolUse, tool);

  /** Adds a hook for `matcher`, then checks how many hooks match each tool. */
  const expectMatches = (matcher: string, counts: Record<string, number>) => {
    addHook(matcher);
    for (const [tool, count] of Object.entries(counts)) {
      expect(matching(tool).length).toBe(count);
    }
  };

  describe('session lifecycle', () => {
    it('reports empty queries and failed removal before registration', () => {
      expect(manager.hasSessionHooks('session-1')).toBe(false);
      expect(manager.getHookCount('session-1')).toBe(0);
      expect(hooksFor(HookEventName.PreToolUse)).toEqual([]);
      expect(manager.getAllSessionHooks('session-1')).toEqual([]);
      expect(
        manager.removeFunctionHook(
          'session-1',
          HookEventName.PreToolUse,
          'non-existent',
        ),
      ).toBe(false);
    });

    it('registers generated hooks, removes by event and preserves options', () => {
      const hookId = addHook('Bash', { error: 'Test error message' });
      expect(hookId).toBeDefined();
      expect(manager.hasSessionHooks('session-1')).toBe(true);
      expect(
        manager.removeFunctionHook(
          'session-1',
          HookEventName.PreToolUse,
          hookId,
        ),
      ).toBe(true);
      expect(manager.hasSessionHooks('session-1')).toBe(false);
      const configuredId = addHook('Bash', {
        error: 'Test error message',
        options: { timeout: 30000, name: 'My Hook', description: 'Test hook' },
      });
      expect(hooksFor(HookEventName.PreToolUse)).toMatchObject([
        {
          hookId: configuredId,
          matcher: 'Bash',
          config: {
            type: HookType.Function,
            name: 'My Hook',
            description: 'Test hook',
            timeout: 30000,
            errorMessage: 'Test error message',
          },
        },
      ]);
      expect(manager.removeHook('session-1', configuredId)).toBe(true);
      expect(manager.hasSessionHooks('session-1')).toBe(false);
    });

    it('queries custom hooks across events in fresh arrays and removes them by ID', () => {
      expect(addHook('Bash', { options: { id: 'custom-hook-id' } })).toBe(
        'custom-hook-id',
      );
      const hooks = manager.getAllSessionHooks('session-1');
      expect(hooks.map((hook) => hook.hookId)).toEqual(['custom-hook-id']);
      const copy = manager.getAllSessionHooks('session-1');
      expect(copy).not.toBe(hooks); // Different array references
      expect(copy).toEqual(hooks); // Same content
      addHook('Write', {
        event: HookEventName.PostToolUse,
        options: { id: 'post-hook-id' },
      });
      expect(manager.getHookCount('session-1')).toBe(2);
      expect(
        hooksFor(HookEventName.PreToolUse).map((hook) => hook.hookId),
      ).toEqual(['custom-hook-id']);
      expect(
        hooksFor(HookEventName.PostToolUse).map((hook) => hook.hookId),
      ).toEqual(['post-hook-id']);
      addHook('', {
        event: HookEventName.Stop,
        options: { id: 'stop-hook-id' },
      });
      const allHooks = manager.getAllSessionHooks('session-1');
      expect(
        allHooks.map((hook) => [hook.hookId, hook.eventName]).sort(),
      ).toEqual([
        ['custom-hook-id', HookEventName.PreToolUse],
        ['post-hook-id', HookEventName.PostToolUse],
        ['stop-hook-id', HookEventName.Stop],
      ]);
      expect(manager.removeHook('session-1', 'post-hook-id')).toBe(true);
      expect(hooksFor(HookEventName.PostToolUse)).toEqual([]);
      expect(manager.getHookCount('session-1')).toBe(2);
      expect(manager.removeHook('session-1', 'stop-hook-id')).toBe(true);
      expect(manager.removeHook('session-1', 'custom-hook-id')).toBe(true);
      expect(manager.hasSessionHooks('session-1')).toBe(false);
    });

    it('enumerates sessions and clears every event in only the selected session', () => {
      addHook('Bash');
      addHook('*', { event: HookEventName.PostToolUse });
      addHook('Bash', {
        session: 'session-2',
        options: { id: 'other-hook-id' },
      });
      expect(manager.getActiveSessions().sort()).toEqual([
        'session-1',
        'session-2',
      ]);
      manager.clearSessionHooks('session-1');
      expect(manager.hasSessionHooks('session-1')).toBe(false);
      expect(manager.hasSessionHooks('session-2')).toBe(true);
      expect(manager.getActiveSessions()).toEqual(['session-2']);
      expect(manager.getAllSessionHooks('session-1')).toEqual([]);
      expect(
        manager.getAllSessionHooks('session-2').map((hook) => hook.hookId),
      ).toEqual(['other-hook-id']);
    });
  });

  describe('addSessionHook', () => {
    const expectAdded = (
      matcher: string,
      hook: CommandHookConfig | HttpHookConfig,
    ) => {
      const hookId = manager.addSessionHook(
        'session-1',
        HookEventName.PostToolUse,
        matcher,
        hook,
      );

      expect(hookId).toBeDefined();
      const hooks = hooksFor(HookEventName.PostToolUse);
      expect(hooks.length).toBe(1);
      expect(hooks[0].config.type).toBe(hook.type);
    };

    it('should add a command hook', () => {
      expectAdded('*', {
        type: HookType.Command,
        command: 'echo "test"',
        name: 'Test Command',
      });
    });

    it('should add an HTTP hook', () => {
      expectAdded('Write', {
        type: HookType.Http,
        url: 'https://api.example.com/hook',
        name: 'Test HTTP',
      });
    });
  });

  describe('getMatchingHooks', () => {
    it.each<[string, string, Record<string, number>]>([
      ['should match exact tool name', 'Bash', { Bash: 1 }],
      ['should match wildcard *', '*', { AnyTool: 1 }],
      [
        'should match pipe-separated alternatives',
        'Write|Edit|Read',
        { Write: 1, Edit: 1, Read: 1, Delete: 0 },
      ],
      [
        'matches built-in tool display names against runtime tool ids',
        'WriteFile',
        { write_file: 1 },
      ],
      [
        'matches Claude Code tool names against runtime tool ids',
        'Bash|Write',
        { run_shell_command: 1, write_file: 1, monitor: 0 },
      ],
      [
        'matches pipe-separated display names against runtime tool ids',
        'WriteFile|Edit',
        { write_file: 1 },
      ],
      [
        'does not match regex against tool aliases',
        'Edit',
        { notebook_edit: 0 },
      ],
      [
        'does not let alias expansion bypass runtime id regex exclusions',
        '^(?!write_file).*$',
        { write_file: 0 },
      ],
      ['should not match different tool name', 'Bash', { Write: 0 }],
    ])('%s', (_title, matcher, counts) => expectMatches(matcher, counts));
  });

  describe('regex matcher support', () => {
    it.each<[string, string, Record<string, number>]>([
      [
        'should match using regex pattern',
        '^Bash.*',
        { Bash: 1, BashAction: 1, Write: 0 },
      ],
      // The anchors keep WriteOrEdit from matching.
      [
        'should match using regex with anchors',
        '^(Write|Edit)$',
        { Write: 1, Edit: 1, WriteOrEdit: 0 },
      ],
      [
        'matches an unanchored regex anywhere in the target, like settings hooks',
        'Bash.*',
        { RunBashCommand: 1 },
      ],
      [
        'matches every target with an empty matcher, as skill hooks without one are stored',
        '',
        { write_file: 1, run_shell_command: 1 },
      ],
      [
        'matches a tool id inside a longer id, so edit also covers notebook_edit',
        'edit',
        { notebook_edit: 1, write_file: 0 },
      ],
      [
        'keeps a wildcard list entry matching every tool',
        'write_file|*',
        { run_shell_command: 1 },
      ],
      // An invalid regex (unclosed bracket) falls back to exact match.
      [
        'should fallback to exact match for invalid regex',
        '[invalid',
        { '[invalid': 1, Bash: 0 },
      ],
    ])('%s', (_title, matcher, counts) => expectMatches(matcher, counts));
  });

  describe('skillRoot support', () => {
    it('should store skillRoot in hook entry', () => {
      addHook('Bash', { options: { skillRoot: '/path/to/skill' } });

      const hooks = matching('Bash');
      expect(hooks.length).toBe(1);
      expect(hooks[0].skillRoot).toBe('/path/to/skill');
    });

    it('should work without skillRoot', () => {
      addHook('Bash');

      const hooks = matching('Bash');
      expect(hooks.length).toBe(1);
      expect(hooks[0].skillRoot).toBeUndefined();
    });

    it('should filter hooks by skillRoot', () => {
      addHook('Bash', { error: 'Error 1', options: { skillRoot: '/skill-a' } });
      addHook('Bash', { error: 'Error 2', options: { skillRoot: '/skill-b' } });

      const hooks = matching('Bash');
      expect(hooks.length).toBe(2);
      expect(hooks[0].skillRoot).toBe('/skill-a');
      expect(hooks[1].skillRoot).toBe('/skill-b');
    });
  });

  describe('getAllSessionHooks', () => {
    it('should include session hooks with skillRoot', () => {
      addHook('Bash', { error: 'Error', options: { skillRoot: '/my-skill' } });

      const hooks = manager.getAllSessionHooks('session-1');

      expect(hooks).toHaveLength(1);
      expect(hooks[0].skillRoot).toBe('/my-skill');
    });
  });
});
