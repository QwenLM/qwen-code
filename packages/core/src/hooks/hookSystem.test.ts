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
} from './types.js';
import type { Config } from '../config/config.js';

vi.mock('./hookRegistry.js');
vi.mock('./hookRunner.js');
vi.mock('./hookAggregator.js');
vi.mock('./hookPlanner.js');
vi.mock('./hookEventHandler.js');

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
    it('should fire stop event and return output', async () => {
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
      );
      expect(result).toBeDefined();
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
      vi.mocked(mockHookEventHandler.fireStopEvent).mockResolvedValue(
        mockResult,
      );

      const result = await hookSystem.fireStopEvent();

      expect(result).toBeUndefined();
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
      ).toHaveBeenCalledWith('test prompt');
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
      ).toHaveBeenCalledWith('my custom prompt');
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
      expect(result?.getEffectiveReason()).toBe(
        'Permission denied by policies',
      );
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
});
