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

  describe('addFunctionHook', () => {
    it('should add a function hook and return hook ID', () => {
      const hookId = addHook('Bash', { error: 'Test error message' });

      expect(hookId).toBeDefined();
      expect(manager.hasSessionHooks('session-1')).toBe(true);
    });

    it('should use provided hook ID', () => {
      const returnedHookId = addHook('Bash', {
        error: 'Test error message',
        options: { id: 'custom-hook-id' },
      });

      expect(returnedHookId).toBe('custom-hook-id');
    });

    it('should add hook with options', () => {
      addHook('Bash', {
        error: 'Test error message',
        options: { timeout: 30000, name: 'My Hook', description: 'Test hook' },
      });

      const hooks = hooksFor(HookEventName.PreToolUse);
      expect(hooks.length).toBe(1);
      expect(hooks[0].config.name).toBe('My Hook');
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

  describe('removeFunctionHook', () => {
    it('should remove hook by ID', () => {
      const hookId = addHook('Bash');

      const removed = manager.removeFunctionHook(
        'session-1',
        HookEventName.PreToolUse,
        hookId,
      );

      expect(removed).toBe(true);
      expect(manager.hasSessionHooks('session-1')).toBe(false);
    });

    it('should return false for non-existent hook', () => {
      const removed = manager.removeFunctionHook(
        'session-1',
        HookEventName.PreToolUse,
        'non-existent',
      );

      expect(removed).toBe(false);
    });
  });

  describe('removeHook', () => {
    it('should remove hook by ID across all events', () => {
      const removed = manager.removeHook('session-1', addHook('Bash'));

      expect(removed).toBe(true);
      expect(manager.hasSessionHooks('session-1')).toBe(false);
    });
  });

  describe('getHooksForEvent', () => {
    it('should return hooks for specific event', () => {
      addHook('Bash');
      addHook('*', { event: HookEventName.PostToolUse });

      expect(hooksFor(HookEventName.PreToolUse).length).toBe(1);
      expect(hooksFor(HookEventName.PostToolUse).length).toBe(1);
    });

    it('should return empty array for non-existent session', () => {
      const hooks = manager.getHooksForEvent(
        'non-existent',
        HookEventName.PreToolUse,
      );
      expect(hooks).toEqual([]);
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

  describe('hasSessionHooks', () => {
    it('should return true when session has hooks', () => {
      addHook('Bash');

      expect(manager.hasSessionHooks('session-1')).toBe(true);
    });

    it('should return false when session has no hooks', () => {
      expect(manager.hasSessionHooks('session-1')).toBe(false);
    });

    it('should return false after all hooks removed', () => {
      manager.removeHook('session-1', addHook('Bash'));

      expect(manager.hasSessionHooks('session-1')).toBe(false);
    });
  });

  describe('clearSessionHooks', () => {
    it('should clear all hooks for a session', () => {
      addHook('Bash');
      addHook('*', { event: HookEventName.PostToolUse });

      manager.clearSessionHooks('session-1');

      expect(manager.hasSessionHooks('session-1')).toBe(false);
    });

    it('should not affect other sessions', () => {
      addHook('Bash');
      addHook('Bash', { session: 'session-2' });

      manager.clearSessionHooks('session-1');

      expect(manager.hasSessionHooks('session-1')).toBe(false);
      expect(manager.hasSessionHooks('session-2')).toBe(true);
    });
  });

  describe('getActiveSessions', () => {
    it('should return all session IDs with hooks', () => {
      addHook('Bash');
      addHook('Bash', { session: 'session-2' });

      const sessions = manager.getActiveSessions();
      expect(sessions).toContain('session-1');
      expect(sessions).toContain('session-2');
    });
  });

  describe('getHookCount', () => {
    it('should return correct hook count', () => {
      addHook('Bash');
      addHook('*', { event: HookEventName.PostToolUse });

      expect(manager.getHookCount('session-1')).toBe(2);
    });

    it('should return 0 for non-existent session', () => {
      expect(manager.getHookCount('non-existent')).toBe(0);
    });
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
    it('should return empty array for non-existent session', () => {
      const hooks = manager.getAllSessionHooks('non-existent-session');
      expect(hooks).toEqual([]);
    });

    it('should return all hooks across all events', () => {
      addHook('Bash', { error: 'Error' });
      addHook('Write', { event: HookEventName.PostToolUse, error: 'Error' });
      addHook('', { event: HookEventName.Stop, error: 'Error' });

      const hooks = manager.getAllSessionHooks('session-1');

      expect(hooks).toHaveLength(3);
      expect(hooks.map((h) => h.eventName).sort()).toEqual([
        HookEventName.PostToolUse,
        HookEventName.PreToolUse,
        HookEventName.Stop,
      ]);
    });

    it('should include session hooks with skillRoot', () => {
      addHook('Bash', { error: 'Error', options: { skillRoot: '/my-skill' } });

      const hooks = manager.getAllSessionHooks('session-1');

      expect(hooks).toHaveLength(1);
      expect(hooks[0].skillRoot).toBe('/my-skill');
    });

    it('should return copy of hooks array', () => {
      addHook('Bash', { error: 'Error' });

      const hooks1 = manager.getAllSessionHooks('session-1');
      const hooks2 = manager.getAllSessionHooks('session-1');

      expect(hooks1).not.toBe(hooks2); // Different array references
      expect(hooks1).toEqual(hooks2); // Same content
    });
  });
});
