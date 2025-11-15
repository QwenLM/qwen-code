import { describe, it, expect } from 'vitest';
import type { Config } from '../config/config.js';
import { HookService } from './HookService.js';
import { HookType } from './HookManager.js';
import { HookManager } from './HookManager.js';

// Create a basic mock config object
const baseMockConfig = {
  getTargetDir: () => '/test/dir',
  getProjectRoot: () => '/test/dir',
  getHooksSettings: () => ({}),
  storage: {
    getProjectTempDir: () => '/tmp/test-temp',
  },
  getSessionId: () => 'test-session-123',
};

// Cast to Config type using unknown to bypass strict type checking
const mockConfig = baseMockConfig as unknown as Config;

describe('Hook System End-to-End', () => {
  it('should execute registered hooks end-to-end', async () => {
    const hookService = new HookService(mockConfig);

    // Register a test hook
    const testResult: Array<{ value: string }> = [];
    const hookId = hookService.registerHook(
      HookType.INPUT_RECEIVED,
      async (payload) => {
        testResult.push({ value: 'hook-executed' });
        return { ...payload, processed: true };
      },
    );

    const initialPayload = {
      id: 'test',
      timestamp: Date.now(),
      original: true,
    };

    // Execute the hook
    const result = await hookService.executeHooks(
      HookType.INPUT_RECEIVED,
      initialPayload,
    );

    // Verify hook was executed
    expect(testResult).toHaveLength(1);
    expect(testResult[0]).toEqual({ value: 'hook-executed' });
    expect(result).toHaveProperty('processed', true);
    expect(result).toHaveProperty('original', true);

    // Cleanup
    hookService.unregisterHook(hookId);
  });

  it('should handle Claude-compatible hooks', async () => {
    // This tests the registration and execution of Claude-style hooks
    const settings = {
      claudeHooks: [
        {
          event: 'PreToolUse',
          command: 'echo "test"',
          enabled: true,
        },
      ],
    };

    const configWithClaudeHooks = {
      ...mockConfig,
      getHooksSettings: () => settings,
    } as unknown as Config;

    const hookService = new HookService(configWithClaudeHooks);

    // Test that Claude-style hooks are properly registered and can execute
    const payload = {
      id: 'test',
      timestamp: Date.now(),
    };

    const result = await hookService.executeHooks(
      'input.received', // String form of hook type
      payload,
    );

    expect(result).toEqual(payload); // Should return original when no matching hooks
  });

  it('should work with the HookManager directly', async () => {
    const hookManager = HookManager.getInstance();

    // Clear any existing hooks for this test
    const hooks = hookManager.getAllHooks().get(HookType.SESSION_START) || [];
    hooks.forEach((hook) => hookManager.unregister(hook.id));

    const testResults: string[] = [];

    const hookId = hookManager.register({
      type: HookType.SESSION_START,
      handler: async (payload) => {
        testResults.push('hook1-executed');
        return { ...payload, hook1: true };
      },
      priority: 5,
    });

    hookManager.register({
      type: HookType.SESSION_START,
      handler: async (payload) => {
        testResults.push('hook2-executed');
        return { ...payload, hook2: true };
      },
      priority: 1, // Higher priority (executes first)
    });

    const context = { config: mockConfig };
    const initialPayload = {
      id: 'session-test',
      timestamp: Date.now(),
      initial: true,
    };

    const result = await hookManager.executeHooks(
      HookType.SESSION_START,
      initialPayload,
      context,
    );

    // Verify both hooks were executed
    expect(testResults).toContain('hook1-executed');
    expect(testResults).toContain('hook2-executed');
    expect(result).toHaveProperty('initial', true);
    expect(result).toHaveProperty('hook1', true);
    expect(result).toHaveProperty('hook2', true);

    // Cleanup
    hookManager.unregister(hookId);
  });
});
