/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { HookType, type HookPayload } from './HookManager.js';
import type { Config } from '../config/config.js';
import { HookService } from './HookService.js';

describe('HookManager Integration Tests', () => {
  it('should execute hooks registered through HookService', async () => {
    const mockConfig = {
      getHooksSettings: () => ({
        enabled: true,
        claudeHooks: [],
        hooks: [],
      }),
    } as unknown as Config;

    const hookService = new HookService(mockConfig);
    const handler = vi.fn();

    // Register a hook using the HookService
    hookService.registerHook(HookType.SESSION_START, handler);

    const payload: HookPayload = { id: 'test', timestamp: Date.now() };

    // Execute hooks via HookService
    await hookService.executeHooks(HookType.SESSION_START, payload);

    expect(handler).toHaveBeenCalledWith(payload, expect.anything());
  });

  it('should execute multiple hook types in correct order', async () => {
    const executionOrder: string[] = [];

    const handler1 = vi.fn(() => {
      executionOrder.push('SESSION_START');
    });
    const handler2 = vi.fn(() => {
      executionOrder.push('INPUT_RECEIVED');
    });
    const handler3 = vi.fn(() => {
      executionOrder.push('TOOL_BEFORE');
    });

    const mockConfig = {
      getHooksSettings: () => ({
        enabled: true,
        claudeHooks: [],
        hooks: [],
      }),
    } as unknown as Config;

    const hookService = new HookService(mockConfig);

    hookService.registerHook(HookType.SESSION_START, handler1, 1);
    hookService.registerHook(HookType.INPUT_RECEIVED, handler2, 2);
    hookService.registerHook(HookType.BEFORE_TOOL_USE, handler3, 0);

    // Execute hooks in different sequences
    await hookService.executeHooks(HookType.BEFORE_TOOL_USE, {
      id: 'test1',
      timestamp: Date.now(),
    });
    await hookService.executeHooks(HookType.SESSION_START, {
      id: 'test2',
      timestamp: Date.now(),
    });
    await hookService.executeHooks(HookType.INPUT_RECEIVED, {
      id: 'test3',
      timestamp: Date.now(),
    });

    // Verify each handler was called
    expect(handler3).toHaveBeenCalled(); // BEFORE_TOOL_USE (priority 0)
    expect(handler1).toHaveBeenCalled(); // SESSION_START (priority 1)
    expect(handler2).toHaveBeenCalled(); // INPUT_RECEIVED (priority 2)
  });

  it('should properly integrate with application lifecycle', async () => {
    const startupHandler = vi.fn();
    const shutdownHandler = vi.fn();
    const sessionStartHandler = vi.fn();
    const sessionEndHandler = vi.fn();

    const mockConfig = {
      getHooksSettings: () => ({
        enabled: true,
        claudeHooks: [],
        hooks: [],
      }),
      getSessionId: () => 'test-session-id',
    } as unknown as Config;

    const hookService = new HookService(mockConfig);

    hookService.registerHook(HookType.APP_STARTUP, startupHandler);
    hookService.registerHook(HookType.APP_SHUTDOWN, shutdownHandler);
    hookService.registerHook(HookType.SESSION_START, sessionStartHandler);
    hookService.registerHook(HookType.SESSION_END, sessionEndHandler);

    // Simulate application lifecycle
    await hookService.executeHooks(HookType.APP_STARTUP, {
      id: 'startup-test',
      timestamp: Date.now(),
      version: 'test',
    });

    await hookService.executeHooks(HookType.SESSION_START, {
      id: 'session-start-test',
      timestamp: Date.now(),
      sessionId: 'test-session-id',
    });

    await hookService.executeHooks(HookType.SESSION_END, {
      id: 'session-end-test',
      timestamp: Date.now(),
      sessionId: 'test-session-id',
    });

    await hookService.executeHooks(HookType.APP_SHUTDOWN, {
      id: 'shutdown-test',
      timestamp: Date.now(),
      messages: [],
    });

    expect(startupHandler).toHaveBeenCalled();
    expect(sessionStartHandler).toHaveBeenCalled();
    expect(sessionEndHandler).toHaveBeenCalled();
    expect(shutdownHandler).toHaveBeenCalled();
  });

  it('should handle tool execution hooks integration', async () => {
    const beforeToolHandler = vi.fn();
    const afterToolHandler = vi.fn();

    const mockConfig = {
      getHooksSettings: () => ({
        enabled: true,
        claudeHooks: [],
        hooks: [],
      }),
    } as unknown as Config;

    const hookService = new HookService(mockConfig);

    hookService.registerHook(HookType.BEFORE_TOOL_USE, beforeToolHandler);
    hookService.registerHook(HookType.AFTER_TOOL_USE, afterToolHandler);

    // Simulate tool execution lifecycle
    const toolPayload = {
      id: 'tool-test',
      timestamp: Date.now(),
      subagentId: 'test-agent',
      subagentName: 'test-agent',
      toolName: 'test-tool',
      args: { file_path: 'test.txt' },
    };

    await hookService.executeHooks(HookType.BEFORE_TOOL_USE, toolPayload);
    await hookService.executeHooks(HookType.AFTER_TOOL_USE, {
      ...toolPayload,
      success: true,
      durationMs: 100,
      errorMessage: undefined,
    });

    expect(beforeToolHandler).toHaveBeenCalledWith(
      toolPayload,
      expect.anything(),
    );
    expect(afterToolHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        durationMs: 100,
      }),
      expect.anything(),
    );
  });

  it('should work with interactive mode hooks', async () => {
    const inputHandler = vi.fn();
    const beforeResponseHandler = vi.fn();
    const afterResponseHandler = vi.fn();

    const mockConfig = {
      getHooksSettings: () => ({
        enabled: true,
        claudeHooks: [],
        hooks: [],
      }),
    } as unknown as Config;

    const hookService = new HookService(mockConfig);

    hookService.registerHook(HookType.INPUT_RECEIVED, inputHandler);
    hookService.registerHook(HookType.BEFORE_RESPONSE, beforeResponseHandler);
    hookService.registerHook(HookType.AFTER_RESPONSE, afterResponseHandler);

    // Simulate interactive mode flow
    const inputValue = {
      id: 'input-test',
      timestamp: Date.now(),
      value: 'Hello World',
    };
    const queryValue = {
      id: 'response-test',
      timestamp: Date.now(),
      query: 'Hello World',
      promptId: 'test-prompt',
      isContinuation: false,
    };

    await hookService.executeHooks(HookType.INPUT_RECEIVED, inputValue);
    await hookService.executeHooks(HookType.BEFORE_RESPONSE, queryValue);
    await hookService.executeHooks(HookType.AFTER_RESPONSE, queryValue);

    expect(inputHandler).toHaveBeenCalledWith(inputValue, expect.anything());
    expect(beforeResponseHandler).toHaveBeenCalledWith(
      queryValue,
      expect.anything(),
    );
    expect(afterResponseHandler).toHaveBeenCalledWith(
      queryValue,
      expect.anything(),
    );
  });
});
