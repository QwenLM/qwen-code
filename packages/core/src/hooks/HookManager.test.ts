/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  HookManager,
  HookType,
  type HookPayload,
  type HookContext,
} from './HookManager.js';
import type { Config } from '../config/config.js';

// Create a minimal mock Config for testing purposes
const createMockConfig = (): Config => ({
    getTargetDir: () => '/tmp',
    getProjectRoot: () => '/tmp',
    getHooksSettings: () => undefined,
    // Add minimal required properties only to satisfy the Config interface
    getApprovalMode: () => undefined,
    getShowMemoryUsage: () => false,
    getDebugMode: () => false,
    getFullContext: () => false,
    getModel: () => 'test-model',
    getCwd: () => process.cwd(),
    getWorkingDir: () => process.cwd(),
    getCheckpointingEnabled: () => false,
    getUsageStatisticsEnabled: () => false,
    getEnablePromptCompletion: () => false,
    getSkipLoopDetection: () => false,
    getSkipStartupContext: () => false,
    getScreenReader: () => false,
    getEnableToolOutputTruncation: () => false,
    getTruncateToolOutputThreshold: () => Number.POSITIVE_INFINITY,
    getTruncateToolOutputLines: () => Number.POSITIVE_INFINITY,
    getUseSmartEdit: () => false,
    getOutputFormat: () => 'text',
    getIdeMode: () => false,
    getFolderTrustFeature: () => false,
    getFolderTrust: () => true,
    isTrustedFolder: () => true,
    getAuthType: () => undefined,
    getCliVersion: () => 'test',
    getFileSystemService: () =>
      undefined as import('../services/fileSystemService.js').FileSystemService,
    getChatCompression: () => undefined,
    isInteractive: () => false,
    getUseRipgrep: () => false,
    getUseBuiltinRipgrep: () => false,
    getShouldUseNodePtyShell: () => false,
    getSkipNextSpeakerCheck: () => false,
    getShellExecutionConfig: () => ({
      terminalWidth: 80,
      terminalHeight: 24,
      showColor: false,
      pager: 'cat',
    }),
    getVlmSwitchMode: () => undefined,
    getSubagentManager: () =>
      undefined as import('../subagents/subagent-manager.js').SubagentManager,
    // Note: This is a minimal mock, expand as needed to satisfy Config interface
  } as unknown as Config);

describe('HookManager', () => {
  let hookManager: HookManager;

  beforeEach(() => {
    // Create a fresh instance for each test
    hookManager = new HookManager();
  });

  it('should register a hook and return an ID', () => {
    const handler = vi.fn();
    const id = hookManager.register({
      type: HookType.SESSION_START,
      handler,
    });

    expect(id).toBeDefined();
    expect(id).toMatch(/^hook_\d+_\w{9}$/);
  });

  it('should execute registered hooks', async () => {
    const handler = vi.fn();
    const payload: HookPayload = {
      id: 'test',
      timestamp: Date.now(),
      data: 'test',
    };
    const context: HookContext = { config: createMockConfig() };

    hookManager.register({
      type: HookType.SESSION_START,
      handler,
    });

    await hookManager.executeHooks(HookType.SESSION_START, payload, context);

    expect(handler).toHaveBeenCalledWith(payload, context);
  });

  it('should execute multiple hooks in priority order', async () => {
    const executionOrder: number[] = [];

    const handler1 = vi.fn(() => {
      executionOrder.push(1);
    });
    const handler2 = vi.fn(() => {
      executionOrder.push(2);
    });
    const handler3 = vi.fn(() => {
      executionOrder.push(3);
    });

    // Register with different priorities (lower executes first)
    hookManager.register({
      type: HookType.SESSION_START,
      handler: handler2,
      priority: 10,
    });
    hookManager.register({
      type: HookType.SESSION_START,
      handler: handler1,
      priority: 5,
    });
    hookManager.register({
      type: HookType.SESSION_START,
      handler: handler3,
      priority: 15,
    });

    const payload: HookPayload = { id: 'test', timestamp: Date.now() };
    const context: HookContext = { config: createMockConfig() };

    await hookManager.executeHooks(HookType.SESSION_START, payload, context);

    expect(executionOrder).toEqual([1, 2, 3]); // Ordered by priority: 5, 10, 15
  });

  it('should not execute disabled hooks', async () => {
    const handler = vi.fn();
    const payload: HookPayload = { id: 'test', timestamp: Date.now() };
    const context: HookContext = { config: createMockConfig() };

    const hookId = hookManager.register({
      type: HookType.SESSION_START,
      handler,
      enabled: false,
    });

    await hookManager.executeHooks(HookType.SESSION_START, payload, context);

    expect(handler).not.toHaveBeenCalled();

    // Enable the hook and verify it executes
    hookManager.enable(hookId);
    await hookManager.executeHooks(HookType.SESSION_START, payload, context);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should allow unregistering hooks', async () => {
    const handler = vi.fn();
    const payload: HookPayload = { id: 'test', timestamp: Date.now() };
    const context: HookContext = { config: createMockConfig() };

    const hookId = hookManager.register({
      type: HookType.SESSION_START,
      handler,
    });

    await hookManager.executeHooks(HookType.SESSION_START, payload, context);
    expect(handler).toHaveBeenCalledTimes(1);

    const unregistered = hookManager.unregister(hookId);
    expect(unregistered).toBe(true);

    await hookManager.executeHooks(HookType.SESSION_START, payload, context);
    // Should still be 1 since the hook was unregistered
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should handle async hooks properly', async () => {
    const asyncHandler = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Promise.resolve();
    });
    const payload: HookPayload = { id: 'test', timestamp: Date.now() };
    const context: HookContext = { config: createMockConfig() };

    hookManager.register({
      type: HookType.SESSION_START,
      handler: asyncHandler,
    });

    await hookManager.executeHooks(HookType.SESSION_START, payload, context);

    expect(asyncHandler).toHaveBeenCalledWith(payload, context);
  });

  it('should continue execution despite hook errors', async () => {
    const workingHandler = vi.fn();
    const erroringHandler = vi.fn(() => {
      throw new Error('Hook error');
    });
    const payload: HookPayload = { id: 'test', timestamp: Date.now() };
    const context: HookContext = { config: createMockConfig() };

    hookManager.register({
      type: HookType.SESSION_START,
      handler: erroringHandler,
    });
    hookManager.register({
      type: HookType.SESSION_START,
      handler: workingHandler,
    });

    // This should not throw despite the error in the first hook
    await expect(
      hookManager.executeHooks(HookType.SESSION_START, payload, context),
    ).resolves.not.toThrow();

    // The working handler should still be called despite the error in the first one
    expect(workingHandler).toHaveBeenCalledWith(payload, context);
  });

  it('should respect cancellation signal', async () => {
    const handler = vi.fn();
    const abortController = new AbortController();
    const payload: HookPayload = { id: 'test', timestamp: Date.now() };
    const context: HookContext = {
      config: createMockConfig(),
      signal: abortController.signal,
    };

    hookManager.register({
      type: HookType.SESSION_START,
      handler,
    });

    // Immediately abort the signal
    abortController.abort();

    await hookManager.executeHooks(HookType.SESSION_START, payload, context);

    // The handler should not be called since the signal was already aborted
    expect(handler).not.toHaveBeenCalled();
  });

  it('should handle hooks with different types separately', async () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    const payload: HookPayload = { id: 'test', timestamp: Date.now() };
    const context: HookContext = { config: createMockConfig() };

    hookManager.register({
      type: HookType.SESSION_START,
      handler: handler1,
    });

    hookManager.register({
      type: HookType.SESSION_END,
      handler: handler2,
    });

    await hookManager.executeHooks(HookType.SESSION_START, payload, context);

    expect(handler1).toHaveBeenCalledWith(payload, context);
    expect(handler2).not.toHaveBeenCalled();
  });
});
