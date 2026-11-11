/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { customContextContext } from '../utils/sessionIdContext.js';
import { runWithCwdOverride } from '../utils/Shell.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HookEventHandler } from './hookEventHandler.js';
import type { Config } from '../config/config.js';
import {
  ConfigSource,
  NotificationType,
  SessionStartSource,
  HookEventName,
  HookType,
  PreCompactTrigger,
  DefaultHookOutput,
  type HookConfig,
  type HookExecutionResult,
} from './types.js';
import type { HookPlanner } from './hookPlanner.js';
import type { HookRunner } from './hookRunner.js';
import type { HookAggregator } from './hookAggregator.js';
import { READ_FILE_TOOL_NAME } from '../tools/tool-names.js';
import { CoreEvent } from '../utils/events.js';
import type { Model } from '../provider/model/model.js';

// Mock runLogger
const mockRunLogger = vi.hoisted(() => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

// Mock coreEvents
const mockCoreEvents = vi.hoisted(() => ({
  emitFeedback: vi.fn(),
  emit: vi.fn(),
}));

const mockEmitHookStarted = vi.hoisted(() => vi.fn());
const mockEmitHookFinished = vi.hoisted(() => vi.fn());

const mockEnqueuePendingNotification = vi.hoisted(() => vi.fn());
const mockGetModel = vi.hoisted(() => vi.fn());
const mockListModels = vi.hoisted(() => vi.fn());

vi.mock('../utils/runLogger.js', () => ({
  runLogger: mockRunLogger,
}));

vi.mock('../utils/events.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/events.js')>()),
  coreEvents: mockCoreEvents,
}));

vi.mock('../utils/diagnosticInterceptors.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../utils/diagnosticInterceptors.js')
  >()),
  emitHookStarted: mockEmitHookStarted,
  emitHookFinished: mockEmitHookFinished,
}));

vi.mock('../services/messageQueueManager.js', () => ({
  enqueuePendingNotification: mockEnqueuePendingNotification,
}));

describe('HookEventHandler', () => {
  let hookEventHandler: HookEventHandler;
  let mockConfig: Config;
  let mockHookPlanner: HookPlanner;
  let mockHookRunner: HookRunner;
  let mockHookAggregator: HookAggregator;

  beforeEach(() => {
    vi.resetAllMocks();
    mockGetModel.mockResolvedValue(undefined);
    mockListModels.mockResolvedValue([]);

    mockConfig = {
      get config() {
        return this;
      },
      promptId: 'test-prompt-id',
      getSessionId: vi.fn().mockReturnValue('test-session'),
      getProjectRoot: vi.fn().mockReturnValue('/test/project'),
      getActiveSessionTranscriptPath: vi
        .fn()
        .mockReturnValue('/test/project/test-session.jsonl'),
      getWorkingDir: vi.fn().mockReturnValue('/test/project'),
      getWorkspaceContext: vi.fn().mockReturnValue({
        getDirectories: () => ['/test/project'],
      }),
      getPermissionMode: vi.fn().mockReturnValue('default'),
      isAllHooksDisabled: vi.fn().mockReturnValue(false),
      isInteractive: vi.fn().mockReturnValue(true),
      canRunAsyncRewakeHooks: vi.fn().mockReturnValue(true),
      getModelProviderManager: () => ({
        getModel: mockGetModel,
        listModels: mockListModels,
      }),
    } as unknown as Config;

    mockHookPlanner = {
      createExecutionPlan: vi.fn(),
    } as unknown as HookPlanner;

    mockHookRunner = {
      executeHooksParallel: vi.fn(),
      executeHooksSequential: vi.fn(),
    } as unknown as HookRunner;

    mockHookAggregator = {
      aggregateResults: vi.fn(),
    } as unknown as HookAggregator;

    hookEventHandler = new HookEventHandler(
      mockConfig,
      mockHookPlanner,
      mockHookRunner,
      mockHookAggregator,
    );
  });


  describe('hook lifecycle events', () => {
    const hiddenHook = {
      type: HookType.Runtime,
      name: 'goal-loop-stop',
      action: () => undefined,
      source: ConfigSource.System,
    } as unknown as HookConfig;
    const userHook = {
      type: HookType.Command,
      command: './user.sh',
    } as unknown as HookConfig;

    async function runPlan(hookConfigs: HookConfig[]) {
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue({
        eventName: HookEventName.PreToolUse,
        hookConfigs,
        sequential: true,
        asyncHookConfigs: [],
      });
      vi.mocked(mockHookRunner.executeHooksSequential).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue({
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
      });
      await hookEventHandler.firePreToolUseEvent('Read', {}, 'call-1');
      const call = vi.mocked(mockHookRunner.executeHooksSequential).mock
        .calls[0];
      const onStart = call[3]!;
      const onEnd = call[4]!;
      hookConfigs.forEach((hookConfig, index) => {
        onStart(hookConfig, index);
        onEnd(
          hookConfig,
          {
            success: true,
            duration: 1,
            hookConfig,
            eventName: HookEventName.PreToolUse,
          },
          index,
        );
      });
    }

    const uiEvents = (event: CoreEvent) =>
      mockCoreEvents.emit.mock.calls
        .filter(([name]) => name === event)
        .map(([, payload]) => payload);

    it.each([false, true])(
      'marks UI completion only when the batch signal is aborted (%s)',
      async (cancelled) => {
        const controller = new AbortController();
        vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue({
          eventName: HookEventName.UserPromptSubmit,
          hookConfigs: [userHook],
          asyncHookConfigs: [],
          sequential: false,
        });
        vi.mocked(mockHookRunner.executeHooksParallel).mockImplementation(
          async (_hooks, eventName, _input, onStart, onEnd) => {
            onStart?.(userHook, 0);
            if (cancelled) controller.abort();
            const result = {
              success: false,
              duration: 1,
              hookConfig: userHook,
              eventName,
            };
            onEnd?.(userHook, result, 0);
            return [result];
          },
        );
        vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue({
          success: false,
          allOutputs: [],
          errors: [],
          totalDuration: 1,
        });
        await hookEventHandler.fireUserPromptSubmitEvent(
          'hello',
          controller.signal,
        );
        const [event] = uiEvents(CoreEvent.HookEnd);
        if (cancelled) expect(event).toHaveProperty('cancelled', true);
        else expect(event).not.toHaveProperty('cancelled');
        expect(mockEmitHookFinished.mock.calls[0][0]).not.toHaveProperty(
          'cancelled',
        );
      },
    );

    it('numbers UI events over user-visible hooks only', async () => {
      await runPlan([hiddenHook, userHook]);

      const starts = uiEvents(CoreEvent.HookStart);
      expect(starts).toEqual([
        expect.objectContaining({
          batchId: expect.any(String),
          agentId: undefined,
          hookIndex: 1,
          totalHooks: 1,
        }),
      ]);
      expect(uiEvents(CoreEvent.HookEnd)).toEqual([
        expect.objectContaining({ batchId: starts[0].batchId, hookIndex: 1 }),
      ]);
      // Both hooks of the plan are still reported to core events.
      expect(mockEmitHookStarted).toHaveBeenCalledTimes(2);
      expect(mockEmitHookStarted).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ hookIndex: 2, totalHooks: 2 }),
      );
      expect(mockEmitHookFinished).toHaveBeenCalledTimes(2);
    });

    it('emits no UI events when every hook is hidden', async () => {
      await runPlan([hiddenHook]);

      expect(uiEvents(CoreEvent.HookStart)).toEqual([]);
      expect(uiEvents(CoreEvent.HookEnd)).toEqual([]);
      expect(mockEmitHookStarted).toHaveBeenCalledTimes(1);
    });

    it('tags UI events with the subagent id', async () => {
      const { runWithAgentContext } = await import('../utils/agentContext.js');
      await runWithAgentContext({ agentId: 'a1', agentType: 'worker' }, () =>
        runPlan([userHook]),
      );

      expect(uiEvents(CoreEvent.HookStart)).toEqual([
        expect.objectContaining({ agentId: 'a1' }),
      ]);
      expect(uiEvents(CoreEvent.HookEnd)).toEqual([
        expect.objectContaining({ agentId: 'a1' }),
      ]);
    });
  });

  describe('firePreToolUseEvent', () => {
    /** Fire one PreToolUse and return the `model` field handed to hooks. */
    async function payloadModel(
      catalog: ReadonlyArray<Partial<Model>>,
      modelKey?: string,
    ): Promise<unknown> {
      mockListModels.mockResolvedValue(catalog as Model[]);
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue({
        eventName: HookEventName.PreToolUse,
        hookConfigs: [
          {
            type: HookType.Command,
            command: './audit-model.sh',
          } as unknown as HookConfig,
        ],
        sequential: false,
        asyncHookConfigs: [],
      });
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue({
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
      });

      await hookEventHandler.firePreToolUseEvent(
        'Read',
        { file_path: '/tmp/example' },
        'call-model',
        undefined,
        undefined,
        undefined,
        modelKey,
      );

      const input = vi.mocked(mockHookRunner.executeHooksParallel).mock
        .calls[0]?.[2] as unknown as Record<string, unknown> | undefined;
      return input?.['model'];
    }

    it('resolves the display name from the cached snapshot only', async () => {
      const model = await payloadModel(
        [{ key: 'qwen-ultimate', displayName: 'Qwen Ultimate' }],
        'qwen-ultimate',
      );

      expect(model).toBe('Qwen Ultimate');
      expect(mockListModels).toHaveBeenCalledWith({ cachedOnly: true });
      expect(mockGetModel).not.toHaveBeenCalled();
    });

    it('matches the catalog key case-insensitively', async () => {
      expect(
        await payloadModel(
          [{ key: 'qwen-ultimate', displayName: 'Qwen Ultimate' }],
          'Qwen-Ultimate',
        ),
      ).toBe('Qwen Ultimate');
    });

    it('falls back to the key when the snapshot misses it', async () => {
      expect(await payloadModel([], 'provider/internal-key')).toBe(
        'provider/internal-key',
      );
    });

    it('falls back to the key when the entry has no display name', async () => {
      expect(await payloadModel([{ key: 'plain-model' }], 'plain-model')).toBe(
        'plain-model',
      );
    });

    it('falls back to the key when the display name is blank', async () => {
      expect(
        await payloadModel(
          [{ key: 'blank-model', displayName: '   ' }],
          'blank-model',
        ),
      ).toBe('blank-model');
    });

    it('omits the field when no model key is supplied', async () => {
      expect(await payloadModel([], undefined)).toBeUndefined();
      expect(mockListModels).not.toHaveBeenCalled();
    });

    it('should fire PreToolUse event with correct input', async () => {
      const mockPlan = [
        {
          hookConfig: {
            type: HookType.Command,
            command: './test.sh',
          } as unknown as HookConfig,
          eventName: HookEventName.PreToolUse,
        },
      ];
      const mockResults: HookExecutionResult[] = [
        {
          success: true,
          duration: 100,
          hookConfig: {
            type: HookType.Command,
            command: './test.sh',
            timeout: 30,
          },
          eventName: HookEventName.PreToolUse,
        },
      ];
      const mockAggregated = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 100,
      };

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue({
        eventName: HookEventName.PreToolUse,
        hookConfigs: mockPlan.map((p) => p.hookConfig),
        sequential: false,
        asyncHookConfigs: [],
      });
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue(
        mockResults,
      );
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      const result = await hookEventHandler.firePreToolUseEvent(
        'EditTool',
        {
          file: 'test.txt',
        },
        'call-1',
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.PreToolUse,
        {
          toolName: 'EditTool',
          toolInput: { file: 'test.txt' },
          agentId: undefined,
        },
        true,
      );

      expect(mockHookRunner.executeHooksParallel).toHaveBeenCalledWith(
        [mockPlan[0].hookConfig],
        HookEventName.PreToolUse,
        expect.objectContaining({
          session_id: 'test-session',
          cwd: '/test/project',
          hook_event_name: 'PreToolUse',
          tool_name: 'EditTool',
          tool_input: { file: 'test.txt' },
        }),
        expect.any(Function),
        expect.any(Function),
        undefined,
      );

      // Verify event emission via callbacks
      const onHookStart = vi.mocked(mockHookRunner.executeHooksParallel).mock
        .calls[0][3];
      const onHookEnd = vi.mocked(mockHookRunner.executeHooksParallel).mock
        .calls[0][4];

      if (onHookStart) onHookStart(mockPlan[0].hookConfig, 0);
      expect(mockCoreEvents.emit).toHaveBeenCalledWith(
        CoreEvent.HookStart,
        expect.objectContaining({
          sessionId: 'test-session',
          turnId: 'test-prompt-id',
          toolCallId: 'call-1',
          hookName: HookEventName.PreToolUse,
          eventName: HookEventName.PreToolUse,
          batchId: expect.any(String),
          hookIndex: 1,
          totalHooks: 1,
        }),
      );
      const startPayload = mockCoreEvents.emit.mock.calls.find(
        ([name]) => name === CoreEvent.HookStart,
      )?.[1] as { batchId: string };

      if (onHookEnd) onHookEnd(mockPlan[0].hookConfig, mockResults[0], 0);
      expect(mockCoreEvents.emit).toHaveBeenCalledWith(
        CoreEvent.HookEnd,
        expect.objectContaining({
          sessionId: 'test-session',
          turnId: 'test-prompt-id',
          toolCallId: 'call-1',
          hookName: HookEventName.PreToolUse,
          eventName: HookEventName.PreToolUse,
          batchId: startPayload.batchId,
          hookIndex: 1,
          success: true,
        }),
      );

      expect(result).toBe(mockAggregated);
    });

    it('should return empty result when no hooks to execute', async () => {
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(null);

      const result = await hookEventHandler.firePreToolUseEvent(
        'EditTool',
        {},
        'call-1',
      );

      expect(result.success).toBe(true);
      expect(result.allOutputs).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
      expect(result.totalDuration).toBe(0);
      expect(result.hooksSkipped).toBe(true);
    });

    it('should handle execution errors gracefully', async () => {
      vi.mocked(mockHookPlanner.createExecutionPlan).mockImplementation(() => {
        throw new Error('Planning failed');
      });

      const result = await hookEventHandler.firePreToolUseEvent(
        'EditTool',
        {},
        'call-1',
      );

      // PreToolUse: system error → fail-closed (deny)
      expect(result.success).toBe(false);
      expect(result.finalOutput).toBeDefined();
      expect(result.finalOutput!.isBlockingDecision()).toBe(true);
      expect(mockRunLogger.error).toHaveBeenCalled();
    });

    it('should treat spawn errors as non-blocking (no user-visible feedback)', async () => {
      const mockPlan = [
        {
          type: HookType.Command,
          command: './fail.sh',
        } as HookConfig,
      ];
      const mockResults: HookExecutionResult[] = [
        {
          success: false,
          duration: 50,
          hookConfig: mockPlan[0],
          eventName: HookEventName.PreToolUse,
          exitCode: 1,
          error: new Error('Failed to execute'),
        },
      ];
      const mockAggregated = {
        success: false,
        allOutputs: [],
        errors: [new Error('Failed to execute')],
        totalDuration: 50,
      };

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue({
        eventName: HookEventName.PreToolUse,
        hookConfigs: mockPlan,
        sequential: false,
        asyncHookConfigs: [],
      });
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue(
        mockResults,
      );
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      await hookEventHandler.firePreToolUseEvent('EditTool', {}, 'call-1');

      // Spawn errors (exitCode !== 2) should NOT emit user-visible feedback
      expect(mockCoreEvents.emitFeedback).not.toHaveBeenCalled();
      // But should be logged as non-blocking warn message
      expect(mockRunLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('./fail.sh'),
      );
    });

    it('should fire PreToolUse event with MCP context when provided', async () => {
      const mockPlan = [
        {
          hookConfig: {
            type: HookType.Command,
            command: './test.sh',
          } as unknown as HookConfig,
          eventName: HookEventName.PreToolUse,
        },
      ];
      const mockResults: HookExecutionResult[] = [
        {
          success: true,
          duration: 100,
          hookConfig: {
            type: HookType.Command,
            command: './test.sh',
            timeout: 30,
          },
          eventName: HookEventName.PreToolUse,
        },
      ];
      const mockAggregated = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 100,
      };

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue({
        eventName: HookEventName.PreToolUse,
        hookConfigs: mockPlan.map((p) => p.hookConfig),
        sequential: false,
        asyncHookConfigs: [],
      });
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue(
        mockResults,
      );
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      const mcpContext = {
        server_name: 'my-mcp-server',
        tool_name: READ_FILE_TOOL_NAME,
        command: 'npx',
        args: ['-y', '@my-org/mcp-server'],
      };

      const result = await hookEventHandler.firePreToolUseEvent(
        'my-mcp-server__read_file',
        { path: '/etc/passwd' },
        'call-mcp-1',
        mcpContext,
      );

      expect(mockHookRunner.executeHooksParallel).toHaveBeenCalledWith(
        [mockPlan[0].hookConfig],
        HookEventName.PreToolUse,
        expect.objectContaining({
          session_id: 'test-session',
          cwd: '/test/project',
          hook_event_name: 'PreToolUse',
          tool_name: 'my-mcp-server__read_file',
          tool_input: { path: '/etc/passwd' },
          mcp_context: mcpContext,
        }),
        expect.any(Function),
        expect.any(Function),
        undefined,
      );

      expect(result).toBe(mockAggregated);
    });

    it('should not include mcp_context when not provided', async () => {
      const mockPlan = [
        {
          hookConfig: {
            type: HookType.Command,
            command: './test.sh',
          } as unknown as HookConfig,
          eventName: HookEventName.PreToolUse,
        },
      ];
      const mockResults: HookExecutionResult[] = [
        {
          success: true,
          duration: 100,
          hookConfig: {
            type: HookType.Command,
            command: './test.sh',
            timeout: 30,
          },
          eventName: HookEventName.PreToolUse,
        },
      ];
      const mockAggregated = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 100,
      };

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue({
        eventName: HookEventName.PreToolUse,
        hookConfigs: mockPlan.map((p) => p.hookConfig),
        sequential: false,
        asyncHookConfigs: [],
      });
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue(
        mockResults,
      );
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      await hookEventHandler.firePreToolUseEvent(
        'EditTool',
        {
          file: 'test.txt',
        },
        'call-1',
      );

      const callArgs = vi.mocked(mockHookRunner.executeHooksParallel).mock
        .calls[0][2];
      expect(callArgs).not.toHaveProperty('mcp_context');
    });
  });

  describe('firePostToolUseEvent', () => {
    it('should fire PostToolUse event with tool response', async () => {
      const mockPlan = [
        {
          hookConfig: {
            type: HookType.Command,
            command: './after.sh',
          } as unknown as HookConfig,
          eventName: HookEventName.PostToolUse,
        },
      ];
      const mockResults: HookExecutionResult[] = [
        {
          success: true,
          duration: 100,
          hookConfig: {
            type: HookType.Command,
            command: './test.sh',
            timeout: 30,
          },
          eventName: HookEventName.PreToolUse,
        },
      ];
      const mockAggregated = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 100,
      };

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue({
        eventName: HookEventName.PreToolUse,
        hookConfigs: mockPlan.map((p) => p.hookConfig),
        sequential: false,
        asyncHookConfigs: [],
      });
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue(
        mockResults,
      );
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      const toolInput = { file: 'test.txt' };
      const toolResponse = { success: true, content: 'File edited' };
      const fileWrite = {
        file_path: '/workspace/test.txt',
        workspace_path: '/workspace',
        original_content: 'before',
        proposed_content: 'proposal',
        written_content: 'actual',
        business_id: 'business-1',
        request_set_id: 'request-1',
      };

      const result = await hookEventHandler.firePostToolUseEvent(
        'EditTool',
        toolInput,
        toolResponse,
        'call-1',
        undefined,
        undefined,
        undefined,
        undefined,
        fileWrite,
      );

      expect(mockHookRunner.executeHooksParallel).toHaveBeenCalledWith(
        [mockPlan[0].hookConfig],
        HookEventName.PostToolUse,
        expect.objectContaining({
          tool_name: 'EditTool',
          tool_input: toolInput,
          tool_response: toolResponse,
          file_write: fileWrite,
        }),
        expect.any(Function),
        expect.any(Function),
        undefined,
      );
      const runnerInput = vi.mocked(mockHookRunner.executeHooksParallel).mock
        .calls[0][2] as unknown as Record<string, unknown>;
      expect(runnerInput['file_write']).toEqual(fileWrite);
      expect(Object.keys(runnerInput)).not.toContain('file_write');
      expect(JSON.stringify(runnerInput)).not.toContain('original_content');
      expect({ ...runnerInput }).not.toHaveProperty('file_write');

      expect(result).toBe(mockAggregated);
    });

    it('should fire PostToolUse event with MCP context when provided', async () => {
      const mockPlan = [
        {
          hookConfig: {
            type: HookType.Command,
            command: './after.sh',
          } as unknown as HookConfig,
          eventName: HookEventName.PostToolUse,
        },
      ];
      const mockResults: HookExecutionResult[] = [
        {
          success: true,
          duration: 100,
          hookConfig: {
            type: HookType.Command,
            command: './after.sh',
            timeout: 30,
          },
          eventName: HookEventName.PostToolUse,
        },
      ];
      const mockAggregated = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 100,
      };

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue({
        eventName: HookEventName.PostToolUse,
        hookConfigs: mockPlan.map((p) => p.hookConfig),
        sequential: false,
        asyncHookConfigs: [],
      });
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue(
        mockResults,
      );
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      const toolInput = { path: '/etc/passwd' };
      const toolResponse = { success: true, content: 'File content' };
      const mcpContext = {
        server_name: 'my-mcp-server',
        tool_name: READ_FILE_TOOL_NAME,
        url: 'https://mcp.example.com',
      };

      const result = await hookEventHandler.firePostToolUseEvent(
        'my-mcp-server__read_file',
        toolInput,
        toolResponse,
        'call-mcp-1',
        mcpContext,
      );

      expect(mockHookRunner.executeHooksParallel).toHaveBeenCalledWith(
        [mockPlan[0].hookConfig],
        HookEventName.PostToolUse,
        expect.objectContaining({
          tool_name: 'my-mcp-server__read_file',
          tool_input: toolInput,
          tool_response: toolResponse,
          mcp_context: mcpContext,
        }),
        expect.any(Function),
        expect.any(Function),
        undefined,
      );

      expect(result).toBe(mockAggregated);
    });
  });

  describe('fireSubagentStartEvent', () => {
    it('should fire SubagentStart event with agent_id and agent_type', async () => {
      const mockPlan = [
        {
          hookConfig: {
            type: HookType.Command,
            command: './before_agent.sh',
          } as unknown as HookConfig,
          eventName: HookEventName.SubagentStart,
        },
      ];
      const mockResults: HookExecutionResult[] = [
        {
          success: true,
          duration: 100,
          hookConfig: {
            type: HookType.Command,
            command: './test.sh',
            timeout: 30,
          },
          eventName: HookEventName.PreToolUse,
        },
      ];
      const mockAggregated = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 100,
      };

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue({
        eventName: HookEventName.PreToolUse,
        hookConfigs: mockPlan.map((p) => p.hookConfig),
        sequential: false,
        asyncHookConfigs: [],
      });
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue(
        mockResults,
      );
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      const agentId = 'abc123';
      const agentType = 'code-review';

      const result = await hookEventHandler.fireSubagentStartEvent(
        agentId,
        agentType,
      );

      expect(mockHookRunner.executeHooksParallel).toHaveBeenCalledWith(
        [mockPlan[0].hookConfig],
        HookEventName.SubagentStart,
        expect.objectContaining({
          agent_id: agentId,
          agent_type: agentType,
        }),
        expect.any(Function),
        expect.any(Function),
        undefined,
      );

      expect(result).toBe(mockAggregated);
    });
  });

  describe('fireNotificationEvent', () => {
    it('should fire Notification event', async () => {
      const mockPlan = [
        {
          hookConfig: {
            type: HookType.Command,
            command: './notification-hook.sh',
          } as HookConfig,
          eventName: HookEventName.Notification,
        },
      ];
      const mockResults: HookExecutionResult[] = [
        {
          success: true,
          duration: 50,
          hookConfig: {
            type: HookType.Command,
            command: './notification-hook.sh',
            timeout: 30,
          },
          eventName: HookEventName.Notification,
        },
      ];
      const mockAggregated = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 50,
      };

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue({
        eventName: HookEventName.Notification,
        hookConfigs: mockPlan.map((p) => p.hookConfig),
        sequential: false,
        asyncHookConfigs: [],
      });
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue(
        mockResults,
      );
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      const message = 'Tool execution requires permission';

      const result = await hookEventHandler.fireNotificationEvent(
        NotificationType.PermissionPrompt,
        message,
        { type: 'PermissionPrompt', title: 'Test Permission' },
      );

      expect(mockHookRunner.executeHooksParallel).toHaveBeenCalledWith(
        [mockPlan[0].hookConfig],
        HookEventName.Notification,
        expect.objectContaining({
          notification_type: 'permission_prompt',
          details: { type: 'PermissionPrompt', title: 'Test Permission' },
        }),
        expect.any(Function),
        expect.any(Function),
        undefined,
      );

      expect(result).toBe(mockAggregated);
    });
  });

  describe('fireSessionStartEvent', () => {
    it('should fire SessionStart event with source', async () => {
      const mockPlan = [
        {
          hookConfig: {
            type: HookType.Command,
            command: './session_start.sh',
          } as unknown as HookConfig,
          eventName: HookEventName.SessionStart,
        },
      ];
      const mockResults: HookExecutionResult[] = [
        {
          success: true,
          duration: 200,
          hookConfig: {
            type: HookType.Command,
            command: './session_start.sh',
            timeout: 30,
          },
          eventName: HookEventName.SessionStart,
        },
      ];
      const mockAggregated = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 200,
      };

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue({
        eventName: HookEventName.SessionStart,
        hookConfigs: mockPlan.map((p) => p.hookConfig),
        sequential: false,
        asyncHookConfigs: [],
      });
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue(
        mockResults,
      );
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue(
        mockAggregated,
      );

      const result = await hookEventHandler.fireSessionStartEvent(
        SessionStartSource.Startup,
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.SessionStart,
        { trigger: 'startup' },
        true,
      );

      expect(mockHookRunner.executeHooksParallel).toHaveBeenCalledWith(
        [mockPlan[0].hookConfig],
        HookEventName.SessionStart,
        expect.objectContaining({
          source: 'startup',
        }),
        expect.any(Function),
        expect.any(Function),
        undefined,
      );

      expect(result).toBe(mockAggregated);
    });
  });

  describe('createBaseInput', () => {
    it('should create base input with correct fields', async () => {
      vi.mocked(mockConfig.getActiveSessionTranscriptPath).mockReturnValue(
        '/stable-project/test-session.jsonl',
      );
      const mockPlan = [
        {
          hookConfig: {
            type: HookType.Command,
            command: './test.sh',
          } as unknown as HookConfig,
          eventName: HookEventName.PreToolUse,
        },
      ];

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue({
        eventName: HookEventName.PreToolUse,
        hookConfigs: mockPlan.map((p) => p.hookConfig),
        sequential: false,
        asyncHookConfigs: [],
      });
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue({
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
      });

      await hookEventHandler.firePreToolUseEvent('TestTool', {}, 'call-1');

      expect(mockHookRunner.executeHooksParallel).toHaveBeenCalledWith(
        expect.any(Array),
        HookEventName.PreToolUse,
        expect.objectContaining({
          session_id: 'test-session',
          transcript_path: '/stable-project/test-session.jsonl',
          cwd: '/test/project',
          hook_event_name: 'PreToolUse',
          permission_mode: 'default',
        }),
        expect.any(Function),
        expect.any(Function),
        undefined,
      );
    });
  });

  it.each([HookEventName.CwdChanged, HookEventName.FileChanged])(
    'executes %s hooks in the owning directory instead of the project root',
    async (eventName) => {
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue({
        eventName,
        hookConfigs: [{ type: HookType.Command, command: 'pwd' }],
        sequential: false,
        asyncHookConfigs: [],
      });
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue({
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
      });
      const cwd = '/test/project/src';
      if (eventName === HookEventName.CwdChanged) {
        await hookEventHandler.fireCwdChangedEvent('/test/project', cwd);
      } else {
        await hookEventHandler.fireFileChangedEvent(
          `${cwd}/.envrc`,
          'change',
          undefined,
          cwd,
        );
      }
      const input = vi.mocked(mockHookRunner.executeHooksParallel).mock
        .calls[0][2];
      expect(input.cwd).toBe(cwd);
      expect(mockConfig.getWorkingDir()).toBe('/test/project');
    },
  );

  describe('firePreCompactEvent', () => {
    it('fires PreCompact with only the upstream common keys plus trigger and custom_instructions', async () => {
      const hookConfig = {
        type: HookType.Command,
        command: './pre.sh',
      } as unknown as HookConfig;
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue({
        eventName: HookEventName.PreCompact,
        hookConfigs: [hookConfig],
        sequential: false,
        asyncHookConfigs: [],
      });
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue({
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
      });

      await runWithCwdOverride('/test/project/src', () =>
        hookEventHandler.firePreCompactEvent(
          PreCompactTrigger.Manual,
          'focus on API schema',
        ),
      );

      const call = vi.mocked(mockHookRunner.executeHooksParallel).mock.calls[0];
      const input = call[2] as unknown as Record<string, unknown>;
      expect(input).toEqual({
        session_id: 'test-session',
        transcript_path: expect.stringContaining('/test-session.jsonl'),
        cwd: '/test/project/src',
        workspace_dirs: ['/test/project'],
        hook_event_name: 'PreCompact',
        trigger: 'manual',
        custom_instructions: 'focus on API schema',
      });
      expect(input).not.toHaveProperty('permission_mode');
      expect(input).not.toHaveProperty('agent_id');
      expect(input).not.toHaveProperty('agent_type');
    });
  });

  describe('firePostCompactEvent', () => {
    it('fires PostCompact with only the upstream common keys plus trigger and compact_summary', async () => {
      const hookConfig = {
        type: HookType.Command,
        command: './post.sh',
      } as unknown as HookConfig;
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue({
        eventName: HookEventName.PostCompact,
        hookConfigs: [hookConfig],
        sequential: false,
        asyncHookConfigs: [],
      });
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue({
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
      });

      await runWithCwdOverride('/test/project/src', () =>
        hookEventHandler.firePostCompactEvent(
          PreCompactTrigger.Auto,
          'Summary:\n1. Primary Request and Intent:\n   …',
        ),
      );

      const call = vi.mocked(mockHookRunner.executeHooksParallel).mock.calls[0];
      const input = call[2] as unknown as Record<string, unknown>;
      expect(input).toEqual({
        session_id: 'test-session',
        transcript_path: expect.stringContaining('/test-session.jsonl'),
        cwd: '/test/project/src',
        workspace_dirs: ['/test/project'],
        hook_event_name: 'PostCompact',
        trigger: 'auto',
        compact_summary: 'Summary:\n1. Primary Request and Intent:\n   …',
      });
      expect(input).not.toHaveProperty('permission_mode');
      expect(input).not.toHaveProperty('agent_id');
      expect(input).not.toHaveProperty('agent_type');
      expect(input).not.toHaveProperty('original_token_count');
      expect(input).not.toHaveProperty('compressed_token_count');
    });
  });

  describe('fireQueryEndEvent', () => {
    it('passes the complete payload, matches reason, and prevents background output effects', async () => {
      const syncHook = {
        type: HookType.Runtime,
        name: 'sync-query-end',
        action: vi.fn(),
      } as HookConfig;
      const asyncHook = {
        type: HookType.Command,
        command: './async-query-end.sh',
        async: true,
      } as HookConfig;
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue({
        eventName: HookEventName.QueryEnd,
        hookConfigs: [syncHook],
        sequential: false,
        asyncHookConfigs: [asyncHook],
        matchQuery: 'error',
      });
      const hookOutput = new DefaultHookOutput({
        continue: false,
        decision: 'deny',
        systemMessage: 'must not escape',
        hookSpecificOutput: { additionalContext: 'must not be queued' },
      });
      const results: HookExecutionResult[] = [syncHook, asyncHook].map(
        (hookConfig) => ({
          hookConfig,
          eventName: HookEventName.QueryEnd,
          success: true,
          duration: 1,
          output: hookOutput,
        }),
      );
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue(results);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue({
        success: true,
        finalOutput: hookOutput,
        allOutputs: [hookOutput],
        errors: [],
        totalDuration: 1,
      });
      const controller = new AbortController();

      const result = await hookEventHandler.fireQueryEndEvent(
        'request-set-1',
        'business-1',
        'example-model-1',
        'error',
        controller.signal,
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.QueryEnd,
        { trigger: 'error' },
        false,
      );
      expect(mockHookRunner.executeHooksParallel).toHaveBeenCalledWith(
        [syncHook, asyncHook],
        HookEventName.QueryEnd,
        expect.objectContaining({
          session_id: 'test-session',
          hook_event_name: 'QueryEnd',
          request_set_id: 'request-set-1',
          business_id: 'business-1',
          model: 'example-model-1',
          reason: 'error',
        }),
        expect.any(Function),
        expect.any(Function),
        controller.signal,
      );
      expect(result.finalOutput).toBe(hookOutput);
      expect(hookEventHandler.drainPendingAsyncContext()).toBeUndefined();
      expect(mockEnqueuePendingNotification).not.toHaveBeenCalled();
    });

    it('omits business_id when it is unavailable', async () => {
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue(null);

      await hookEventHandler.fireQueryEndEvent(
        'request-set-2',
        undefined,
        'qwen-model-2',
        'abort',
        new AbortController().signal,
      );

      const input = vi.mocked(mockHookPlanner.createExecutionPlan).mock
        .calls[0][1] as unknown as Record<string, unknown>;
      expect(input).not.toHaveProperty('business_id');
    });
  });

  describe('fireStopFailureEvent', () => {
    it('uses error as both the matcher value and payload discriminator', async () => {
      mockListModels.mockResolvedValue([
        { key: 'provider/internal-key', displayName: 'Qwen Ultimate' },
      ]);
      const hookConfig = {
        type: HookType.Command,
        command: './notify.sh',
      } as unknown as HookConfig;
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue({
        eventName: HookEventName.StopFailure,
        hookConfigs: [hookConfig],
        sequential: false,
        asyncHookConfigs: [],
      });
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue({
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
      });

      const controller = new AbortController();
      await hookEventHandler.fireStopFailureEvent(
        'overloaded',
        {
          errorDetails: 'HTTP 529: provider overloaded',
          lastAssistantMessage: 'API Error: provider overloaded',
        },
        controller.signal,
        'provider/internal-key',
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.StopFailure,
        { trigger: 'overloaded' },
        true,
      );
      const input = vi.mocked(mockHookRunner.executeHooksParallel).mock
        .calls[0][2] as unknown as Record<string, unknown>;
      expect(
        vi.mocked(mockHookRunner.executeHooksParallel).mock.calls[0][5],
      ).toBe(controller.signal);
      expect(input).toMatchObject({
        hook_event_name: 'StopFailure',
        error: 'overloaded',
        error_details: 'HTTP 529: provider overloaded',
        last_assistant_message: 'API Error: provider overloaded',
        model: 'Qwen Ultimate',
      });
      expect(JSON.stringify(input)).not.toContain('provider/internal-key');
      expect(input).not.toHaveProperty('error_type');
    });
  });

  describe('fireTeammateIdleEvent', () => {
    it('passes the teammate and team identity to configured hooks', async () => {
      const hookConfig = {
        type: HookType.Command,
        command: './check-idle.sh',
      } as unknown as HookConfig;
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue({
        eventName: HookEventName.TeammateIdle,
        hookConfigs: [hookConfig],
        sequential: false,
        asyncHookConfigs: [],
      });
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue({
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
      });
      const controller = new AbortController();

      await hookEventHandler.fireTeammateIdleEvent(
        'reviewer',
        'session-hooktest',
        controller.signal,
      );

      expect(mockHookPlanner.createExecutionPlan).toHaveBeenCalledWith(
        HookEventName.TeammateIdle,
        undefined,
        true,
      );
      const input = vi.mocked(mockHookRunner.executeHooksParallel).mock
        .calls[0][2] as unknown as Record<string, unknown>;
      expect(input).toMatchObject({
        hook_event_name: 'TeammateIdle',
        teammate_name: 'reviewer',
        team_name: 'session-hooktest',
      });
      expect(
        vi.mocked(mockHookRunner.executeHooksParallel).mock.calls[0][5],
      ).toBe(controller.signal);
    });
  });

  describe('asyncRewake preflight failure', () => {
    it('does NOT enqueue rewake notification when hook returns exitCode 1 (preflight failure)', async () => {
      const rewakeHook = {
        type: HookType.Command,
        command: '${QWEN_PLUGIN_ROOT}/missing.py',
        asyncRewake: true,
      } as unknown as HookConfig;

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue({
        eventName: HookEventName.PreToolUse,
        hookConfigs: [],
        sequential: false,
        asyncHookConfigs: [rewakeHook],
      });
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([
        {
          success: false,
          duration: 1,
          hookConfig: rewakeHook,
          eventName: HookEventName.PreToolUse,
          exitCode: 1,
          stderr: 'Plugin directory does not exist: /tmp/missing',
          stdout: '',
          error: new Error('preflight failure'),
        },
      ]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue({
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
      });

      await hookEventHandler.firePreToolUseEvent('TestTool', {}, 'call-1');
      const { flushPendingAsyncRewakeHooks } = await import(
        './hookEventHandler.js'
      );
      await flushPendingAsyncRewakeHooks();

      expect(mockEnqueuePendingNotification).not.toHaveBeenCalled();
    });

    it('does enqueue rewake notification when hook returns EXIT_CODE_BLOCK (exit code 2)', async () => {
      const rewakeHook = {
        type: HookType.Command,
        command: './blocker.sh',
        asyncRewake: true,
      } as unknown as HookConfig;

      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue({
        eventName: HookEventName.PreToolUse,
        hookConfigs: [],
        sequential: false,
        asyncHookConfigs: [rewakeHook],
      });
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([
        {
          success: false,
          duration: 1,
          hookConfig: rewakeHook,
          eventName: HookEventName.PreToolUse,
          exitCode: 2,
          stderr: 'blocked',
          stdout: '',
        },
      ]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue({
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
      });

      const customContext = Object.freeze({ tenant: 'alpha' });
      await customContextContext.run(customContext, () =>
        hookEventHandler.firePreToolUseEvent('TestTool', {}, 'call-1'),
      );
      const { flushPendingAsyncRewakeHooks } = await import(
        './hookEventHandler.js'
      );
      await flushPendingAsyncRewakeHooks();

      expect(mockEnqueuePendingNotification).toHaveBeenCalledTimes(1);
      expect(mockEnqueuePendingNotification).toHaveBeenCalledWith(
        expect.objectContaining({ customContext }),
      );
    });
  });

  describe('fireUserPromptSubmitEvent', () => {
    it('includes optional image_urls in the command hook input', async () => {
      const hookConfig = {
        type: HookType.Command,
        command: './inspect-prompt.sh',
      } as HookConfig;
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue({
        eventName: HookEventName.UserPromptSubmit,
        hookConfigs: [hookConfig],
        sequential: false,
        asyncHookConfigs: [],
      });
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue({
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
      });

      await hookEventHandler.fireUserPromptSubmitEvent(
        'inspect this',
        undefined,
        ['https://example.com/image.png'],
        'request-set-with-image',
      );

      const input = vi.mocked(mockHookRunner.executeHooksParallel).mock
        .calls[0]?.[2];
      expect(input).toEqual(
        expect.objectContaining({
          hook_event_name: HookEventName.UserPromptSubmit,
          prompt: 'inspect this',
          request_set_id: 'request-set-with-image',
          image_urls: ['https://example.com/image.png'],
        }),
      );
    });

    it('omits image_urls when no images are attached', async () => {
      const hookConfig = {
        type: HookType.Command,
        command: './inspect-prompt.sh',
      } as HookConfig;
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue({
        eventName: HookEventName.UserPromptSubmit,
        hookConfigs: [hookConfig],
        sequential: false,
        asyncHookConfigs: [],
      });
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue({
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
      });

      await hookEventHandler.fireUserPromptSubmitEvent('text only');

      const input = vi.mocked(mockHookRunner.executeHooksParallel).mock
        .calls[0]?.[2] as unknown as Record<string, unknown>;
      expect(input).not.toHaveProperty('image_urls');
      expect(input).not.toHaveProperty('request_set_id');
      expect(input).not.toHaveProperty('prompt_id');
    });
  });

  describe('once hooks', () => {
    const onceConfig = {
      type: HookType.Command,
      command: 'echo once',
      once: true,
    } as unknown as HookConfig;

    const setupSuccessfulOnceHook = (eventName: HookEventName) => {
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue({
        eventName,
        hookConfigs: [onceConfig],
        sequential: false,
        asyncHookConfigs: [],
      });
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([
        {
          success: true,
          hookConfig: onceConfig,
          duration: 1,
        } as unknown as HookExecutionResult,
      ]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue({
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
      });
    };

    it('removes a successful once hook by config when no agentId is present (inline skill case)', async () => {
      const mockRegistry = {
        removeSessionHook: vi.fn(),
        removeInlineSkillSessionHooks: vi.fn(),
      };
      const handler = new HookEventHandler(
        mockConfig,
        mockHookPlanner,
        mockHookRunner,
        mockHookAggregator,
        mockRegistry as never,
      );
      setupSuccessfulOnceHook(HookEventName.UserPromptSubmit);

      await handler.fireUserPromptSubmitEvent('hi');

      expect(mockRegistry.removeInlineSkillSessionHooks).toHaveBeenCalledWith(
        onceConfig,
      );
      expect(mockRegistry.removeSessionHook).not.toHaveBeenCalled();
    });

    it('removes a successful once hook by agentId inside an agent context', async () => {
      const mockRegistry = {
        removeSessionHook: vi.fn(),
        removeInlineSkillSessionHooks: vi.fn(),
      };
      const handler = new HookEventHandler(
        mockConfig,
        mockHookPlanner,
        mockHookRunner,
        mockHookAggregator,
        mockRegistry as never,
      );
      setupSuccessfulOnceHook(HookEventName.PreToolUse);

      const { runWithAgentContext } = await import('../utils/agentContext.js');
      await runWithAgentContext(
        { agentId: 'a1234', agentType: 'skill-x' },
        () => handler.firePreToolUseEvent('Read', {}, 'call-1'),
      );

      expect(mockRegistry.removeSessionHook).toHaveBeenCalledWith(
        'a1234',
        onceConfig,
      );
      expect(mockRegistry.removeInlineSkillSessionHooks).not.toHaveBeenCalled();
    });

    it('does not remove a once hook that failed', async () => {
      const mockRegistry = {
        removeSessionHook: vi.fn(),
        removeInlineSkillSessionHooks: vi.fn(),
      };
      const handler = new HookEventHandler(
        mockConfig,
        mockHookPlanner,
        mockHookRunner,
        mockHookAggregator,
        mockRegistry as never,
      );
      vi.mocked(mockHookPlanner.createExecutionPlan).mockReturnValue({
        eventName: HookEventName.UserPromptSubmit,
        hookConfigs: [onceConfig],
        sequential: false,
        asyncHookConfigs: [],
      });
      vi.mocked(mockHookRunner.executeHooksParallel).mockResolvedValue([
        {
          success: false,
          hookConfig: onceConfig,
          duration: 1,
        } as unknown as HookExecutionResult,
      ]);
      vi.mocked(mockHookAggregator.aggregateResults).mockReturnValue({
        success: false,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
      });

      await handler.fireUserPromptSubmitEvent('hi');

      expect(mockRegistry.removeInlineSkillSessionHooks).not.toHaveBeenCalled();
      expect(mockRegistry.removeSessionHook).not.toHaveBeenCalled();
    });
  });
});
