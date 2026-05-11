/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { Config as ConfigImpl, ApprovalMode } from '../config/config.js';
import { AgentHeadless } from '../agents/runtime/agent-headless.js';
import { AgentTerminateMode } from '../agents/runtime/agent-types.js';
import { runForkedAgent } from './forkedAgent.js';
import { ToolNames } from '../tools/tool-names.js';
import { EditTool } from '../tools/edit.js';
import {
  hasRebuiltToolRegistry,
  TOOL_REGISTRY_REBUILT,
} from '../tools/agent/agent.js';

/**
 * Regression: `runForkedAgent` (AgentHeadless path) used to produce its
 * YOLO wrapper via `Object.create(parent) + getApprovalMode = YOLO`,
 * which left the parent's already-bound `EditTool` / `WriteFileTool` /
 * `ReadFileTool` reachable through the wrapper's prototype chain. Bound
 * tools then read `this.config.getApprovalMode()` from the parent
 * (silently ignoring the YOLO override) and `this.config.getFileReadCache()`
 * from the parent's cache.
 *
 * The fix: route through `createApprovalModeOverride`, which rebuilds
 * the tool registry on the wrapper so bound tools resolve `this.config`
 * to the wrapper.
 */
describe('runForkedAgent (AgentHeadless path) bound-tool isolation', () => {
  // Bare mode keeps the registry small (ReadFile / Edit / Shell only) so
  // the rebuild covers the file tools we actually care about.
  const baseParams = {
    cwd: '/tmp',
    targetDir: '/tmp',
    debugMode: false,
    model: 'test-model',
    usageStatisticsEnabled: false,
    bareMode: true,
  };

  // Spy on AgentHeadless.create at the source module rather than mocking
  // the re-export layer in `agents/index.js` — vitest's module-mock layer
  // doesn't reliably forward `export *` re-exports through `...actual`,
  // and stubbing the full surface manually is brittle.
  function captureAgentHeadlessConfig(): {
    captured: { config: Config | undefined };
    restore: () => void;
  } {
    const captured: { config: Config | undefined } = { config: undefined };
    const spy = vi
      .spyOn(AgentHeadless, 'create')
      .mockImplementation(
        async (
          _name: string,
          config: Config,
          ..._rest: unknown[]
        ): Promise<AgentHeadless> => {
          captured.config = config;
          return {
            execute: vi.fn().mockResolvedValue(undefined),
            getTerminateMode: vi.fn().mockReturnValue(AgentTerminateMode.GOAL),
            getFinalText: vi.fn().mockReturnValue('done'),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any;
        },
      );
    return { captured, restore: () => spy.mockRestore() };
  }

  it('passes a Config with the rebuilt-registry marker and YOLO approval mode to AgentHeadless.create', async () => {
    const parent = new ConfigImpl(baseParams);
    const parentRegistry = await parent.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (parent as any).toolRegistry = parentRegistry;

    const { captured, restore } = captureAgentHeadlessConfig();
    try {
      const result = await runForkedAgent({
        name: 'test-fork',
        systemPrompt: 'You are a test fork.',
        taskPrompt: 'do the task',
        config: parent,
      });
      expect(result.status).toBe('completed');
    } finally {
      restore();
    }

    expect(captured.config).toBeDefined();
    // The wrapper passed to AgentHeadless must:
    // 1. Have its own rebuilt registry (Symbol marker propagation)
    expect(hasRebuiltToolRegistry(captured.config!)).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((captured.config as any)[TOOL_REGISTRY_REBUILT]).toBe(true);
    // 2. Resolve approval mode to YOLO (the override)
    expect(captured.config!.getApprovalMode()).toBe(ApprovalMode.YOLO);
    // 3. Hand out a different ToolRegistry instance from the parent
    expect(captured.config!.getToolRegistry()).not.toBe(parentRegistry);
  });

  it('binds EditTool from the wrapper registry to the wrapper Config (not the parent)', async () => {
    const parent = new ConfigImpl(baseParams);
    const parentRegistry = await parent.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (parent as any).toolRegistry = parentRegistry;

    const { captured, restore } = captureAgentHeadlessConfig();
    try {
      await runForkedAgent({
        name: 'test-fork',
        systemPrompt: 'You are a test fork.',
        taskPrompt: 'do the task',
        config: parent,
      });
    } finally {
      restore();
    }

    expect(captured.config).toBeDefined();
    const wrapperRegistry = captured.config!.getToolRegistry();
    const editTool = await wrapperRegistry.ensureTool(ToolNames.EDIT);
    expect(editTool).toBeInstanceOf(EditTool);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((editTool as any).config).toBe(captured.config);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const boundConfig = (editTool as any).config as Config;
    expect(boundConfig.getApprovalMode()).toBe(ApprovalMode.YOLO);
    expect(boundConfig.getFileReadCache()).toBe(
      captured.config!.getFileReadCache(),
    );
    expect(boundConfig.getFileReadCache()).not.toBe(parent.getFileReadCache());
  });

  it('preserves an upstream getPermissionManager override (memory-scoped composition)', async () => {
    // The memory extraction / dream agent path stacks two wrappers:
    //   parent
    //     └── scopedConfig (Object.create + getPermissionManager override)
    //           └── yoloConfig (createApprovalModeOverride, sets registry + marker)
    // Bound tools must see:
    //   - approval mode = YOLO (from yoloConfig's own override)
    //   - permission manager = scopedPm (walks proto past yoloConfig to scopedConfig)
    const parent = new ConfigImpl(baseParams);
    const parentRegistry = await parent.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (parent as any).toolRegistry = parentRegistry;

    const scopedPm = { id: 'scoped-pm-marker' } as never;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scopedConfig = Object.create(parent) as any;
    scopedConfig.getPermissionManager = () => scopedPm;

    const { captured, restore } = captureAgentHeadlessConfig();
    try {
      await runForkedAgent({
        name: 'test-fork',
        systemPrompt: 'You are a test fork.',
        taskPrompt: 'do the task',
        config: scopedConfig as Config,
      });
    } finally {
      restore();
    }

    expect(captured.config).toBeDefined();
    const editTool = await captured
      .config!.getToolRegistry()
      .ensureTool(ToolNames.EDIT);
    expect(editTool).toBeInstanceOf(EditTool);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const boundConfig = (editTool as any).config as Config;
    // YOLO from yoloConfig's own override
    expect(boundConfig.getApprovalMode()).toBe(ApprovalMode.YOLO);
    // Scoped PM from scopedConfig (one prototype level up)
    expect(boundConfig.getPermissionManager?.()).toBe(scopedPm);
  });

  it('stops the per-fork ToolRegistry after the AgentHeadless body finishes', async () => {
    const parent = new ConfigImpl(baseParams);
    const parentRegistry = await parent.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (parent as any).toolRegistry = parentRegistry;

    // Wrap parent.createToolRegistry so the registry it returns to
    // `createApprovalModeOverride` carries a stop spy. The wrapper's
    // own getToolRegistry is then assigned this same instance.
    const stopSpy = vi.fn().mockResolvedValue(undefined);
    const originalCreate = parent.createToolRegistry.bind(parent);
    vi.spyOn(parent, 'createToolRegistry').mockImplementation(
      async (...args) => {
        const reg = await originalCreate(...args);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (reg as any).stop = stopSpy;
        return reg;
      },
    );

    const { restore } = captureAgentHeadlessConfig();
    try {
      await runForkedAgent({
        name: 'test-fork',
        systemPrompt: 'You are a test fork.',
        taskPrompt: 'do the task',
        config: parent,
      });
    } finally {
      restore();
    }

    // stop() is fire-and-forget inside the runForkedAgent finally —
    // it is awaited by the runtime via the resolved promise chain, so
    // by the time `await runForkedAgent` returns the stop call has
    // already started; flush microtasks for the catch handler.
    await new Promise((resolve) => setImmediate(resolve));

    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('stops the per-fork ToolRegistry even when AgentHeadless.create rejects', async () => {
    // Failure-path regression: a future refactor could accidentally
    // move the stop() out of the `finally` and onto the success path
    // while every other test still passes. This test pins that the
    // cleanup runs when `AgentHeadless.create` rejects before any
    // body executes.
    const parent = new ConfigImpl(baseParams);
    const parentRegistry = await parent.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (parent as any).toolRegistry = parentRegistry;

    const stopSpy = vi.fn().mockResolvedValue(undefined);
    const originalCreate = parent.createToolRegistry.bind(parent);
    vi.spyOn(parent, 'createToolRegistry').mockImplementation(
      async (...args) => {
        const reg = await originalCreate(...args);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (reg as any).stop = stopSpy;
        return reg;
      },
    );

    const createSpy = vi
      .spyOn(AgentHeadless, 'create')
      .mockRejectedValue(new Error('agent-headless-create-blew-up'));

    try {
      await expect(
        runForkedAgent({
          name: 'test-fork',
          systemPrompt: 'You are a test fork.',
          taskPrompt: 'do the task',
          config: parent,
        }),
      ).rejects.toThrow('agent-headless-create-blew-up');
    } finally {
      createSpy.mockRestore();
    }

    await new Promise((resolve) => setImmediate(resolve));
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('stops the per-fork ToolRegistry even when headless.execute rejects', async () => {
    // Same shape as the create-rejects test, but for the execute
    // failure path. Together they pin the lifecycle stop to the
    // `finally` block rather than any specific success branch.
    const parent = new ConfigImpl(baseParams);
    const parentRegistry = await parent.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (parent as any).toolRegistry = parentRegistry;

    const stopSpy = vi.fn().mockResolvedValue(undefined);
    const originalCreate = parent.createToolRegistry.bind(parent);
    vi.spyOn(parent, 'createToolRegistry').mockImplementation(
      async (...args) => {
        const reg = await originalCreate(...args);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (reg as any).stop = stopSpy;
        return reg;
      },
    );

    const createSpy = vi.spyOn(AgentHeadless, 'create').mockImplementation(
      async (..._args: unknown[]): Promise<AgentHeadless> =>
        ({
          execute: vi
            .fn()
            .mockRejectedValue(new Error('headless-execute-blew-up')),
          getTerminateMode: vi.fn().mockReturnValue(AgentTerminateMode.GOAL),
          getFinalText: vi.fn().mockReturnValue(''),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
    );

    try {
      await expect(
        runForkedAgent({
          name: 'test-fork',
          systemPrompt: 'You are a test fork.',
          taskPrompt: 'do the task',
          config: parent,
        }),
      ).rejects.toThrow('headless-execute-blew-up');
    } finally {
      createSpy.mockRestore();
    }

    await new Promise((resolve) => setImmediate(resolve));
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });
});
