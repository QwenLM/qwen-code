import { describe, it, expect, beforeEach } from 'vitest';
import {
  HookManager,
  HookType,
  type HookPayload,
  type HookContext,
  type HookFunction,
} from './HookManager.js';

// Mock Config interface for testing
const mockConfig = {} as HookContext['config'];

describe('HookManager', () => {
  let hookManager: HookManager;

  beforeEach(() => {
    hookManager = HookManager.getInstance();
    // Clear all hooks to start fresh for each test
    Object.values(HookType).forEach((hookType) => {
      const hooks = hookManager.getAllHooks().get(hookType as HookType) || [];
      [...hooks].forEach((hook) => hookManager.unregister(hook.id)); // Use spread to avoid modifying array during iteration
    });
  });

  describe('Registration and Execution', () => {
    it('should register hooks with correct priorities', () => {
      const mockHandler: HookFunction = async (_payload) => _payload;

      // Register hooks with different priorities
      const id1 = hookManager.register({
        type: HookType.INPUT_RECEIVED,
        handler: mockHandler,
        priority: 10,
      });

      const id2 = hookManager.register({
        type: HookType.INPUT_RECEIVED,
        handler: mockHandler,
        priority: 1,
      });

      const id3 = hookManager.register({
        type: HookType.INPUT_RECEIVED,
        handler: mockHandler,
        priority: 5,
      });

      const hooks =
        hookManager.getAllHooks().get(HookType.INPUT_RECEIVED) || [];
      expect(hooks[0].id).toBe(id2); // Lowest priority first
      expect(hooks[1].id).toBe(id3);
      expect(hooks[2].id).toBe(id1);
    });

    it('should execute hooks in priority order', async () => {
      const initialPayload: HookPayload = {
        id: 'test',
        timestamp: Date.now(),
        counter: 0,
      };

      const context: HookContext = { config: mockConfig };

      // Register hooks that increment counter
      hookManager.register({
        type: HookType.INPUT_RECEIVED,
        handler: async (payload: HookPayload) => ({
          ...payload,
          counter: (payload['counter'] as number) + 1,
        }),
        priority: 10,
      });

      hookManager.register({
        type: HookType.INPUT_RECEIVED,
        handler: async (payload: HookPayload) => ({
          ...payload,
          counter: (payload['counter'] as number) + 10,
        }),
        priority: 1,
      });

      const result = await hookManager.executeHooks(
        HookType.INPUT_RECEIVED,
        initialPayload,
        context,
      );

      // Should execute lower priority (1) first, then higher priority (10)
      // So: 0 + 10 = 10, then 10 + 1 = 11
      expect(result['counter']).toBe(11);
    });

    it('should handle hook execution errors gracefully', async () => {
      const initialPayload: HookPayload = {
        id: 'test',
        timestamp: Date.now(),
        data: 'initial',
      };

      const context: HookContext = { config: mockConfig };

      // Register a hook that throws an error
      hookManager.register({
        type: HookType.INPUT_RECEIVED,
        handler: async (_payload) => {
          throw new Error('Test error');
        },
      });

      // Register a hook that should still execute
      hookManager.register({
        type: HookType.INPUT_RECEIVED,
        handler: async (payload) => ({ ...payload, data: 'modified' }),
      });

      const result = await hookManager.executeHooks(
        HookType.INPUT_RECEIVED,
        initialPayload,
        context,
      );

      // The second hook should still execute despite the first failing
      expect(result['data']).toBe('modified');
    });
  });

  describe('Management', () => {
    it('should enable/disable hooks by ID', () => {
      // Create a fresh HookManager instance for this test to avoid conflicts with other tests
      const freshHookManager = new HookManager();

      const mockHandler: HookFunction = async (_payload) => _payload;

      const hookId = freshHookManager.register({
        type: HookType.INPUT_RECEIVED,
        handler: mockHandler,
      });

      // Initially should be enabled
      expect(
        freshHookManager.getAllHooks().get(HookType.INPUT_RECEIVED)?.[0]
          .enabled,
      ).toBe(true);

      // Disable the hook
      const disableResult = freshHookManager.disable(hookId);
      expect(disableResult).toBe(true);
      expect(
        freshHookManager.getAllHooks().get(HookType.INPUT_RECEIVED)?.[0]
          .enabled,
      ).toBe(false);

      // Enable the hook again
      const enableResult = freshHookManager.enable(hookId);
      expect(enableResult).toBe(true);
      expect(
        freshHookManager.getAllHooks().get(HookType.INPUT_RECEIVED)?.[0]
          .enabled,
      ).toBe(true);
    });

    it('should unregister hooks by ID', () => {
      // Create a fresh HookManager instance for this test to avoid conflicts with other tests
      const freshHookManager = new HookManager();

      const mockHandler: HookFunction = async (_payload) => _payload;

      const hookId = freshHookManager.register({
        type: HookType.INPUT_RECEIVED,
        handler: mockHandler,
      });

      // Verify hook exists
      expect(
        freshHookManager.getAllHooks().get(HookType.INPUT_RECEIVED)?.length,
      ).toBe(1);

      // Unregister the hook
      const unregisterResult = freshHookManager.unregister(hookId);
      expect(unregisterResult).toBe(true);
      expect(
        freshHookManager.getAllHooks().get(HookType.INPUT_RECEIVED)?.length,
      ).toBe(0);
    });
  });
});
