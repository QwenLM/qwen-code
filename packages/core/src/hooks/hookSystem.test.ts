/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HookSystem, createHookSystem } from './hookSystem.js';
import type { HookRegistry} from './registry.js';
import { createHookRegistry } from './registry.js';
import type { HookRunner} from './runner.js';
import { createHookRunner } from './runner.js';
import type { HookPlanner} from './planner.js';
import { createHookPlanner } from './planner.js';
import { HookEventName, HookType, DefaultHookOutput } from './types.js';
import type { HookExecutionResult, HookDefinition } from './types.js';
import type { HookMessageBus } from './messageBusHandler.js';

// Mock dependencies
vi.mock('./messageBusHandler.js', () => ({
  createMessageBusHookEventHandler: vi.fn().mockReturnValue({
    initialize: vi.fn(),
    handleRequest: vi.fn(),
    getStats: vi.fn().mockReturnValue({
      requestChannel: 'HOOK_EXECUTION_REQUEST',
      responseChannel: 'HOOK_EXECUTION_RESPONSE',
      telemetryChannel: 'HOOK_TELEMETRY',
      telemetryEnabled: false,
    }),
  }),
}));

describe('HookSystem', () => {
  let system: HookSystem;
  let registry: HookRegistry;
  let runner: HookRunner;
  let planner: HookPlanner;
  let mockRun: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registry = createHookRegistry();
    mockRun = vi.fn();
    runner = {
      run: mockRun,
      updateConfig: vi.fn(),
      getConfig: vi.fn().mockReturnValue({}),
    } as unknown as HookRunner;
    planner = createHookPlanner();

    system = new HookSystem(registry, runner, planner);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initialize', () => {
    it('should initialize the system', async () => {
      await system.initialize();
      expect(system.isInitialized()).toBe(true);
    });

    it('should load definitions from config', async () => {
      const definitions: HookDefinition[] = [
        {
          matcher: 'WriteFile',
          hooks: [{ type: HookType.Command, command: 'test-hook' }],
        },
      ];

      const systemWithDefs = new HookSystem(registry, runner, planner, {
        definitions,
      });

      await systemWithDefs.initialize();
      expect(registry.count).toBe(1);
    });

    it('should update runner timeout from config', async () => {
      const systemWithTimeout = new HookSystem(registry, runner, planner, {
        defaultTimeout: 60000,
      });

      await systemWithTimeout.initialize();
      expect(runner.updateConfig).toHaveBeenCalledWith({
        defaultTimeout: 60000,
      });
    });

    it('should initialize message bus handler if message bus provided', async () => {
      const mockMessageBus: HookMessageBus = {
        request: vi.fn(),
        publish: vi.fn(),
      };

      const systemWithBus = new HookSystem(registry, runner, planner, {
        messageBus: mockMessageBus,
      });

      await systemWithBus.initialize();
      expect(systemWithBus.getEventHandler()).toBeDefined();
    });

    it('should not re-initialize if already initialized', async () => {
      await system.initialize();
      const spy = vi.spyOn(registry, 'register');
      await system.initialize();
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('isEnabled', () => {
    it('should return false when no hooks registered', () => {
      expect(system.isEnabled()).toBe(false);
    });

    it('should return true when hooks are registered', async () => {
      registry.register({
        matcher: 'WriteFile',
        hooks: [{ type: HookType.Command, command: 'test-hook' }],
      });

      await system.initialize();
      expect(system.isEnabled()).toBe(true);
    });

    it('should respect enabled config', () => {
      const enabledSystem = new HookSystem(registry, runner, planner, {
        enabled: true,
      });
      expect(enabledSystem.isEnabled()).toBe(true);
    });
  });

  describe('getState', () => {
    it('should return current state', async () => {
      registry.register({
        matcher: 'WriteFile',
        hooks: [
          { type: HookType.Command, command: 'hook1' },
          { type: HookType.Command, command: 'hook2' },
        ],
      });

      await system.initialize();
      const state = system.getState();

      expect(state.initialized).toBe(true);
      expect(state.enabled).toBe(true);
      expect(state.definitionCount).toBe(1);
      expect(state.hookConfigCount).toBe(2);
    });
  });

  describe('executeHooks', () => {
    const mockInput = {
      session_id: 'test-session',
      transcript_path: '/test/transcript',
      cwd: '/test',
      hook_event_name: 'PreToolUse' as const,
      timestamp: '2024-01-01T00:00:00Z',
    };

    it('should return empty array when hooks not enabled', async () => {
      const results = await system.executeHooks(
        HookEventName.PreToolUse,
        mockInput,
      );
      expect(results).toEqual([]);
    });

    it('should execute matching hooks', async () => {
      registry.register({
        matcher: 'WriteFile',
        hooks: [{ type: HookType.Command, command: 'test-hook' }],
      });

      const mockResult: HookExecutionResult = {
        hookConfig: { type: HookType.Command, command: 'test-hook' },
        eventName: HookEventName.PreToolUse,
        success: true,
        output: new DefaultHookOutput({ decision: 'allow' }),
        stdout: '',
        stderr: '',
        exitCode: 0,
        duration: 100,
      };

      mockRun.mockResolvedValue(mockResult);
      await system.initialize();

      const results = await system.executeHooks(
        HookEventName.PreToolUse,
        mockInput,
        {
          toolName: 'WriteFile',
        },
      );

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
    });

    it('should handle sequential execution with early termination', async () => {
      registry.register({
        matcher: 'WriteFile',
        sequential: true,
        hooks: [
          { type: HookType.Command, command: 'hook1' },
          { type: HookType.Command, command: 'hook2' },
        ],
      });

      const mockResult: HookExecutionResult = {
        hookConfig: { type: HookType.Command, command: 'hook1' },
        eventName: HookEventName.PreToolUse,
        success: true,
        output: new DefaultHookOutput({ decision: 'block' }),
        stdout: '',
        stderr: '',
        exitCode: 0,
        duration: 50,
      };

      mockRun.mockResolvedValue(mockResult);
      await system.initialize();

      const results = await system.executeHooks(
        HookEventName.PreToolUse,
        mockInput,
        {
          toolName: 'WriteFile',
        },
      );

      expect(results).toHaveLength(1);
      expect(mockRun).toHaveBeenCalledTimes(1);
    });

    it('should handle parallel execution', async () => {
      registry.register({
        matcher: 'WriteFile',
        hooks: [
          { type: HookType.Command, command: 'hook1' },
          { type: HookType.Command, command: 'hook2' },
        ],
      });

      const mockResults: HookExecutionResult[] = [
        {
          hookConfig: { type: HookType.Command, command: 'hook1' },
          eventName: HookEventName.PreToolUse,
          success: true,
          output: new DefaultHookOutput(),
          stdout: '',
          stderr: '',
          exitCode: 0,
          duration: 50,
        },
        {
          hookConfig: { type: HookType.Command, command: 'hook2' },
          eventName: HookEventName.PreToolUse,
          success: true,
          output: new DefaultHookOutput(),
          stdout: '',
          stderr: '',
          exitCode: 0,
          duration: 60,
        },
      ];

      mockRun
        .mockResolvedValueOnce(mockResults[0])
        .mockResolvedValueOnce(mockResults[1]);
      await system.initialize();

      const results = await system.executeHooks(
        HookEventName.PreToolUse,
        mockInput,
        {
          toolName: 'WriteFile',
        },
      );

      expect(results).toHaveLength(2);
    });
  });

  describe('updateConfig', () => {
    it('should update configuration', async () => {
      await system.initialize();
      system.updateConfig({ defaultTimeout: 30000 });

      expect(runner.updateConfig).toHaveBeenCalledWith({
        defaultTimeout: 30000,
      });
    });

    it('should initialize message bus handler when message bus is added', async () => {
      await system.initialize();
      expect(system.getEventHandler()).toBeUndefined();

      const mockMessageBus: HookMessageBus = {
        request: vi.fn(),
        publish: vi.fn(),
      };

      system.updateConfig({ messageBus: mockMessageBus });
      expect(system.getEventHandler()).toBeDefined();
    });
  });

  describe('shutdown', () => {
    it('should shutdown the system', async () => {
      await system.initialize();
      expect(system.isInitialized()).toBe(true);

      await system.shutdown();
      expect(system.isInitialized()).toBe(false);
      expect(system.getEventHandler()).toBeUndefined();
    });
  });

  describe('sendRequest', () => {
    it('should return undefined if no event handler', async () => {
      await system.initialize();
      const result = await system.sendRequest({
        type: 'HOOK_EXECUTION_REQUEST',
        requestId: 'req-123',
        eventName: HookEventName.PreToolUse,
        sessionId: 'session-123',
        cwd: '/test',
        transcriptPath: '/test/transcript',
        timestamp: '2024-01-01T00:00:00Z',
        input: {
          session_id: 'session-123',
          transcript_path: '/test/transcript',
          cwd: '/test',
          hook_event_name: 'PreToolUse',
          timestamp: '2024-01-01T00:00:00Z',
        },
      });

      expect(result).toBeUndefined();
    });
  });

  describe('getters', () => {
    it('should return registry', () => {
      expect(system.getRegistry()).toBe(registry);
    });

    it('should return runner', () => {
      expect(system.getRunner()).toBe(runner);
    });

    it('should return planner', () => {
      expect(system.getPlanner()).toBe(planner);
    });

    it('should return config', async () => {
      const config = { enabled: true, defaultTimeout: 5000 };
      const systemWithConfig = new HookSystem(
        registry,
        runner,
        planner,
        config,
      );

      expect(systemWithConfig.getConfig()).toEqual(config);
    });
  });
});

describe('createHookSystem', () => {
  it('should create a hook system with default components', async () => {
    const system = await createHookSystem();

    expect(system).toBeInstanceOf(HookSystem);
    expect(system.isInitialized()).toBe(true);
    expect(system.getRegistry()).toBeDefined();
    expect(system.getRunner()).toBeDefined();
    expect(system.getPlanner()).toBeDefined();
  });

  it('should use provided components', async () => {
    const registry = createHookRegistry();
    const runner = createHookRunner();
    const planner = createHookPlanner();

    const system = await createHookSystem({
      components: { registry, runner, planner },
    });

    expect(system.getRegistry()).toBe(registry);
    expect(system.getRunner()).toBe(runner);
    expect(system.getPlanner()).toBe(planner);
  });

  it('should pass config to system', async () => {
    const definitions: HookDefinition[] = [
      {
        matcher: 'WriteFile',
        hooks: [{ type: HookType.Command, command: 'test' }],
      },
    ];

    const system = await createHookSystem({
      config: { definitions, enabled: true },
    });

    expect(system.isEnabled()).toBe(true);
    expect(system.getRegistry().count).toBe(1);
  });
});
