/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HookSystem } from './hookSystem.js';
import { HookRegistry } from './hookRegistry.js';
import { HookRunner } from './hookRunner.js';
import { HookAggregator } from './hookAggregator.js';
import { HookPlanner } from './hookPlanner.js';
import { HookEventHandler } from './hookEventHandler.js';
import {
  HookType,
  HooksConfigSource,
  HookEventName,
  SessionStartSource,
  SessionEndReason,
  PermissionMode,
  AgentType,
  type HookDecision,
  PreCompactTrigger,
  NotificationType,
  type PermissionSuggestion,
} from './types.js';
import type { Config } from '../config/config.js';
import type { AggregatedHookResult } from './hookAggregator.js';
import type { HookOutput } from './types.js';

vi.mock('./hookRegistry.js');
vi.mock('./hookRunner.js');
vi.mock('./hookAggregator.js');
vi.mock('./hookPlanner.js');
vi.mock('./hookEventHandler.js');

const createMockAggregatedResult = (
  success: boolean = true,
  finalOutput?: HookOutput,
): AggregatedHookResult => ({
  success,
  allOutputs: [],
  errors: [],
  totalDuration: 100,
  finalOutput,
});

describe('HookSystem', () => {
  let mockConfig: Config;
  let mockHookRegistry: HookRegistry;
  let mockHookRunner: HookRunner;
  let mockHookAggregator: HookAggregator;
  let mockHookPlanner: HookPlanner;
  let mockHookEventHandler: HookEventHandler;
  let hookSystem: HookSystem;

  beforeEach(() => {
    mockConfig = {
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      getTranscriptPath: vi.fn().mockReturnValue('/test/transcript'),
      getWorkingDir: vi.fn().mockReturnValue('/test/cwd'),
    } as unknown as Config;

    mockHookRegistry = {
      initialize: vi.fn().mockResolvedValue(undefined),
      setHookEnabled: vi.fn(),
      getAllHooks: vi.fn().mockReturnValue([]),
    } as unknown as HookRegistry;

    mockHookRunner = {
      executeHooksSequential: vi.fn(),
      executeHooksParallel: vi.fn(),
    } as unknown as HookRunner;

    mockHookAggregator = {
      aggregateResults: vi.fn(),
    } as unknown as HookAggregator;

    mockHookPlanner = {
      createExecutionPlan: vi.fn(),
    } as unknown as HookPlanner;

    mockHookEventHandler = {
      fireUserPromptSubmitEvent: vi.fn(),
      fireStopEvent: vi.fn(),
      fireSessionStartEvent: vi.fn(),
      fireSessionEndEvent: vi.fn(),
      firePreToolUseEvent: vi.fn(),
      firePostToolUseEvent: vi.fn(),
      firePostToolUseFailureEvent: vi.fn(),
      firePreCompactEvent: vi.fn(),
      fireNotificationEvent: vi.fn(),
      firePermissionRequestEvent: vi.fn(),
      fireSubagentStartEvent: vi.fn(),
      fireSubagentStopEvent: vi.fn(),
    } as unknown as HookEventHandler;

    vi.mocked(HookRegistry).mockImplementation(() => mockHookRegistry);
    vi.mocked(HookRunner).mockImplementation(() => mockHookRunner);
    vi.mocked(HookAggregator).mockImplementation(() => mockHookAggregator);
    vi.mocked(HookPlanner).mockImplementation(() => mockHookPlanner);
    vi.mocked(HookEventHandler).mockImplementation(() => mockHookEventHandler);

    hookSystem = new HookSystem(mockConfig);
  });

  describe('constructor', () => {
    it('should create instance with all dependencies', () => {
      expect(HookRegistry).toHaveBeenCalledWith(mockConfig);
      expect(HookRunner).toHaveBeenCalled();
      expect(HookAggregator).toHaveBeenCalled();
      expect(HookPlanner).toHaveBeenCalledWith(mockHookRegistry);
      expect(HookEventHandler).toHaveBeenCalledWith(
        mockConfig,
        mockHookPlanner,
        mockHookRunner,
        mockHookAggregator,
      );
    });
  });

  describe('initialize', () => {
    it('should initialize hook registry', async () => {
      await hookSystem.initialize();

      expect(mockHookRegistry.initialize).toHaveBeenCalled();
    });
  });

  describe('getEventHandler', () => {
    it('should return the hook event handler', () => {
      const eventHandler = hookSystem.getEventHandler();

      expect(eventHandler).toBe(mockHookEventHandler);
    });
  });

  describe('getRegistry', () => {
    it('should return the hook registry', () => {
      const registry = hookSystem.getRegistry();

      expect(registry).toBe(mockHookRegistry);
    });
  });

  describe('setHookEnabled', () => {
    it('should enable a hook', () => {
      hookSystem.setHookEnabled('test-hook', true);

      expect(mockHookRegistry.setHookEnabled).toHaveBeenCalledWith(
        'test-hook',
        true,
      );
    });

    it('should disable a hook', () => {
      hookSystem.setHookEnabled('test-hook', false);

      expect(mockHookRegistry.setHookEnabled).toHaveBeenCalledWith(
        'test-hook',
        false,
      );
    });
  });

  describe('getAllHooks', () => {
    it('should return all registered hooks', () => {
      const mockHooks = [
        {
          config: {
            type: HookType.Command,
            command: 'echo test',
            source: HooksConfigSource.Project,
          },
          source: HooksConfigSource.Project,
          eventName: HookEventName.PreToolUse,
          enabled: true,
        },
      ];
      vi.mocked(mockHookRegistry.getAllHooks).mockReturnValue(mockHooks);

      const hooks = hookSystem.getAllHooks();

      expect(hooks).toEqual(mockHooks);
      expect(mockHookRegistry.getAllHooks).toHaveBeenCalled();
    });
  });

  describe('fireStopEvent', () => {
    it('should fire stop event and return AggregatedHookResult', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 50,
        finalOutput: {
          continue: false,
          stopReason: 'user_stop',
        },
      };
      vi.mocked(mockHookEventHandler.fireStopEvent).mockResolvedValue(
        mockResult,
      );

      const result = await hookSystem.fireStopEvent(true, 'last message');

      expect(mockHookEventHandler.fireStopEvent).toHaveBeenCalledWith(
        true,
        'last message',
        undefined,
      );
      expect(result).toEqual(mockResult);
    });

    it('should use default parameters when not provided', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
        finalOutput: undefined,
      };
      vi.mocked(mockHookEventHandler.fireStopEvent).mockResolvedValue(
        mockResult,
      );

      await hookSystem.fireStopEvent();

      expect(mockHookEventHandler.fireStopEvent).toHaveBeenCalledWith(
        false,
        '',
        undefined,
      );
    });

    it('should return AggregatedHookResult even when no final output', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
        finalOutput: undefined,
      };
      vi.mocked(mockHookEventHandler.fireStopEvent).mockResolvedValue(
        mockResult,
      );

      const result = await hookSystem.fireStopEvent();

      expect(result).toEqual(mockResult);
      expect(result.finalOutput).toBeUndefined();
    });
  });

  describe('fireUserPromptSubmitEvent', () => {
    it('should fire UserPromptSubmit event and return output', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 50,
        finalOutput: {
          continue: true,
          decision: 'allow' as HookDecision,
        },
      };
      vi.mocked(
        mockHookEventHandler.fireUserPromptSubmitEvent,
      ).mockResolvedValue(mockResult);

      const result = await hookSystem.fireUserPromptSubmitEvent('test prompt');

      expect(
        mockHookEventHandler.fireUserPromptSubmitEvent,
      ).toHaveBeenCalledWith('test prompt', undefined);
      expect(result).toBeDefined();
    });

    it('should pass prompt to event handler', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
        finalOutput: {
          decision: 'allow' as HookDecision,
        },
      };
      vi.mocked(
        mockHookEventHandler.fireUserPromptSubmitEvent,
      ).mockResolvedValue(mockResult);

      await hookSystem.fireUserPromptSubmitEvent('my custom prompt');

      expect(
        mockHookEventHandler.fireUserPromptSubmitEvent,
      ).toHaveBeenCalledWith('my custom prompt', undefined);
    });

    it('should return undefined when no final output', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
        finalOutput: undefined,
      };
      vi.mocked(
        mockHookEventHandler.fireUserPromptSubmitEvent,
      ).mockResolvedValue(mockResult);

      const result = await hookSystem.fireUserPromptSubmitEvent('test');

      expect(result).toBeUndefined();
    });

    it('should return DefaultHookOutput with blocking decision', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 50,
        finalOutput: {
          decision: 'block' as HookDecision,
          reason: 'Blocked by policy',
        },
      };
      vi.mocked(
        mockHookEventHandler.fireUserPromptSubmitEvent,
      ).mockResolvedValue(mockResult);

      const result = await hookSystem.fireUserPromptSubmitEvent('test');

      expect(result).toBeDefined();
      expect(result?.isBlockingDecision()).toBe(true);
    });

    it('should return DefaultHookOutput with additional context', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 50,
        finalOutput: {
          decision: 'allow' as HookDecision,
          hookSpecificOutput: {
            additionalContext: 'Some additional context',
          },
        },
      };
      vi.mocked(
        mockHookEventHandler.fireUserPromptSubmitEvent,
      ).mockResolvedValue(mockResult);

      const result = await hookSystem.fireUserPromptSubmitEvent('test');

      expect(result).toBeDefined();
      expect(result?.getAdditionalContext()).toBe('Some additional context');
    });
  });

  describe('fireSessionStartEvent', () => {
    it('should fire session start event and return output', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 50,
        finalOutput: {
          continue: true,
          decision: 'allow' as HookDecision,
        },
      };
      vi.mocked(mockHookEventHandler.fireSessionStartEvent).mockResolvedValue(
        mockResult,
      );

      const result = await hookSystem.fireSessionStartEvent(
        SessionStartSource.Startup,
        'gpt-4',
      );

      expect(mockHookEventHandler.fireSessionStartEvent).toHaveBeenCalledWith(
        SessionStartSource.Startup,
        'gpt-4',
        undefined,
        undefined,
        undefined,
      );
      expect(result).toBeDefined();
    });

    it('should pass all parameters to event handler', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
        finalOutput: {
          decision: 'allow' as HookDecision,
        },
      };
      vi.mocked(mockHookEventHandler.fireSessionStartEvent).mockResolvedValue(
        mockResult,
      );

      await hookSystem.fireSessionStartEvent(
        SessionStartSource.Clear,
        'claude-3',
        PermissionMode.AutoEdit, // Using actual enum value from PermissionMode
        AgentType.Custom,
      );

      expect(mockHookEventHandler.fireSessionStartEvent).toHaveBeenCalledWith(
        SessionStartSource.Clear,
        'claude-3',
        PermissionMode.AutoEdit,
        AgentType.Custom,
        undefined,
      );
    });

    it('should return undefined when no final output', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
        finalOutput: undefined,
      };
      vi.mocked(mockHookEventHandler.fireSessionStartEvent).mockResolvedValue(
        mockResult,
      );

      const result = await hookSystem.fireSessionStartEvent(
        SessionStartSource.Startup,
        'gpt-4',
      );

      expect(result).toBeUndefined();
    });
  });

  describe('fireSessionEndEvent', () => {
    it('should fire session end event and return output', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 50,
        finalOutput: {
          continue: true,
          decision: 'allow' as HookDecision,
        },
      };
      vi.mocked(mockHookEventHandler.fireSessionEndEvent).mockResolvedValue(
        mockResult,
      );

      const result = await hookSystem.fireSessionEndEvent(
        SessionEndReason.Other,
      );

      expect(mockHookEventHandler.fireSessionEndEvent).toHaveBeenCalledWith(
        SessionEndReason.Other,
        undefined,
      );
      expect(result).toBeDefined();
    });

    it('should pass reason to event handler', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
        finalOutput: {
          decision: 'allow' as HookDecision,
        },
      };
      vi.mocked(mockHookEventHandler.fireSessionEndEvent).mockResolvedValue(
        mockResult,
      );

      await hookSystem.fireSessionEndEvent(SessionEndReason.Other);

      expect(mockHookEventHandler.fireSessionEndEvent).toHaveBeenCalledWith(
        SessionEndReason.Other,
        undefined,
      );
    });

    it('should return undefined when no final output', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
        finalOutput: undefined,
      };
      vi.mocked(mockHookEventHandler.fireSessionEndEvent).mockResolvedValue(
        mockResult,
      );

      const result = await hookSystem.fireSessionEndEvent(
        SessionEndReason.Other,
      );

      expect(result).toBeUndefined();
    });
  });

  describe('firePreToolUseEvent', () => {
    it('should fire PreToolUse event and return output', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 50,
        finalOutput: {
          continue: true,
          decision: 'allow' as HookDecision,
        },
      };
      vi.mocked(mockHookEventHandler.firePreToolUseEvent).mockResolvedValue(
        mockResult,
      );

      const result = await hookSystem.firePreToolUseEvent(
        'bash',
        { command: 'ls' },
        'toolu_test123',
        PermissionMode.AutoEdit,
      );

      expect(mockHookEventHandler.firePreToolUseEvent).toHaveBeenCalledWith(
        'bash',
        { command: 'ls' },
        'toolu_test123',
        PermissionMode.AutoEdit,
        undefined,
      );
      expect(result).toBeDefined();
    });

    it('should pass all parameters to event handler', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
        finalOutput: {
          decision: 'allow' as HookDecision,
        },
      };
      vi.mocked(mockHookEventHandler.firePreToolUseEvent).mockResolvedValue(
        mockResult,
      );

      await hookSystem.firePreToolUseEvent(
        'write_file',
        { path: '/test.txt', content: 'test' },
        'toolu_test456',
        PermissionMode.Yolo,
      );

      expect(mockHookEventHandler.firePreToolUseEvent).toHaveBeenCalledWith(
        'write_file',
        { path: '/test.txt', content: 'test' },
        'toolu_test456',
        PermissionMode.Yolo,
        undefined,
      );
    });

    it('should return undefined when no final output', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
        finalOutput: undefined,
      };
      vi.mocked(mockHookEventHandler.firePreToolUseEvent).mockResolvedValue(
        mockResult,
      );

      const result = await hookSystem.firePreToolUseEvent(
        'bash',
        { command: 'ls' },
        'toolu_test789',
        PermissionMode.Default,
      );

      expect(result).toBeUndefined();
    });

    it('should return DefaultHookOutput with deny decision', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 50,
        finalOutput: {
          decision: 'deny' as HookDecision,
          reason: 'Permission denied by policy',
        },
      };
      vi.mocked(mockHookEventHandler.firePreToolUseEvent).mockResolvedValue(
        mockResult,
      );

      const result = await hookSystem.firePreToolUseEvent(
        'bash',
        { command: 'rm -rf /' },
        'toolu_test999',
        PermissionMode.Default,
      );

      expect(result).toBeDefined();
      expect(result?.isBlockingDecision()).toBe(true);
      expect(result?.getEffectiveReason()).toBe('Permission denied by policy');
    });

    it('should return DefaultHookOutput with additional context', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 50,
        finalOutput: {
          decision: 'allow' as HookDecision,
          hookSpecificOutput: {
            additionalContext: 'Tool execution monitored for security',
          },
        },
      };
      vi.mocked(mockHookEventHandler.firePreToolUseEvent).mockResolvedValue(
        mockResult,
      );

      const result = await hookSystem.firePreToolUseEvent(
        'bash',
        { command: 'ls' },
        'toolu_test111',
        PermissionMode.Default,
      );

      expect(result).toBeDefined();
      expect(result?.getAdditionalContext()).toBe(
        'Tool execution monitored for security',
      );
    });
  });

  describe('firePostToolUseEvent', () => {
    it('should fire PostToolUse event and return output', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 50,
        finalOutput: {
          continue: true,
          decision: 'allow' as HookDecision,
        },
      };
      vi.mocked(mockHookEventHandler.firePostToolUseEvent).mockResolvedValue(
        mockResult,
      );

      const result = await hookSystem.firePostToolUseEvent(
        'bash',
        { command: 'ls' },
        { output: 'file1.txt\nfile2.txt' },
        'toolu_test123',
        PermissionMode.AutoEdit,
      );

      expect(mockHookEventHandler.firePostToolUseEvent).toHaveBeenCalledWith(
        'bash',
        { command: 'ls' },
        { output: 'file1.txt\nfile2.txt' },
        'toolu_test123',
        PermissionMode.AutoEdit,
        undefined,
      );
      expect(result).toBeDefined();
    });

    it('should pass all parameters to event handler', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
        finalOutput: {
          decision: 'allow' as HookDecision,
        },
      };
      vi.mocked(mockHookEventHandler.firePostToolUseEvent).mockResolvedValue(
        mockResult,
      );

      await hookSystem.firePostToolUseEvent(
        'read_file',
        { path: '/test.txt' },
        { content: 'file content' },
        'toolu_test456',
        PermissionMode.Plan,
      );

      expect(mockHookEventHandler.firePostToolUseEvent).toHaveBeenCalledWith(
        'read_file',
        { path: '/test.txt' },
        { content: 'file content' },
        'toolu_test456',
        PermissionMode.Plan,
        undefined,
      );
    });

    it('should return undefined when no final output', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
        finalOutput: undefined,
      };
      vi.mocked(mockHookEventHandler.firePostToolUseEvent).mockResolvedValue(
        mockResult,
      );

      const result = await hookSystem.firePostToolUseEvent(
        'bash',
        { command: 'ls' },
        { output: 'result' },
        'toolu_test789',
        PermissionMode.Default,
      );

      expect(result).toBeUndefined();
    });

    it('should return DefaultHookOutput with system message', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 50,
        finalOutput: {
          decision: 'allow' as HookDecision,
          systemMessage: 'Tool executed successfully',
        },
      };
      vi.mocked(mockHookEventHandler.firePostToolUseEvent).mockResolvedValue(
        mockResult,
      );

      const result = await hookSystem.firePostToolUseEvent(
        'bash',
        { command: 'ls' },
        { output: 'result' },
        'toolu_test999',
        PermissionMode.Default,
      );

      expect(result).toBeDefined();
      expect(result?.systemMessage).toBe('Tool executed successfully');
    });
  });

  describe('firePostToolUseFailureEvent', () => {
    it('should fire PostToolUseFailure event and return output', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 50,
        finalOutput: {
          continue: true,
          decision: 'allow' as HookDecision,
        },
      };
      vi.mocked(
        mockHookEventHandler.firePostToolUseFailureEvent,
      ).mockResolvedValue(mockResult);

      const result = await hookSystem.firePostToolUseFailureEvent(
        'toolu_test123',
        'bash',
        { command: 'invalid' },
        'Command not found',
        false,
        PermissionMode.AutoEdit,
      );

      expect(
        mockHookEventHandler.firePostToolUseFailureEvent,
      ).toHaveBeenCalledWith(
        'toolu_test123',
        'bash',
        { command: 'invalid' },
        'Command not found',
        false,
        PermissionMode.AutoEdit,
        undefined,
      );
      expect(result).toBeDefined();
    });

    it('should pass all parameters to event handler', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
        finalOutput: {
          decision: 'allow' as HookDecision,
        },
      };
      vi.mocked(
        mockHookEventHandler.firePostToolUseFailureEvent,
      ).mockResolvedValue(mockResult);

      await hookSystem.firePostToolUseFailureEvent(
        'toolu_test456',
        'write_file',
        { path: '/test.txt' },
        'Permission denied',
        true,
        PermissionMode.Yolo,
      );

      expect(
        mockHookEventHandler.firePostToolUseFailureEvent,
      ).toHaveBeenCalledWith(
        'toolu_test456',
        'write_file',
        { path: '/test.txt' },
        'Permission denied',
        true,
        PermissionMode.Yolo,
        undefined,
      );
    });

    it('should use default values for optional parameters', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
        finalOutput: undefined,
      };
      vi.mocked(
        mockHookEventHandler.firePostToolUseFailureEvent,
      ).mockResolvedValue(mockResult);

      await hookSystem.firePostToolUseFailureEvent(
        'toolu_test789',
        'bash',
        { command: 'ls' },
        'Error occurred',
      );

      expect(
        mockHookEventHandler.firePostToolUseFailureEvent,
      ).toHaveBeenCalledWith(
        'toolu_test789',
        'bash',
        { command: 'ls' },
        'Error occurred',
        undefined,
        undefined,
        undefined,
      );
    });

    it('should return undefined when no final output', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
        finalOutput: undefined,
      };
      vi.mocked(
        mockHookEventHandler.firePostToolUseFailureEvent,
      ).mockResolvedValue(mockResult);

      const result = await hookSystem.firePostToolUseFailureEvent(
        'toolu_test999',
        'bash',
        { command: 'ls' },
        'Error',
      );

      expect(result).toBeUndefined();
    });

    it('should return DefaultHookOutput with error context', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 50,
        finalOutput: {
          decision: 'allow' as HookDecision,
          hookSpecificOutput: {
            additionalContext: 'Failure due to permission issues',
          },
        },
      };
      vi.mocked(
        mockHookEventHandler.firePostToolUseFailureEvent,
      ).mockResolvedValue(mockResult);

      const result = await hookSystem.firePostToolUseFailureEvent(
        'toolu_test111',
        'bash',
        { command: 'ls' },
        'Permission denied',
      );

      expect(result).toBeDefined();
      expect(result?.getAdditionalContext()).toBe(
        'Failure due to permission issues',
      );
    });
  });

  describe('firePreCompactEvent', () => {
    it('should fire PreCompact event with auto trigger and return output', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 50,
        finalOutput: {
          continue: true,
          decision: 'allow' as HookDecision,
        },
      };
      vi.mocked(mockHookEventHandler.firePreCompactEvent).mockResolvedValue(
        mockResult,
      );

      const result = await hookSystem.firePreCompactEvent(
        PreCompactTrigger.Auto,
        '',
      );

      expect(mockHookEventHandler.firePreCompactEvent).toHaveBeenCalledWith(
        PreCompactTrigger.Auto,
        '',
        undefined,
      );
      expect(result).toBeDefined();
    });

    it('should fire PreCompact event with manual trigger', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
        finalOutput: {
          decision: 'allow' as HookDecision,
        },
      };
      vi.mocked(mockHookEventHandler.firePreCompactEvent).mockResolvedValue(
        mockResult,
      );

      await hookSystem.firePreCompactEvent(PreCompactTrigger.Manual, '');

      expect(mockHookEventHandler.firePreCompactEvent).toHaveBeenCalledWith(
        PreCompactTrigger.Manual,
        '',
        undefined,
      );
    });

    it('should pass custom instructions to event handler', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
        finalOutput: {
          decision: 'allow' as HookDecision,
        },
      };
      vi.mocked(mockHookEventHandler.firePreCompactEvent).mockResolvedValue(
        mockResult,
      );

      await hookSystem.firePreCompactEvent(
        PreCompactTrigger.Auto,
        'Custom compression instructions',
      );

      expect(mockHookEventHandler.firePreCompactEvent).toHaveBeenCalledWith(
        PreCompactTrigger.Auto,
        'Custom compression instructions',
        undefined,
      );
    });

    it('should return undefined when no final output', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
        finalOutput: undefined,
      };
      vi.mocked(mockHookEventHandler.firePreCompactEvent).mockResolvedValue(
        mockResult,
      );

      const result = await hookSystem.firePreCompactEvent(
        PreCompactTrigger.Auto,
        '',
      );

      expect(result).toBeUndefined();
    });

    it('should return DefaultHookOutput with additional context', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 50,
        finalOutput: {
          decision: 'allow' as HookDecision,
          hookSpecificOutput: {
            additionalContext: 'Context before compression',
          },
        },
      };
      vi.mocked(mockHookEventHandler.firePreCompactEvent).mockResolvedValue(
        mockResult,
      );

      const result = await hookSystem.firePreCompactEvent(
        PreCompactTrigger.Manual,
        '',
      );

      expect(result).toBeDefined();
      expect(result?.getAdditionalContext()).toBe('Context before compression');
    });
  });

  describe('fireNotificationEvent', () => {
    it('should fire Notification event and return output', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 50,
        finalOutput: {
          continue: true,
          decision: 'allow' as HookDecision,
        },
      };
      vi.mocked(mockHookEventHandler.fireNotificationEvent).mockResolvedValue(
        mockResult,
      );

      const result = await hookSystem.fireNotificationEvent(
        'Test notification message',
        NotificationType.PermissionPrompt,
        'Permission needed',
      );

      expect(mockHookEventHandler.fireNotificationEvent).toHaveBeenCalledWith(
        'Test notification message',
        NotificationType.PermissionPrompt,
        'Permission needed',
        undefined,
      );
      expect(result).toBeDefined();
    });

    it('should pass all parameters to event handler', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
        finalOutput: {
          decision: 'allow' as HookDecision,
        },
      };
      vi.mocked(mockHookEventHandler.fireNotificationEvent).mockResolvedValue(
        mockResult,
      );

      await hookSystem.fireNotificationEvent(
        'Qwen Code is waiting for your input',
        NotificationType.IdlePrompt,
        'Waiting for input',
      );

      expect(mockHookEventHandler.fireNotificationEvent).toHaveBeenCalledWith(
        'Qwen Code is waiting for your input',
        NotificationType.IdlePrompt,
        'Waiting for input',
        undefined,
      );
    });

    it('should handle notification without title', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
        finalOutput: {
          decision: 'allow' as HookDecision,
        },
      };
      vi.mocked(mockHookEventHandler.fireNotificationEvent).mockResolvedValue(
        mockResult,
      );

      await hookSystem.fireNotificationEvent(
        'Authentication successful',
        NotificationType.AuthSuccess,
      );

      expect(mockHookEventHandler.fireNotificationEvent).toHaveBeenCalledWith(
        'Authentication successful',
        NotificationType.AuthSuccess,
        undefined,
        undefined,
      );
    });

    it('should return undefined when no final output', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
        finalOutput: undefined,
      };
      vi.mocked(mockHookEventHandler.fireNotificationEvent).mockResolvedValue(
        mockResult,
      );

      const result = await hookSystem.fireNotificationEvent(
        'Test message',
        NotificationType.PermissionPrompt,
      );

      expect(result).toBeUndefined();
    });

    it('should return DefaultHookOutput with additional context', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 50,
        finalOutput: {
          decision: 'allow' as HookDecision,
          hookSpecificOutput: {
            additionalContext: 'Notification handled by custom handler',
          },
        },
      };
      vi.mocked(mockHookEventHandler.fireNotificationEvent).mockResolvedValue(
        mockResult,
      );

      const result = await hookSystem.fireNotificationEvent(
        'Test notification',
        NotificationType.IdlePrompt,
      );

      expect(result).toBeDefined();
      expect(result?.getAdditionalContext()).toBe(
        'Notification handled by custom handler',
      );
    });

    it('should handle elicitation_dialog notification type', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
        finalOutput: {
          decision: 'allow' as HookDecision,
        },
      };
      vi.mocked(mockHookEventHandler.fireNotificationEvent).mockResolvedValue(
        mockResult,
      );

      await hookSystem.fireNotificationEvent(
        'Dialog shown to user',
        NotificationType.ElicitationDialog,
        'Dialog',
      );

      expect(mockHookEventHandler.fireNotificationEvent).toHaveBeenCalledWith(
        'Dialog shown to user',
        NotificationType.ElicitationDialog,
        'Dialog',
        undefined,
      );
    });
  });

  describe('firePermissionRequestEvent', () => {
    it('should delegate to hookEventHandler.firePermissionRequestEvent', async () => {
      const mockFinalOutput = {
        hookSpecificOutput: {
          decision: {
            behavior: 'allow' as const,
          },
        },
      };
      const mockAggregated = createMockAggregatedResult(true, mockFinalOutput);

      vi.mocked(
        mockHookEventHandler.firePermissionRequestEvent,
      ).mockResolvedValue(mockAggregated);

      const result = await hookSystem.firePermissionRequestEvent(
        'Bash',
        { command: 'ls -la' },
        PermissionMode.Default,
      );

      expect(
        mockHookEventHandler.firePermissionRequestEvent,
      ).toHaveBeenCalledWith(
        'Bash',
        { command: 'ls -la' },
        PermissionMode.Default,
        undefined,
        undefined,
      );
      expect(result).toBeDefined();
      // Type assertion needed because getPermissionDecision is specific to PermissionRequestHookOutput
      const permissionResult = result as unknown as {
        getPermissionDecision: () => { behavior: string } | undefined;
      };
      expect(permissionResult.getPermissionDecision()?.behavior).toBe('allow');
    });

    it('should include permission_suggestions when provided', async () => {
      const mockAggregated = createMockAggregatedResult(true);
      const suggestions: PermissionSuggestion[] = [
        { type: 'toolAlwaysAllow', tool: 'Bash' },
      ];

      vi.mocked(
        mockHookEventHandler.firePermissionRequestEvent,
      ).mockResolvedValue(mockAggregated);

      await hookSystem.firePermissionRequestEvent(
        'Bash',
        { command: 'npm test' },
        PermissionMode.Default,
        suggestions,
      );

      expect(
        mockHookEventHandler.firePermissionRequestEvent,
      ).toHaveBeenCalledWith(
        'Bash',
        { command: 'npm test' },
        PermissionMode.Default,
        suggestions,
        undefined,
      );
    });

    it('should return undefined when hook has no finalOutput', async () => {
      const mockAggregated = createMockAggregatedResult(false);

      vi.mocked(
        mockHookEventHandler.firePermissionRequestEvent,
      ).mockResolvedValue(mockAggregated);

      const result = await hookSystem.firePermissionRequestEvent(
        'ReadFile',
        { file_path: '/test.txt' },
        PermissionMode.Plan,
      );

      expect(result).toBeUndefined();
    });

    it('should handle all permission modes correctly', async () => {
      const mockAggregated = createMockAggregatedResult(true);

      vi.mocked(
        mockHookEventHandler.firePermissionRequestEvent,
      ).mockResolvedValue(mockAggregated);

      // Test Default mode
      await hookSystem.firePermissionRequestEvent(
        'Bash',
        { command: 'test' },
        PermissionMode.Default,
      );

      // Test Plan mode
      await hookSystem.firePermissionRequestEvent(
        'Bash',
        { command: 'test' },
        PermissionMode.Plan,
      );

      // Test Yolo mode
      await hookSystem.firePermissionRequestEvent(
        'Bash',
        { command: 'test' },
        PermissionMode.Yolo,
      );

      expect(
        mockHookEventHandler.firePermissionRequestEvent,
      ).toHaveBeenCalledTimes(3);
    });

    it('should pass through hook errors', async () => {
      const mockAggregated = createMockAggregatedResult(false);
      mockAggregated.errors = [new Error('PermissionRequest hook error')];

      vi.mocked(
        mockHookEventHandler.firePermissionRequestEvent,
      ).mockResolvedValue(mockAggregated);

      const result = await hookSystem.firePermissionRequestEvent(
        'Bash',
        { command: 'test' },
        PermissionMode.Default,
      );

      expect(result).toBeUndefined();
    });
  });

  describe('fireSubagentStartEvent', () => {
    it('should fire SubagentStart event and return output', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 50,
        finalOutput: {
          decision: 'allow' as HookDecision,
        },
      };
      vi.mocked(mockHookEventHandler.fireSubagentStartEvent).mockResolvedValue(
        mockResult,
      );

      const result = await hookSystem.fireSubagentStartEvent(
        'agent-123',
        'code-reviewer',
        PermissionMode.Default,
      );

      expect(mockHookEventHandler.fireSubagentStartEvent).toHaveBeenCalledWith(
        'agent-123',
        'code-reviewer',
        PermissionMode.Default,
        undefined,
      );
      expect(result).toBeDefined();
    });

    it('should pass AgentType enum as agent type', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
        finalOutput: {
          decision: 'allow' as HookDecision,
        },
      };
      vi.mocked(mockHookEventHandler.fireSubagentStartEvent).mockResolvedValue(
        mockResult,
      );

      await hookSystem.fireSubagentStartEvent(
        'agent-456',
        AgentType.Bash,
        PermissionMode.Yolo,
      );

      expect(mockHookEventHandler.fireSubagentStartEvent).toHaveBeenCalledWith(
        'agent-456',
        AgentType.Bash,
        PermissionMode.Yolo,
        undefined,
      );
    });

    it('should return undefined when no final output', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
        finalOutput: undefined,
      };
      vi.mocked(mockHookEventHandler.fireSubagentStartEvent).mockResolvedValue(
        mockResult,
      );

      const result = await hookSystem.fireSubagentStartEvent(
        'agent-789',
        'test-agent',
        PermissionMode.Default,
      );

      expect(result).toBeUndefined();
    });

    it('should return DefaultHookOutput with additional context', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 50,
        finalOutput: {
          decision: 'allow' as HookDecision,
          hookSpecificOutput: {
            additionalContext: 'Extra context injected by SubagentStart hook',
          },
        },
      };
      vi.mocked(mockHookEventHandler.fireSubagentStartEvent).mockResolvedValue(
        mockResult,
      );

      const result = await hookSystem.fireSubagentStartEvent(
        'agent-111',
        'code-reviewer',
        PermissionMode.Default,
      );

      expect(result).toBeDefined();
      expect(result?.getAdditionalContext()).toBe(
        'Extra context injected by SubagentStart hook',
      );
    });
  });

  describe('fireSubagentStopEvent', () => {
    it('should fire SubagentStop event and return output', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 50,
        finalOutput: {
          continue: true,
          decision: 'allow' as HookDecision,
        },
      };
      vi.mocked(mockHookEventHandler.fireSubagentStopEvent).mockResolvedValue(
        mockResult,
      );

      const result = await hookSystem.fireSubagentStopEvent(
        'agent-123',
        'code-reviewer',
        '/path/to/transcript.jsonl',
        'Final output from subagent',
        false,
        PermissionMode.Default,
      );

      expect(mockHookEventHandler.fireSubagentStopEvent).toHaveBeenCalledWith(
        'agent-123',
        'code-reviewer',
        '/path/to/transcript.jsonl',
        'Final output from subagent',
        false,
        PermissionMode.Default,
        undefined,
      );
      expect(result).toBeDefined();
    });

    it('should pass all parameters to event handler', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
        finalOutput: {
          decision: 'allow' as HookDecision,
        },
      };
      vi.mocked(mockHookEventHandler.fireSubagentStopEvent).mockResolvedValue(
        mockResult,
      );

      await hookSystem.fireSubagentStopEvent(
        'agent-456',
        'qwen-tester',
        '/transcript/path.jsonl',
        'last message from agent',
        true,
        PermissionMode.Plan,
      );

      expect(mockHookEventHandler.fireSubagentStopEvent).toHaveBeenCalledWith(
        'agent-456',
        'qwen-tester',
        '/transcript/path.jsonl',
        'last message from agent',
        true,
        PermissionMode.Plan,
        undefined,
      );
    });

    it('should return undefined when no final output', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
        finalOutput: undefined,
      };
      vi.mocked(mockHookEventHandler.fireSubagentStopEvent).mockResolvedValue(
        mockResult,
      );

      const result = await hookSystem.fireSubagentStopEvent(
        'agent-789',
        'test-agent',
        '/path/transcript.jsonl',
        'output',
        false,
        PermissionMode.Default,
      );

      expect(result).toBeUndefined();
    });

    it('should return StopHookOutput with blocking decision', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 50,
        finalOutput: {
          decision: 'block' as HookDecision,
          reason: 'Output too short, continue working',
        },
      };
      vi.mocked(mockHookEventHandler.fireSubagentStopEvent).mockResolvedValue(
        mockResult,
      );

      const result = await hookSystem.fireSubagentStopEvent(
        'agent-999',
        'code-reviewer',
        '/path/transcript.jsonl',
        'short',
        false,
        PermissionMode.Default,
      );

      expect(result).toBeDefined();
      expect(result?.isBlockingDecision()).toBe(true);
      expect(result?.getEffectiveReason()).toBe(
        'Output too short, continue working',
      );
    });

    it('should return StopHookOutput with allow decision', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 50,
        finalOutput: {
          decision: 'allow' as HookDecision,
          reason: 'Output looks good',
        },
      };
      vi.mocked(mockHookEventHandler.fireSubagentStopEvent).mockResolvedValue(
        mockResult,
      );

      const result = await hookSystem.fireSubagentStopEvent(
        'agent-222',
        'code-reviewer',
        '/path/transcript.jsonl',
        'A comprehensive review of the code...',
        false,
        PermissionMode.Default,
      );

      expect(result).toBeDefined();
      expect(result?.isBlockingDecision()).toBe(false);
    });
  });
});
