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

  describe('addFunctionHook', () => {
    it('should add a function hook and return hook ID', () => {
      const callback = vi.fn().mockResolvedValue({ continue: true });

      const hookId = manager.addFunctionHook(
        'session-1',
        HookEventName.PreToolUse,
        'Bash',
        callback,
        'Test error message',
      );

      expect(hookId).toBeDefined();
      expect(manager.hasSessionHooks('session-1')).toBe(true);
    });

    it('should use provided hook ID', () => {
      const callback = vi.fn().mockResolvedValue({ continue: true });

      const returnedHookId = manager.addFunctionHook(
        'session-1',
        HookEventName.PreToolUse,
        'Bash',
        callback,
        'Test error message',
        { id: 'custom-hook-id' },
      );

      expect(returnedHookId).toBe('custom-hook-id');
    });

    it('should add hook with options', () => {
      const callback = vi.fn().mockResolvedValue({ continue: true });

      manager.addFunctionHook(
        'session-1',
        HookEventName.PreToolUse,
        'Bash',
        callback,
        'Test error message',
        {
          timeout: 30000,
          name: 'My Hook',
          description: 'Test hook',
        },
      );

      const hooks = manager.getHooksForEvent(
        'session-1',
        HookEventName.PreToolUse,
      );
      expect(hooks.length).toBe(1);
      expect(hooks[0].config.name).toBe('My Hook');
    });
  });

  describe('addSessionHook', () => {
    it('should add a command hook', () => {
      const commandHook: CommandHookConfig = {
        type: HookType.Command,
        command: 'echo "test"',
        name: 'Test Command',
      };

      const hookId = manager.addSessionHook(
        'session-1',
        HookEventName.PostToolUse,
        '*',
        commandHook,
      );

      expect(hookId).toBeDefined();
      const hooks = manager.getHooksForEvent(
        'session-1',
        HookEventName.PostToolUse,
      );
      expect(hooks.length).toBe(1);
      expect(hooks[0].config.type).toBe(HookType.Command);
    });

    it('should add an HTTP hook', () => {
      const httpHook: HttpHookConfig = {
        type: HookType.Http,
        url: 'https://api.example.com/hook',
        name: 'Test HTTP',
      };

      const hookId = manager.addSessionHook(
        'session-1',
        HookEventName.PostToolUse,
        'Write',
        httpHook,
      );

      expect(hookId).toBeDefined();
      const hooks = manager.getHooksForEvent(
        'session-1',
        HookEventName.PostToolUse,
      );
      expect(hooks.length).toBe(1);
      expect(hooks[0].config.type).toBe(HookType.Http);
    });
  });

  describe('removeFunctionHook', () => {
    it('should remove hook by ID', () => {
      const callback = vi.fn().mockResolvedValue({ continue: true });

      const hookId = manager.addFunctionHook(
        'session-1',
        HookEventName.PreToolUse,
        'Bash',
        callback,
        'Test error',
      );

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
      const callback = vi.fn().mockResolvedValue({ continue: true });

      const hookId = manager.addFunctionHook(
        'session-1',
        HookEventName.PreToolUse,
        'Bash',
        callback,
        'Test error',
      );

      const removed = manager.removeHook('session-1', hookId);

      expect(removed).toBe(true);
      expect(manager.hasSessionHooks('session-1')).toBe(false);
    });
  });

  describe('getHooksForEvent', () => {
    it('should return hooks for specific event', () => {
      const callback = vi.fn().mockResolvedValue({ continue: true });

      manager.addFunctionHook(
        'session-1',
        HookEventName.PreToolUse,
        'Bash',
        callback,
        'Test error',
      );

      manager.addFunctionHook(
        'session-1',
        HookEventName.PostToolUse,
        '*',
        callback,
        'Test error',
      );

      const preToolHooks = manager.getHooksForEvent(
        'session-1',
        HookEventName.PreToolUse,
      );
      const postToolHooks = manager.getHooksForEvent(
        'session-1',
        HookEventName.PostToolUse,
      );

      expect(preToolHooks.length).toBe(1);
      expect(postToolHooks.length).toBe(1);
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
    it('should match exact tool name', () => {
      const callback = vi.fn().mockResolvedValue({ continue: true });

      manager.addFunctionHook(
        'session-1',
        HookEventName.PreToolUse,
        'Bash',
        callback,
        'Test error',
      );

      const matching = manager.getMatchingHooks(
        'session-1',
        HookEventName.PreToolUse,
        'Bash',
      );

      expect(matching.length).toBe(1);
    });

    it('should match wildcard *', () => {
      const callback = vi.fn().mockResolvedValue({ continue: true });

      manager.addFunctionHook(
        'session-1',
        HookEventName.PreToolUse,
        '*',
        callback,
        'Test error',
      );

      const matching = manager.getMatchingHooks(
        'session-1',
        HookEventName.PreToolUse,
        'AnyTool',
      );

      expect(matching.length).toBe(1);
    });

    it('should match pipe-separated alternatives', () => {
      const callback = vi.fn().mockResolvedValue({ continue: true });

      manager.addFunctionHook(
        'session-1',
        HookEventName.PreToolUse,
        'Write|Edit|Read',
        callback,
        'Test error',
      );

      expect(
        manager.getMatchingHooks('session-1', HookEventName.PreToolUse, 'Write')
          .length,
      ).toBe(1);
      expect(
        manager.getMatchingHooks('session-1', HookEventName.PreToolUse, 'Edit')
          .length,
      ).toBe(1);
      expect(
        manager.getMatchingHooks('session-1', HookEventName.PreToolUse, 'Read')
          .length,
      ).toBe(1);
      expect(
        manager.getMatchingHooks(
          'session-1',
          HookEventName.PreToolUse,
          'Delete',
        ).length,
      ).toBe(0);
    });

    it('should not match different tool name', () => {
      const callback = vi.fn().mockResolvedValue({ continue: true });

      manager.addFunctionHook(
        'session-1',
        HookEventName.PreToolUse,
        'Bash',
        callback,
        'Test error',
      );

      const matching = manager.getMatchingHooks(
        'session-1',
        HookEventName.PreToolUse,
        'Write',
      );

      expect(matching.length).toBe(0);
    });
  });

  describe('hasSessionHooks', () => {
    it('should return true when session has hooks', () => {
      const callback = vi.fn().mockResolvedValue({ continue: true });

      manager.addFunctionHook(
        'session-1',
        HookEventName.PreToolUse,
        'Bash',
        callback,
        'Test error',
      );

      expect(manager.hasSessionHooks('session-1')).toBe(true);
    });

    it('should return false when session has no hooks', () => {
      expect(manager.hasSessionHooks('session-1')).toBe(false);
    });

    it('should return false after all hooks removed', () => {
      const callback = vi.fn().mockResolvedValue({ continue: true });

      const hookId = manager.addFunctionHook(
        'session-1',
        HookEventName.PreToolUse,
        'Bash',
        callback,
        'Test error',
      );

      manager.removeHook('session-1', hookId);

      expect(manager.hasSessionHooks('session-1')).toBe(false);
    });
  });

  describe('clearSessionHooks', () => {
    it('should clear all hooks for a session', () => {
      const callback = vi.fn().mockResolvedValue({ continue: true });

      manager.addFunctionHook(
        'session-1',
        HookEventName.PreToolUse,
        'Bash',
        callback,
        'Test error',
      );

      manager.addFunctionHook(
        'session-1',
        HookEventName.PostToolUse,
        '*',
        callback,
        'Test error',
      );

      manager.clearSessionHooks('session-1');

      expect(manager.hasSessionHooks('session-1')).toBe(false);
    });

    it('should not affect other sessions', () => {
      const callback = vi.fn().mockResolvedValue({ continue: true });

      manager.addFunctionHook(
        'session-1',
        HookEventName.PreToolUse,
        'Bash',
        callback,
        'Test error',
      );

      manager.addFunctionHook(
        'session-2',
        HookEventName.PreToolUse,
        'Bash',
        callback,
        'Test error',
      );

      manager.clearSessionHooks('session-1');

      expect(manager.hasSessionHooks('session-1')).toBe(false);
      expect(manager.hasSessionHooks('session-2')).toBe(true);
    });
  });

  describe('getActiveSessions', () => {
    it('should return all session IDs with hooks', () => {
      const callback = vi.fn().mockResolvedValue({ continue: true });

      manager.addFunctionHook(
        'session-1',
        HookEventName.PreToolUse,
        'Bash',
        callback,
        'Test error',
      );

      manager.addFunctionHook(
        'session-2',
        HookEventName.PreToolUse,
        'Bash',
        callback,
        'Test error',
      );

      const sessions = manager.getActiveSessions();
      expect(sessions).toContain('session-1');
      expect(sessions).toContain('session-2');
    });
  });

  describe('getHookCount', () => {
    it('should return correct hook count', () => {
      const callback = vi.fn().mockResolvedValue({ continue: true });

      manager.addFunctionHook(
        'session-1',
        HookEventName.PreToolUse,
        'Bash',
        callback,
        'Test error',
      );

      manager.addFunctionHook(
        'session-1',
        HookEventName.PostToolUse,
        '*',
        callback,
        'Test error',
      );

      expect(manager.getHookCount('session-1')).toBe(2);
    });

    it('should return 0 for non-existent session', () => {
      expect(manager.getHookCount('non-existent')).toBe(0);
    });
  });
});
