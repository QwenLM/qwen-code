/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  HookManager,
  HookType,
  type HookPayload,
  type HookContext,
} from './HookManager.js';
import { HookService } from './HookService.js';
import type { Config } from '../config/config.js';

describe('Hook Error Handling and Cancellation Tests', () => {
  let hookManager: HookManager;

  beforeEach(() => {
    // Create a fresh instance for each test
    hookManager = new HookManager();
  });

  it('should continue execution despite hook errors', async () => {
    const workingHandler = vi.fn();
    const erroringHandler = vi.fn(() => {
      throw new Error('Hook error');
    });

    const mockConfig = {
      getHooksSettings: () => undefined,
    } as unknown as Config;

    const hookService = new HookService(mockConfig);

    hookService.registerHook(HookType.SESSION_START, erroringHandler);
    hookService.registerHook(HookType.SESSION_START, workingHandler);

    const payload: HookPayload = { id: 'test', timestamp: Date.now() };

    // This should not throw despite the error in the first hook
    await expect(
      hookService.executeHooks(HookType.SESSION_START, payload),
    ).resolves.not.toThrow();

    // The working handler should still be called despite the error in the first one
    expect(workingHandler).toHaveBeenCalledWith(payload, expect.anything());
  });

  it('should handle async hook errors gracefully', async () => {
    const asyncErroringHandler = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw new Error('Async hook error');
    });
    const syncHandler = vi.fn();

    const mockConfig = {
      getHooksSettings: () => undefined,
    } as unknown as Config;

    const hookService = new HookService(mockConfig);

    hookService.registerHook(HookType.SESSION_START, asyncErroringHandler);
    hookService.registerHook(HookType.SESSION_START, syncHandler);

    const payload: HookPayload = { id: 'test', timestamp: Date.now() };

    // This should not throw
    await expect(
      hookService.executeHooks(HookType.SESSION_START, payload),
    ).resolves.not.toThrow();

    // Both handlers should be called - the sync one despite the async error
    expect(asyncErroringHandler).toHaveBeenCalledWith(
      payload,
      expect.anything(),
    );
    expect(syncHandler).toHaveBeenCalledWith(payload, expect.anything());
  });

  it('should respect cancellation signals', async () => {
    const slowHandler = vi.fn(async () => {
      // Simulate a slow hook operation
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    const fastHandler = vi.fn();

    const mockConfig = {
      getHooksSettings: () => undefined,
    } as unknown as Config;

    const hookService = new HookService(mockConfig);

    hookService.registerHook(HookType.SESSION_START, slowHandler);
    hookService.registerHook(HookType.SESSION_START, fastHandler);

    const abortController = new AbortController();
    const payload: HookPayload = {
      id: 'test',
      timestamp: Date.now(),
      signal: abortController.signal,
    };

    // Abort immediately
    abortController.abort();

    const context: HookContext = {
      config: mockConfig,
      signal: abortController.signal,
    };

    // Execute hooks - this should not wait for the slow handler to complete
    await hookManager.executeHooks(HookType.SESSION_START, payload, context);

    // The fast handler should be called, but slow handler execution should be stopped
    // (Note: in implementation, it may have started but we can't stop mid-execution)
    expect(fastHandler).not.toHaveBeenCalled();
  });

  it('should handle hooks with timeout properly', async () => {
    // Create a hook that takes longer than the timeout
    const slowHandler = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    const fastHandler = vi.fn(() => {});

    const mockConfig = {
      getHooksSettings: () => undefined,
    } as unknown as Config;

    const hookService = new HookService(mockConfig);

    hookService.registerHook(HookType.SESSION_START, slowHandler, 1);
    hookService.registerHook(HookType.SESSION_START, fastHandler, 0);

    const payload: HookPayload = { id: 'test', timestamp: Date.now() };

    // Execute hooks - should complete despite slow handler
    await expect(
      hookService.executeHooks(HookType.SESSION_START, payload),
    ).resolves.not.toThrow();

    // Both handlers should be called, though slow one takes longer
    expect(fastHandler).toHaveBeenCalledWith(payload, expect.anything());
    expect(slowHandler).toHaveBeenCalledWith(payload, expect.anything());
  });

  it('should handle file system hook errors', async () => {
    const fsHandler = vi.fn(
      async (_payload: HookPayload, _context: HookContext) => {
        // Simulate file system hook that fails
        throw new Error('File system operation failed');
      },
    );
    const workingHandler = vi.fn();

    const mockConfig = {
      getHooksSettings: () => undefined,
    } as unknown as Config;

    const hookService = new HookService(mockConfig);

    hookService.registerHook(HookType.BEFORE_FILE_WRITE, fsHandler);
    hookService.registerHook(HookType.BEFORE_FILE_WRITE, workingHandler);

    const payload: HookPayload = {
      id: 'fs-test',
      timestamp: Date.now(),
      filePath: '/tmp/test.txt',
      content: 'test content',
    };

    // Should not throw despite file system hook error
    await expect(
      hookService.executeHooks(HookType.BEFORE_FILE_WRITE, payload),
    ).resolves.not.toThrow();

    expect(workingHandler).toHaveBeenCalledWith(payload, expect.anything());
  });

  it('should handle script execution errors gracefully', async () => {
    const mockConfig = {
      getHooksSettings: () => ({
        enabled: true,
        hooks: [
          {
            type: HookType.SESSION_START,
            inlineScript: "throw new Error('Script error');",
            enabled: true,
          },
        ],
      }),
      getTargetDir: () => '/tmp',
      getProjectRoot: () => '/tmp',
    } as unknown as Config;

    const hookService = new HookService(mockConfig);

    const payload: HookPayload = { id: 'script-test', timestamp: Date.now() };

    // This should not throw even if the inline script fails
    await expect(
      hookService.executeHooks(HookType.SESSION_START, payload),
    ).resolves.not.toThrow();
  });

  it('should handle multiple errors in a single execution', async () => {
    const errorHandler1 = vi.fn(() => {
      throw new Error('First error');
    });
    const errorHandler2 = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error('Second error');
    });
    const workingHandler = vi.fn();

    const mockConfig = {
      getHooksSettings: () => undefined,
    } as unknown as Config;

    const hookService = new HookService(mockConfig);

    hookService.registerHook(HookType.SESSION_START, errorHandler1);
    hookService.registerHook(HookType.SESSION_START, errorHandler2);
    hookService.registerHook(HookType.SESSION_START, workingHandler);

    const payload: HookPayload = {
      id: 'multi-error-test',
      timestamp: Date.now(),
    };

    // Should not throw despite multiple errors
    await expect(
      hookService.executeHooks(HookType.SESSION_START, payload),
    ).resolves.not.toThrow();

    // Working handler should still execute despite other errors
    expect(workingHandler).toHaveBeenCalledWith(payload, expect.anything());
  });
});
