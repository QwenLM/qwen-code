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
import { HookType, HooksConfigSource, HookEventName } from './types.js';
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
});
