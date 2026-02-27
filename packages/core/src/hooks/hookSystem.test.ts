/**
 * @license
 * Copyright 2026 Qwen
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
  SessionStartSource,
  SessionEndReason,
  PreCompactTrigger,
  HookType,
  HooksConfigSource,
  NotificationType,
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
      fireSessionStartEvent: vi.fn(),
      fireSessionEndEvent: vi.fn(),
      firePreCompactEvent: vi.fn(),
      fireUserPromptSubmitEvent: vi.fn(),
      fireStopEvent: vi.fn(),
      firePreToolUseEvent: vi.fn(),
      firePostToolUseEvent: vi.fn(),
      fireNotificationEvent: vi.fn(),
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
          name: 'hook1',
          config: {
            type: HookType.Command,
            command: 'echo test',
            source: HooksConfigSource.Project,
          },
          enabled: true,
        },
      ];
      vi.mocked(mockHookRegistry.getAllHooks).mockReturnValue(mockHooks);

      const hooks = hookSystem.getAllHooks();

      expect(hooks).toEqual(mockHooks);
      expect(mockHookRegistry.getAllHooks).toHaveBeenCalled();
    });
  });

  describe('fireSessionStartEvent', () => {
    it('should fire session start event and return output', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 100,
        finalOutput: {
          continue: true,
        },
      };
      vi.mocked(mockHookEventHandler.fireSessionStartEvent).mockResolvedValue(
        mockResult,
      );

      const result = await hookSystem.fireSessionStartEvent(
        SessionStartSource.Startup,
      );

      expect(mockHookEventHandler.fireSessionStartEvent).toHaveBeenCalledWith(
        SessionStartSource.Startup,
      );
      expect(result).toBeDefined();
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
        SessionStartSource.Resume,
      );

      expect(result).toBeUndefined();
    });
  });

  describe('fireSessionEndEvent', () => {
    it('should fire session end event', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 100,
      };
      vi.mocked(mockHookEventHandler.fireSessionEndEvent).mockResolvedValue(
        mockResult,
      );

      const result = await hookSystem.fireSessionEndEvent(
        SessionEndReason.Clear,
      );

      expect(mockHookEventHandler.fireSessionEndEvent).toHaveBeenCalledWith(
        SessionEndReason.Clear,
      );
      expect(result).toEqual(mockResult);
    });
  });

  describe('firePreCompactEvent', () => {
    it('should fire pre compact event', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 100,
      };
      vi.mocked(mockHookEventHandler.firePreCompactEvent).mockResolvedValue(
        mockResult,
      );

      const result = await hookSystem.firePreCompactEvent(
        PreCompactTrigger.Manual,
      );

      expect(mockHookEventHandler.firePreCompactEvent).toHaveBeenCalledWith(
        PreCompactTrigger.Manual,
      );
      expect(result).toEqual(mockResult);
    });
  });

  describe('fireUserPromptSubmitEvent', () => {
    it('should fire user prompt submit event and return output', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 50,
        finalOutput: {
          continue: true,
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

      const result = await hookSystem.fireUserPromptSubmitEvent('test prompt');

      expect(result).toBeUndefined();
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
  });

  describe('firePreToolUseEvent', () => {
    it('should fire pre tool use event and return output', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 100,
        finalOutput: {
          decision: 'allow',
        },
      };
      vi.mocked(mockHookEventHandler.firePreToolUseEvent).mockResolvedValue(
        mockResult,
      );

      const result = await hookSystem.firePreToolUseEvent('Read', {
        path: '/test.txt',
      });

      expect(mockHookEventHandler.firePreToolUseEvent).toHaveBeenCalledWith(
        'Read',
        { path: '/test.txt' },
        undefined,
      );
      expect(result).toBeDefined();
    });

    it('should include mcpContext when provided', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 100,
        finalOutput: {
          decision: 'allow',
        },
      };
      const mcpContext = {
        server_name: 'test-server',
        tool_name: 'mcp-tool',
        command: 'npx',
      };
      vi.mocked(mockHookEventHandler.firePreToolUseEvent).mockResolvedValue(
        mockResult,
      );

      await hookSystem.firePreToolUseEvent(
        'Bash',
        { command: 'ls' },
        mcpContext,
      );

      expect(mockHookEventHandler.firePreToolUseEvent).toHaveBeenCalledWith(
        'Bash',
        { command: 'ls' },
        mcpContext,
      );
    });

    it('should return undefined when error occurs', async () => {
      vi.mocked(mockHookEventHandler.firePreToolUseEvent).mockRejectedValue(
        new Error('Hook error'),
      );

      const result = await hookSystem.firePreToolUseEvent('Read', {
        path: '/test.txt',
      });

      expect(result).toBeUndefined();
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

      const result = await hookSystem.firePreToolUseEvent('Read', {});

      expect(result).toBeUndefined();
    });
  });

  describe('firePostToolUseEvent', () => {
    it('should fire post tool use event and return output', async () => {
      const mockResult = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 100,
        finalOutput: {
          decision: 'allow',
        },
      };
      vi.mocked(mockHookEventHandler.firePostToolUseEvent).mockResolvedValue(
        mockResult,
      );

      const toolResponse = {
        llmContent: 'file content',
        returnDisplay: true,
        error: null,
      };

      const result = await hookSystem.firePostToolUseEvent(
        'Read',
        { path: '/test.txt' },
        toolResponse,
      );

      expect(mockHookEventHandler.firePostToolUseEvent).toHaveBeenCalledWith(
        'Read',
        { path: '/test.txt' },
        toolResponse,
        undefined,
      );
      expect(result).toBeDefined();
    });

    it('should return undefined when error occurs', async () => {
      vi.mocked(mockHookEventHandler.firePostToolUseEvent).mockRejectedValue(
        new Error('Hook error'),
      );

      const result = await hookSystem.firePostToolUseEvent(
        'Read',
        {},
        { llmContent: null, returnDisplay: false, error: null },
      );

      expect(result).toBeUndefined();
    });
  });

  describe('fireToolNotificationEvent', () => {
    it('should fire notification event for edit type', async () => {
      vi.mocked(mockHookEventHandler.fireNotificationEvent).mockResolvedValue({
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
      });

      const confirmationDetails = {
        type: 'edit' as const,
        title: 'Edit File',
        fileName: 'test.txt',
        filePath: '/test/test.txt',
        fileDiff: 'diff',
        originalContent: 'old',
        newContent: 'new',
        isModifying: true,
      };

      await hookSystem.fireToolNotificationEvent(confirmationDetails);

      expect(mockHookEventHandler.fireNotificationEvent).toHaveBeenCalledWith(
        NotificationType.ToolPermission,
        'Tool Edit File requires editing',
        {
          type: 'edit',
          title: 'Edit File',
          fileName: 'test.txt',
          filePath: '/test/test.txt',
          fileDiff: 'diff',
          originalContent: 'old',
          newContent: 'new',
          isModifying: true,
        },
      );
    });

    it('should fire notification event for exec type', async () => {
      vi.mocked(mockHookEventHandler.fireNotificationEvent).mockResolvedValue({
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
      });

      const confirmationDetails = {
        type: 'exec' as const,
        title: 'Run Command',
        command: 'ls -la',
        rootCommand: 'ls',
      };

      await hookSystem.fireToolNotificationEvent(confirmationDetails);

      expect(mockHookEventHandler.fireNotificationEvent).toHaveBeenCalledWith(
        NotificationType.ToolPermission,
        'Tool Run Command requires execution',
        {
          type: 'exec',
          title: 'Run Command',
          command: 'ls -la',
          rootCommand: 'ls',
        },
      );
    });

    it('should fire notification event for mcp type', async () => {
      vi.mocked(mockHookEventHandler.fireNotificationEvent).mockResolvedValue({
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
      });

      const confirmationDetails = {
        type: 'mcp' as const,
        title: 'MCP Tool',
        serverName: 'test-server',
        toolName: 'mcp-tool',
        toolDisplayName: 'MCP Tool',
      };

      await hookSystem.fireToolNotificationEvent(confirmationDetails);

      expect(mockHookEventHandler.fireNotificationEvent).toHaveBeenCalledWith(
        NotificationType.ToolPermission,
        'Tool MCP Tool requires MCP',
        {
          type: 'mcp',
          title: 'MCP Tool',
          serverName: 'test-server',
          toolName: 'mcp-tool',
          toolDisplayName: 'MCP Tool',
        },
      );
    });

    it('should fire notification event for info type', async () => {
      vi.mocked(mockHookEventHandler.fireNotificationEvent).mockResolvedValue({
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
      });

      const confirmationDetails = {
        type: 'info' as const,
        title: 'Info Tool',
        prompt: 'Some prompt',
        urls: ['https://example.com'],
      };

      await hookSystem.fireToolNotificationEvent(confirmationDetails);

      expect(mockHookEventHandler.fireNotificationEvent).toHaveBeenCalledWith(
        NotificationType.ToolPermission,
        'Tool Info Tool requires information',
        {
          type: 'info',
          title: 'Info Tool',
          prompt: 'Some prompt',
          urls: ['https://example.com'],
        },
      );
    });

    it('should handle error gracefully', async () => {
      vi.mocked(mockHookEventHandler.fireNotificationEvent).mockRejectedValue(
        new Error('Notification error'),
      );

      const confirmationDetails = {
        type: 'info' as const,
        title: 'Info Tool',
        prompt: 'Some prompt',
        urls: [],
      };

      await expect(
        hookSystem.fireToolNotificationEvent(confirmationDetails),
      ).resolves.not.toThrow();
    });
  });
});
