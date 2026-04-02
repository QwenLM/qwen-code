/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AsyncHookRegistry, generateHookId } from './asyncHookRegistry.js';
import { HookEventName } from './types.js';

describe('AsyncHookRegistry', () => {
  let registry: AsyncHookRegistry;

  beforeEach(() => {
    registry = new AsyncHookRegistry();
  });

  describe('generateHookId', () => {
    it('should generate unique hook IDs', () => {
      const id1 = generateHookId();
      const id2 = generateHookId();
      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^hook_\d+_[a-z0-9]+$/);
    });
  });

  describe('register', () => {
    it('should register a new async hook', () => {
      const hookId = registry.register({
        hookId: 'test-hook-1',
        hookName: 'Test Hook',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-1',
        startTime: Date.now(),
        timeout: 60000,
        stdout: '',
        stderr: '',
      });

      expect(hookId).toBe('test-hook-1');
      expect(registry.hasRunningHooks()).toBe(true);
    });
  });

  describe('updateOutput', () => {
    it('should update stdout', () => {
      registry.register({
        hookId: 'test-hook-1',
        hookName: 'Test Hook',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-1',
        startTime: Date.now(),
        timeout: 60000,
        stdout: '',
        stderr: '',
      });

      registry.updateOutput('test-hook-1', 'stdout data', undefined);

      const pending = registry.getPendingHooks();
      expect(pending[0].stdout).toBe('stdout data');
    });

    it('should update stderr', () => {
      registry.register({
        hookId: 'test-hook-1',
        hookName: 'Test Hook',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-1',
        startTime: Date.now(),
        timeout: 60000,
        stdout: '',
        stderr: '',
      });

      registry.updateOutput('test-hook-1', undefined, 'stderr data');

      const pending = registry.getPendingHooks();
      expect(pending[0].stderr).toBe('stderr data');
    });
  });

  describe('complete', () => {
    it('should mark hook as completed and remove from pending', () => {
      registry.register({
        hookId: 'test-hook-1',
        hookName: 'Test Hook',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-1',
        startTime: Date.now(),
        timeout: 60000,
        stdout: '',
        stderr: '',
      });

      registry.complete('test-hook-1', { continue: true });

      expect(registry.hasRunningHooks()).toBe(false);
    });

    it('should process JSON output for system message', () => {
      registry.register({
        hookId: 'test-hook-1',
        hookName: 'Test Hook',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-1',
        startTime: Date.now(),
        timeout: 60000,
        stdout: '{"systemMessage": "Build completed"}',
        stderr: '',
      });

      registry.complete('test-hook-1');

      const output = registry.getPendingOutput();
      expect(output.messages.length).toBe(1);
      expect(output.messages[0].message).toBe('Build completed');
      expect(output.messages[0].type).toBe('system');
    });
  });

  describe('fail', () => {
    it('should mark hook as failed and add error message', () => {
      registry.register({
        hookId: 'test-hook-1',
        hookName: 'Test Hook',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-1',
        startTime: Date.now(),
        timeout: 60000,
        stdout: '',
        stderr: '',
      });

      registry.fail('test-hook-1', new Error('Hook failed'));

      expect(registry.hasRunningHooks()).toBe(false);
      const output = registry.getPendingOutput();
      expect(output.messages.length).toBe(1);
      expect(output.messages[0].type).toBe('error');
      expect(output.messages[0].message).toContain('Hook failed');
    });
  });

  describe('timeout', () => {
    it('should mark hook as timed out', () => {
      registry.register({
        hookId: 'test-hook-1',
        hookName: 'Test Hook',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-1',
        startTime: Date.now(),
        timeout: 1000,
        stdout: '',
        stderr: '',
      });

      registry.timeout('test-hook-1');

      expect(registry.hasRunningHooks()).toBe(false);
      const output = registry.getPendingOutput();
      expect(output.messages.length).toBe(1);
      expect(output.messages[0].type).toBe('warning');
      expect(output.messages[0].message).toContain('timed out');
    });
  });

  describe('getPendingHooks', () => {
    it('should return all pending hooks', () => {
      registry.register({
        hookId: 'test-hook-1',
        hookName: 'Hook 1',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-1',
        startTime: Date.now(),
        timeout: 60000,
        stdout: '',
        stderr: '',
      });

      registry.register({
        hookId: 'test-hook-2',
        hookName: 'Hook 2',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-1',
        startTime: Date.now(),
        timeout: 60000,
        stdout: '',
        stderr: '',
      });

      const pending = registry.getPendingHooks();
      expect(pending.length).toBe(2);
    });
  });

  describe('getPendingHooksForSession', () => {
    it('should return hooks for specific session', () => {
      registry.register({
        hookId: 'test-hook-1',
        hookName: 'Hook 1',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-1',
        startTime: Date.now(),
        timeout: 60000,
        stdout: '',
        stderr: '',
      });

      registry.register({
        hookId: 'test-hook-2',
        hookName: 'Hook 2',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-2',
        startTime: Date.now(),
        timeout: 60000,
        stdout: '',
        stderr: '',
      });

      const session1Hooks = registry.getPendingHooksForSession('session-1');
      expect(session1Hooks.length).toBe(1);
      expect(session1Hooks[0].hookId).toBe('test-hook-1');
    });
  });

  describe('getPendingOutput', () => {
    it('should return and clear pending output', () => {
      registry.register({
        hookId: 'test-hook-1',
        hookName: 'Test Hook',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-1',
        startTime: Date.now(),
        timeout: 60000,
        stdout: 'plain text output',
        stderr: '',
      });

      registry.complete('test-hook-1');

      const output1 = registry.getPendingOutput();
      expect(output1.messages.length).toBe(1);

      // Second call should return empty
      const output2 = registry.getPendingOutput();
      expect(output2.messages.length).toBe(0);
    });
  });

  describe('clearSession', () => {
    it('should clear all hooks for a session', () => {
      registry.register({
        hookId: 'test-hook-1',
        hookName: 'Hook 1',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-1',
        startTime: Date.now(),
        timeout: 60000,
        stdout: '',
        stderr: '',
      });

      registry.register({
        hookId: 'test-hook-2',
        hookName: 'Hook 2',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-2',
        startTime: Date.now(),
        timeout: 60000,
        stdout: '',
        stderr: '',
      });

      registry.clearSession('session-1');

      const pending = registry.getPendingHooks();
      expect(pending.length).toBe(1);
      expect(pending[0].sessionId).toBe('session-2');
    });
  });

  describe('checkTimeouts', () => {
    it('should timeout expired hooks', () => {
      const pastTime = Date.now() - 70000; // 70 seconds ago

      registry.register({
        hookId: 'test-hook-1',
        hookName: 'Test Hook',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-1',
        startTime: pastTime,
        timeout: 60000, // 60 second timeout
        stdout: '',
        stderr: '',
      });

      registry.checkTimeouts();

      expect(registry.hasRunningHooks()).toBe(false);
      expect(registry.hasPendingOutput()).toBe(true);
    });
  });
});
