/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { HookEventHandler, createHookEventHandler } from './eventHandler.js';
import { HookEventName, HookType, DefaultHookOutput } from './types.js';
import { HookPlanner } from './planner.js';
import { HookRegistry } from './registry.js';

describe('HookEventHandler', () => {
  // Helper to create mock runHook function
  const createMockRunHook =
    (outputs: Map<string, import('./types.js').HookOutput> = new Map()) =>
    async (config: unknown, _input: import('./types.js').HookInput) => {
      const cmdConfig = config as { command?: string };
      const output =
        outputs.get(cmdConfig.command ?? '') ?? new DefaultHookOutput();
      return {
        hookConfig: config as import('./types.js').HookConfig,
        eventName: HookEventName.PreToolUse,
        success: true,
        output,
        stdout: '',
        stderr: '',
        exitCode: 0,
        duration: 100,
      };
    };

  describe('handle', () => {
    it('should handle hook execution request', async () => {
      const registry = new HookRegistry();
      registry.register({
        matcher: 'WriteFile',
        hooks: [{ type: HookType.Command, command: 'test-hook' }],
      });

      const handler = new HookEventHandler({
        registry,
        planner: new HookPlanner(),
        runHook: createMockRunHook(),
      });

      const response = await handler.handle({
        context: {
          eventName: HookEventName.PreToolUse,
          sessionId: 'test-session',
          cwd: '/test',
          transcriptPath: '/test/transcript',
          timestamp: new Date().toISOString(),
        },
        input: {
          session_id: 'test-session',
          transcript_path: '/test/transcript',
          cwd: '/test',
          hook_event_name: 'PreToolUse',
          timestamp: new Date().toISOString(),
        },
        toolName: 'WriteFile',
      });

      expect(response.success).toBe(true);
      expect(response.results).toHaveLength(1);
    });

    it('should return empty response when no matching hooks', async () => {
      const registry = new HookRegistry();
      const handler = new HookEventHandler({
        registry,
        planner: new HookPlanner(),
        runHook: createMockRunHook(),
      });

      const response = await handler.handle({
        context: {
          eventName: HookEventName.PreToolUse,
          sessionId: 'test-session',
          cwd: '/test',
          transcriptPath: '/test/transcript',
          timestamp: new Date().toISOString(),
        },
        input: {
          session_id: 'test-session',
          transcript_path: '/test/transcript',
          cwd: '/test',
          hook_event_name: 'PreToolUse',
          timestamp: new Date().toISOString(),
        },
        toolName: 'WriteFile',
      });

      expect(response.success).toBe(true);
      expect(response.results).toHaveLength(0);
    });

    it('should handle sequential execution', async () => {
      const registry = new HookRegistry();
      registry.register({
        matcher: 'WriteFile',
        sequential: true,
        hooks: [
          { type: HookType.Command, command: 'hook1' },
          { type: HookType.Command, command: 'hook2' },
        ],
      });

      const handler = new HookEventHandler({
        registry,
        planner: new HookPlanner(),
        runHook: createMockRunHook(),
      });

      const response = await handler.handle({
        context: {
          eventName: HookEventName.PreToolUse,
          sessionId: 'test-session',
          cwd: '/test',
          transcriptPath: '/test/transcript',
          timestamp: new Date().toISOString(),
        },
        input: {
          session_id: 'test-session',
          transcript_path: '/test/transcript',
          cwd: '/test',
          hook_event_name: 'PreToolUse',
          timestamp: new Date().toISOString(),
        },
        toolName: 'WriteFile',
      });

      expect(response.success).toBe(true);
      expect(response.results).toHaveLength(2);
    });

    it('should handle errors gracefully', async () => {
      const registry = new HookRegistry();
      registry.register({
        matcher: 'WriteFile',
        hooks: [{ type: HookType.Command, command: 'failing-hook' }],
      });

      const handler = new HookEventHandler({
        registry,
        planner: new HookPlanner(),
        runHook: async () => {
          throw new Error('Hook execution failed');
        },
      });

      const response = await handler.handle({
        context: {
          eventName: HookEventName.PreToolUse,
          sessionId: 'test-session',
          cwd: '/test',
          transcriptPath: '/test/transcript',
          timestamp: new Date().toISOString(),
        },
        input: {
          session_id: 'test-session',
          transcript_path: '/test/transcript',
          cwd: '/test',
          hook_event_name: 'PreToolUse',
          timestamp: new Date().toISOString(),
        },
        toolName: 'WriteFile',
      });

      expect(response.success).toBe(false);
      expect(response.isBlocking).toBe(true);
      expect(response.reasons).toContain('Hook execution failed');
    });
  });

  describe('createHookInput', () => {
    it('should create basic hook input', () => {
      const handler = new HookEventHandler({
        registry: new HookRegistry(),
        planner: new HookPlanner(),
        runHook: createMockRunHook(),
      });

      const context = {
        eventName: HookEventName.PreToolUse,
        sessionId: 'test-session',
        cwd: '/test',
        transcriptPath: '/test/transcript',
        timestamp: '2024-01-01T00:00:00Z',
      };

      const input = handler.createHookInput(context);
      expect(input.session_id).toBe('test-session');
      expect(input.cwd).toBe('/test');
      expect(input.hook_event_name).toBe('PreToolUse');
    });
  });

  describe('createPreToolUseInput', () => {
    it('should create PreToolUse input', () => {
      const handler = new HookEventHandler({
        registry: new HookRegistry(),
        planner: new HookPlanner(),
        runHook: createMockRunHook(),
      });

      const context = {
        eventName: HookEventName.PreToolUse,
        sessionId: 'test-session',
        cwd: '/test',
        transcriptPath: '/test/transcript',
        timestamp: '2024-01-01T00:00:00Z',
      };

      const input = handler.createPreToolUseInput(
        context,
        'WriteFile',
        { path: '/test/file.txt' },
        'tool-123',
      );

      expect(input.tool_name).toBe('WriteFile');
      expect(input.tool_input).toEqual({ path: '/test/file.txt' });
      expect(input.tool_use_id).toBe('tool-123');
    });
  });

  describe('createPostToolUseInput', () => {
    it('should create PostToolUse input', () => {
      const handler = new HookEventHandler({
        registry: new HookRegistry(),
        planner: new HookPlanner(),
        runHook: createMockRunHook(),
      });

      const context = {
        eventName: HookEventName.PostToolUse,
        sessionId: 'test-session',
        cwd: '/test',
        transcriptPath: '/test/transcript',
        timestamp: '2024-01-01T00:00:00Z',
      };

      const input = handler.createPostToolUseInput(
        context,
        'WriteFile',
        { path: '/test/file.txt' },
        { success: true },
        'tool-123',
      );

      expect(input.tool_name).toBe('WriteFile');
      expect(input.tool_response).toEqual({ success: true });
    });
  });

  describe('createUserPromptSubmitInput', () => {
    it('should create UserPromptSubmit input', () => {
      const handler = new HookEventHandler({
        registry: new HookRegistry(),
        planner: new HookPlanner(),
        runHook: createMockRunHook(),
      });

      const context = {
        eventName: HookEventName.UserPromptSubmit,
        sessionId: 'test-session',
        cwd: '/test',
        transcriptPath: '/test/transcript',
        timestamp: '2024-01-01T00:00:00Z',
      };

      const input = handler.createUserPromptSubmitInput(context, 'Hello world');
      expect(input.prompt).toBe('Hello world');
    });
  });

  describe('createStopInput', () => {
    it('should create Stop input', () => {
      const handler = new HookEventHandler({
        registry: new HookRegistry(),
        planner: new HookPlanner(),
        runHook: createMockRunHook(),
      });

      const context = {
        eventName: HookEventName.Stop,
        sessionId: 'test-session',
        cwd: '/test',
        transcriptPath: '/test/transcript',
        timestamp: '2024-01-01T00:00:00Z',
      };

      const input = handler.createStopInput(context, true);
      expect(input.stop_hook_active).toBe(true);
    });
  });
});

describe('createHookEventHandler', () => {
  it('should create a new HookEventHandler instance', () => {
    const handler = createHookEventHandler({
      registry: new HookRegistry(),
      planner: new HookPlanner(),
      runHook: async () => ({
        hookConfig: { type: HookType.Command, command: 'test' },
        eventName: HookEventName.PreToolUse,
        success: true,
        stdout: '',
        stderr: '',
        exitCode: 0,
        duration: 100,
      }),
    });
    expect(handler).toBeInstanceOf(HookEventHandler);
  });
});
