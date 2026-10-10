/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AsyncHookRegistry, generateHookId } from './asyncHookRegistry.js';
import { HookEventName } from './types.js';

type HookEntry = Parameters<AsyncHookRegistry['register']>[0];

/** A fresh PostToolUse hook in session-1; cases override what they vary. */
const entry = (overrides: Partial<HookEntry> = {}): HookEntry => ({
  hookId: 'test-hook-1',
  hookName: 'Test Hook',
  hookEvent: HookEventName.PostToolUse,
  sessionId: 'session-1',
  startTime: Date.now(),
  timeout: 60000,
  stdout: '',
  stderr: '',
  ...overrides,
});

/** Hook `test-hook-<n>` named `Hook <n>`. */
const hookN = (n: number, overrides: Partial<HookEntry> = {}) =>
  entry({ hookId: `test-hook-${n}`, hookName: `Hook ${n}`, ...overrides });

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
      const hookId = registry.register(entry());

      expect(hookId).toBe('test-hook-1');
      expect(registry.hasRunningHooks()).toBe(true);
    });
  });

  describe('updateOutput', () => {
    it('should update stdout', () => {
      registry.register(entry());

      registry.updateOutput('test-hook-1', 'stdout data', undefined);

      const pending = registry.getPendingHooks();
      expect(pending[0].stdout).toBe('stdout data');
    });

    it('should update stderr', () => {
      registry.register(entry());

      registry.updateOutput('test-hook-1', undefined, 'stderr data');

      const pending = registry.getPendingHooks();
      expect(pending[0].stderr).toBe('stderr data');
    });
  });

  describe('complete', () => {
    it('should mark hook as completed and remove from pending', () => {
      registry.register(entry());

      registry.complete('test-hook-1', { continue: true });

      expect(registry.hasRunningHooks()).toBe(false);
    });

    it('should process JSON output for system message', () => {
      registry.register(
        entry({ stdout: '{"systemMessage": "Build completed"}' }),
      );

      registry.complete('test-hook-1');

      const output = registry.getPendingOutput();
      expect(output.messages.length).toBe(1);
      expect(output.messages[0].message).toBe('Build completed');
      expect(output.messages[0].type).toBe('system');
    });
  });

  describe('fail', () => {
    it('should mark hook as failed and add error message', () => {
      registry.register(entry());

      registry.fail('test-hook-1', new Error('Hook failed'));

      expect(registry.hasRunningHooks()).toBe(false);
      const output = registry.getPendingOutput();
      expect(output.messages.length).toBe(1);
      expect(output.messages[0].type).toBe('error');
      expect(output.messages[0].message).toContain('Hook failed');
    });
  });

  describe('timeout', () => {
    /** Times out a hook that owns a mock child process, returned for checks. */
    const timeOutWithProcess = (killed: boolean) => {
      const mockProcess = { killed, kill: vi.fn(), once: vi.fn() };
      registry.register(
        entry({
          timeout: 1000,
          process:
            mockProcess as unknown as import('child_process').ChildProcess,
        }),
      );
      registry.timeout('test-hook-1');
      return mockProcess;
    };

    it('should mark hook as timed out', () => {
      registry.register(entry({ timeout: 1500 }));
      const [hook] = registry.getPendingHooks();

      registry.timeout('test-hook-1');

      expect(registry.hasRunningHooks()).toBe(false);
      // The registered timeout is in milliseconds; both messages report seconds.
      expect(hook?.error?.message).toBe('Hook timed out after 1.5s');
      const output = registry.getPendingOutput();
      expect(output.messages.length).toBe(1);
      expect(output.messages[0].type).toBe('warning');
      expect(output.messages[0].message).toBe(
        'Async hook Test Hook timed out after 1.5s',
      );
    });

    it('should terminate process on timeout', () => {
      const mockProcess = timeOutWithProcess(false);

      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mockProcess.once).toHaveBeenCalledWith(
        'exit',
        expect.any(Function),
      );
    });

    it('should not call kill if process is already killed', () => {
      expect(timeOutWithProcess(true).kill).not.toHaveBeenCalled();
    });
  });

  describe('getPendingHooks', () => {
    it('should return all pending hooks', () => {
      registry.register(hookN(1));
      registry.register(hookN(2));

      const pending = registry.getPendingHooks();
      expect(pending.length).toBe(2);
    });
  });

  describe('getPendingHooksForSession', () => {
    it('should return hooks for specific session', () => {
      registry.register(hookN(1));
      registry.register(hookN(2, { sessionId: 'session-2' }));

      const session1Hooks = registry.getPendingHooksForSession('session-1');
      expect(session1Hooks.length).toBe(1);
      expect(session1Hooks[0].hookId).toBe('test-hook-1');
    });
  });

  describe('getPendingOutput', () => {
    it('should return and clear pending output', () => {
      registry.register(entry({ stdout: 'plain text output' }));

      registry.complete('test-hook-1');

      const output1 = registry.getPendingOutput();
      expect(output1.messages.length).toBe(1);
      const output2 = registry.getPendingOutput();
      expect(output2.messages.length).toBe(0);
    });
  });

  describe('clearSession', () => {
    it('should clear all hooks for a session', () => {
      registry.register(hookN(1));
      registry.register(hookN(2, { sessionId: 'session-2' }));

      registry.clearSession('session-1');

      const pending = registry.getPendingHooks();
      expect(pending.length).toBe(1);
      expect(pending[0].sessionId).toBe('session-2');
    });
  });

  describe('checkTimeouts', () => {
    it('should timeout expired hooks', () => {
      // Started 70s ago with a 60s timeout.
      registry.register(entry({ startTime: Date.now() - 70000 }));

      registry.checkTimeouts();

      expect(registry.hasRunningHooks()).toBe(false);
      expect(registry.hasPendingOutput()).toBe(true);
    });
  });

  describe('concurrency limits', () => {
    it('should respect maxConcurrentHooks limit', () => {
      const limitedRegistry = new AsyncHookRegistry({ maxConcurrentHooks: 2 });

      expect(limitedRegistry.register(hookN(1))).toBe('test-hook-1');
      expect(limitedRegistry.register(hookN(2))).toBe('test-hook-2');
      expect(limitedRegistry.register(hookN(3))).toBeNull();
    });

    it('should allow registration after hook completes', () => {
      const limitedRegistry = new AsyncHookRegistry({ maxConcurrentHooks: 1 });

      limitedRegistry.register(hookN(1));
      expect(limitedRegistry.register(hookN(2))).toBeNull();

      limitedRegistry.complete('test-hook-1');

      expect(limitedRegistry.register(hookN(2))).toBe('test-hook-2');
    });

    it('should report correct running count', () => {
      const limitedRegistry = new AsyncHookRegistry({ maxConcurrentHooks: 5 });

      expect(limitedRegistry.getRunningCount()).toBe(0);
      expect(limitedRegistry.canAcceptMore()).toBe(true);

      limitedRegistry.register(hookN(1));

      expect(limitedRegistry.getRunningCount()).toBe(1);
      expect(limitedRegistry.canAcceptMore()).toBe(true);

      limitedRegistry.fail('test-hook-1', new Error('test'));

      expect(limitedRegistry.getRunningCount()).toBe(0);
    });
  });

  describe('auto timeout checker', () => {
    it('should start and stop timeout checker', () => {
      const autoRegistry = new AsyncHookRegistry({
        enableAutoTimeoutCheck: true,
        timeoutCheckInterval: 100,
      });
      autoRegistry.register(entry({ startTime: Date.now() - 70000 }));

      // Stop the checker before it can run, so it cannot interfere with other
      // tests: the expired hook is still there until checked by hand.
      autoRegistry.stopTimeoutChecker();
      expect(autoRegistry.hasRunningHooks()).toBe(true);

      autoRegistry.checkTimeouts();
      expect(autoRegistry.hasRunningHooks()).toBe(false);
    });

    it('should stop timeout checker on stopTimeoutChecker call', () => {
      const autoRegistry = new AsyncHookRegistry({
        enableAutoTimeoutCheck: true,
        timeoutCheckInterval: 50,
      });

      autoRegistry.stopTimeoutChecker();

      // A second stop is harmless.
      expect(() => autoRegistry.stopTimeoutChecker()).not.toThrow();
    });
  });
});
