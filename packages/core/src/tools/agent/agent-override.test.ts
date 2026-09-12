/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  Config,
  ApprovalMode,
  deriveWorktreeConfig,
  deriveConfig,
  installSessionWorkflowRevisionWriteThrough,
  type SessionWorkflowPlanRevision,
} from '../../config/config.js';
import { isPlanModeBlocked } from '../../core/permissionFlow.js';
import type { ToolCallConfirmationDetails } from '../tools.js';
import {
  createApprovalModeOverride,
  hasRebuiltToolRegistry,
  rebuildToolRegistryOnOverride,
  TOOL_REGISTRY_REBUILT,
} from './agent.js';
import { ToolNames } from '../tool-names.js';
import { EditTool } from '../edit.js';
import { WriteFileTool } from '../write-file.js';
import { ReadFileTool } from '../read-file.js';
import { recordBlock } from '../../permissions/denialTracking.js';
import { PermissionManager } from '../../permissions/permission-manager.js';
import { DiscoveredTool } from '../tool-registry.js';
import { AgentCore } from '../../agents/runtime/agent-core.js';
import type { LlmChat } from '../../core/llm-chat.js';
import {
  EXECUTION_TOOL_NAMES,
  type ExecutionEnvironment,
} from '../../services/execution-environment.js';

/**
 * Regression: Object.create(parent) is not enough to isolate a subagent's
 * core tools. The parent's tool registry caches `EditTool` /
 * `WriteFileTool` / `ReadFileTool` instances bound at parent-init time
 * with `this.config = parent`, so any subagent that walks up the
 * prototype chain to read `getToolRegistry()` ends up invoking those
 * parent-bound tools — which then read FileReadCache / approval mode
 * from the parent rather than the subagent.
 *
 * `createApprovalModeOverride` must rebuild the registry on the override
 * Config so the core tools resolve `this.config` to the override.
 */
describe('createApprovalModeOverride bound-tool isolation', () => {
  // Use bare mode so createToolRegistry() registers only ReadFile / Edit /
  // Shell — keeps the test focused on the bound-tool path without dragging
  // in optional tools that may need extra setup (LSP, ripgrep, MCP, …).
  const baseParams = {
    cwd: '/tmp',
    targetDir: '/tmp',
    debugMode: false,
    model: 'test-model',
    usageStatisticsEnabled: false,
    bareMode: true,
    // Pin a DEFAULT baseline: these tests exercise override isolation and the
    // DEFAULT→AUTO rule strip/restore transitions, so they must not depend on
    // the constructor's default approval mode (which is now AUTO).
    approvalMode: ApprovalMode.DEFAULT,
  };

  async function createParentWithRegistry(
    parent = new Config(baseParams),
  ): Promise<Config> {
    const parentRegistry = await parent.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (parent as any).toolRegistry = parentRegistry;
    return parent;
  }

  it('registers only execution facades and delegates file access through the child environment', async () => {
    const parent = await createParentWithRegistry();
    const environment = {
      prepare: vi.fn().mockResolvedValue({
        description: 'Remote read',
        locations: [],
        params: { file_path: '/container-only.txt' },
      }),
      execute: vi.fn().mockResolvedValue({
        llmContent: 'Remote file content',
        returnDisplay: 'Remote file content',
      }),
      release: vi.fn().mockResolvedValue(undefined),
      invalidateReadCache: vi.fn().mockResolvedValue(undefined),
    } as unknown as ExecutionEnvironment;
    const base = deriveConfig(parent, {
      getExecutionEnvironment: () => environment,
    });
    const { config: child } = await createApprovalModeOverride(
      base,
      ApprovalMode.DEFAULT,
    );
    const registry = child.getToolRegistry();
    expect(registry.getAllToolNames().sort()).toEqual(
      [...EXECUTION_TOOL_NAMES, ToolNames.TOOL_SEARCH].sort(),
    );
    expect(parent.getExecutionEnvironment()).toBeUndefined();
    expect(registry).not.toBe(parent.getToolRegistry());
    await registry.warmAll();
    const read = registry.getTool(ToolNames.READ_FILE);
    const result = await read!
      .build({ file_path: '/container-only.txt' })
      .execute(new AbortController().signal);
    expect(result.llmContent).toBe('Remote file content');
    expect(environment.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: ToolNames.READ_FILE,
        params: { file_path: '/container-only.txt' },
      }),
      expect.any(AbortSignal),
    );
    expect(environment.execute).toHaveBeenCalledOnce();
    await registry.stop();
    await parent.getToolRegistry().stop();
  });

  it('discovers deferred container tools without exposing parent tools or denied tools', async () => {
    const parent = new Config({
      ...baseParams,
      eagerTools: [],
      permissions: { deny: [ToolNames.SHELL] },
    });
    const permissionManager = new PermissionManager(parent);
    permissionManager.initialize();
    vi.spyOn(parent, 'getPermissionManager').mockReturnValue(permissionManager);
    await createParentWithRegistry(parent);
    const parentRegistry = parent.getToolRegistry();
    const parentTool = new DiscoveredTool(
      parent,
      'parent_only_tool',
      'A tool discovered on the host',
      { type: 'object', properties: {} },
    );
    parentRegistry.registerPermissionDeferredFactory(
      parentTool.name,
      async () => parentTool,
    );
    await parentRegistry.ensureTool(parentTool.name);
    await parentRegistry.ensureTool(ToolNames.READ_FILE);
    const environment = {
      prepare: vi.fn(),
      execute: vi.fn(),
    } as unknown as ExecutionEnvironment;
    const base = deriveConfig(parent, {
      getExecutionEnvironment: () => environment,
    });
    const { config: child, cleanup } = await createApprovalModeOverride(
      base,
      ApprovalMode.DEFAULT,
    );
    const registry = child.getToolRegistry();
    const setTools = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(child, 'getLlmClient').mockReturnValue({ setTools } as never);

    try {
      await registry.warmAll();
      expect(
        registry.getFunctionDeclarations().map((tool) => tool.name),
      ).toEqual([ToolNames.TOOL_SEARCH]);
      expect(registry.isPermissionDeferred(ToolNames.READ_FILE)).toBe(true);
      expect(registry.isDeferredAndHidden(ToolNames.READ_FILE)).toBe(true);
      expect(registry.getAllToolNames()).not.toContain(ToolNames.SHELL);
      expect(registry.getAllToolNames()).not.toContain(parentTool.name);

      const search = registry.getTool(ToolNames.TOOL_SEARCH);
      const result = await search!
        .build({
          query: `select:${ToolNames.READ_FILE},${ToolNames.SHELL},${parentTool.name}`,
        })
        .execute(new AbortController().signal);

      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain(`"name":"${ToolNames.READ_FILE}"`);
      expect(result.llmContent).toContain(
        `Not found: ${ToolNames.SHELL}, ${parentTool.name}`,
      );
      expect(registry.isDeferredAndHidden(ToolNames.READ_FILE)).toBe(false);
      expect(
        registry.getFunctionDeclarations().map((tool) => tool.name),
      ).toEqual([ToolNames.READ_FILE, ToolNames.TOOL_SEARCH]);
      expect(parentRegistry.isDeferredAndHidden(ToolNames.READ_FILE)).toBe(
        true,
      );
      expect(parentRegistry.isDeferredAndHidden(parentTool.name)).toBe(true);
      expect(setTools).not.toHaveBeenCalled();
      expect(environment.prepare).not.toHaveBeenCalled();
      expect(environment.execute).not.toHaveBeenCalled();
    } finally {
      cleanup();
      await registry.stop();
      await parentRegistry.stop();
    }
  });

  it('declares and executes a newly discovered worker tool on the next model round', async () => {
    const parent = new Config({ ...baseParams, eagerTools: [] });
    const permissions = new PermissionManager(parent);
    permissions.initialize();
    vi.spyOn(parent, 'getPermissionManager').mockReturnValue(permissions);
    await createParentWithRegistry(parent);
    await parent.getToolRegistry().ensureTool(ToolNames.READ_FILE);
    const environment = {
      prepare: vi.fn().mockResolvedValue({
        description: 'Worker read',
        params: { file_path: '/worker-only.txt' },
        locations: [],
      }),
      permission: vi.fn().mockResolvedValue('allow'),
      execute: vi.fn().mockResolvedValue({
        llmContent: 'worker file content',
        returnDisplay: 'worker file content',
      }),
      release: vi.fn().mockResolvedValue(undefined),
      invalidateReadCache: vi.fn().mockResolvedValue(undefined),
    } as unknown as ExecutionEnvironment;
    const { config: child, cleanup } = await createApprovalModeOverride(
      deriveConfig(parent, { getExecutionEnvironment: () => environment }),
      ApprovalMode.DEFAULT,
    );
    const parentClient = vi.spyOn(parent, 'getLlmClient');
    const core = new AgentCore(
      'contained',
      child,
      { systemPrompt: '' },
      { model: 'test-model' },
      { max_turns: 3 },
    );
    const calls = [
      {
        id: 'discover',
        name: ToolNames.TOOL_SEARCH,
        args: { query: `select:${ToolNames.READ_FILE}` },
      },
      {
        id: 'read',
        name: ToolNames.READ_FILE,
        args: { file_path: '/worker-only.txt' },
      },
    ];
    let round = 0;
    const sendMessageStream = vi.fn(async function* () {
      const call = calls[round++];
      yield {
        type: 'chunk',
        value: call
          ? { functionCalls: [call] }
          : { candidates: [{ content: { parts: [{ text: 'Done' }] } }] },
      };
    });
    const chat = {
      getHistoryToolCallFingerprints: () => new Map(),
      sendMessageStream,
    } as unknown as LlmChat;
    try {
      const initialTools = await core.prepareTools();
      expect(initialTools.map((tool) => tool.name)).not.toContain(
        ToolNames.READ_FILE,
      );
      const result = await core.runReasoningLoop(
        chat,
        [],
        initialTools,
        new AbortController(),
        { maxTurns: 3 },
      );
      expect(result.turnsUsed).toBe(3);
      const requests = sendMessageStream.mock.calls as unknown as Array<
        [
          unknown,
          {
            message: unknown;
            config: {
              tools: Array<{ functionDeclarations: Array<{ name: string }> }>;
            };
          },
        ]
      >;
      expect(
        requests[0][1].config.tools[0].functionDeclarations.map(
          (tool) => tool.name,
        ),
      ).not.toContain(ToolNames.READ_FILE);
      expect(
        requests[1][1].config.tools[0].functionDeclarations.map(
          (tool) => tool.name,
        ),
      ).toContain(ToolNames.READ_FILE);
      expect(JSON.stringify(requests[2][1].message)).toContain(
        'worker file content',
      );
      expect(environment.execute).toHaveBeenCalledOnce();
      expect(parentClient).not.toHaveBeenCalled();
      expect(
        parent.getToolRegistry().isDeferredAndHidden(ToolNames.READ_FILE),
      ).toBe(true);
    } finally {
      parentClient.mockRestore();
      cleanup();
      await child.getToolRegistry().stop();
      await parent.getToolRegistry().stop();
    }
  });

  function attachFakePermissionManager(parent: Config) {
    const stripDangerousRulesForAutoMode = vi.fn();
    const restoreDangerousRules = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (parent as any).permissionManager = {
      stripDangerousRulesForAutoMode,
      restoreDangerousRules,
    };
    return { stripDangerousRulesForAutoMode, restoreDangerousRules };
  }

  it('copies the current plan-exit event before isolating approval mode', async () => {
    const parent = await createParentWithRegistry();
    parent.setApprovalMode(ApprovalMode.PLAN);
    parent.setApprovalMode(ApprovalMode.DEFAULT);

    const { config: child } = await createApprovalModeOverride(
      parent,
      ApprovalMode.AUTO_EDIT,
    );

    const childNotice = child.takePendingManualPlanExitNotice();
    const parentNotice = parent.takePendingManualPlanExitNotice();
    expect(childNotice?.version).toBe(parentNotice?.version);
    expect(childNotice?.currentMode).toBe(ApprovalMode.AUTO_EDIT);
    expect(parentNotice?.currentMode).toBe(ApprovalMode.DEFAULT);

    parent.setApprovalMode(ApprovalMode.PLAN);
    parent.setApprovalMode(ApprovalMode.DEFAULT);
    expect(child.takePendingManualPlanExitNotice()).toBeUndefined();
    expect(parent.takePendingManualPlanExitNotice()).toBeDefined();
  });

  it('returns a Config whose registry is a distinct instance from the parent', async () => {
    const parent = new Config(baseParams);
    const parentRegistry = await parent.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    // Parent's getToolRegistry() is what subagents would walk through if
    // we did NOT rebuild — make it return parentRegistry so the comparison
    // is meaningful.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (parent as any).toolRegistry = parentRegistry;

    const { config: child } = await createApprovalModeOverride(
      parent,
      ApprovalMode.AUTO_EDIT,
    );
    const childRegistry = child.getToolRegistry();

    expect(childRegistry).toBeDefined();
    expect(childRegistry).not.toBe(parentRegistry);
  });

  it('binds Edit / WriteFile / ReadFile on the override registry to the override Config, not the parent', async () => {
    const parent = new Config(baseParams);
    const parentRegistry = await parent.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (parent as any).toolRegistry = parentRegistry;

    const { config: child } = await createApprovalModeOverride(
      parent,
      ApprovalMode.AUTO_EDIT,
    );
    const childRegistry = child.getToolRegistry();

    // Force lazy factories to instantiate their tools on both registries.
    const parentEdit = await parentRegistry.ensureTool(ToolNames.EDIT);
    const childEdit = await childRegistry.ensureTool(ToolNames.EDIT);
    const parentRead = await parentRegistry.ensureTool(ToolNames.READ_FILE);
    const childRead = await childRegistry.ensureTool(ToolNames.READ_FILE);

    expect(parentEdit).toBeInstanceOf(EditTool);
    expect(childEdit).toBeInstanceOf(EditTool);
    expect(parentRead).toBeInstanceOf(ReadFileTool);
    expect(childRead).toBeInstanceOf(ReadFileTool);

    // The crux: parent-bound tool resolves to parent, child-bound tool
    // resolves to child. The parent and child are distinct Config
    // instances, so this also implies their FileReadCaches and
    // ApprovalModes are independent.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((parentEdit as any).config).toBe(parent);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((childEdit as any).config).toBe(child);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((parentRead as any).config).toBe(parent);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((childRead as any).config).toBe(child);
  });

  it('routes child tools through the child FileReadCache, not the parent', async () => {
    const parent = new Config(baseParams);
    const parentRegistry = await parent.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (parent as any).toolRegistry = parentRegistry;

    const { config: child } = await createApprovalModeOverride(
      parent,
      ApprovalMode.AUTO_EDIT,
    );
    const childRegistry = child.getToolRegistry();

    const childEdit = await childRegistry.ensureTool(ToolNames.EDIT);
    expect(childEdit).toBeInstanceOf(EditTool);

    // The bound tool's `this.config.getFileReadCache()` must resolve to
    // the child's lazy own-property cache, not the parent's. We don't
    // call EditTool's execute here (it would reach the filesystem); we
    // just observe that the cache instance the bound tool would touch
    // is the child's, not the parent's.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const boundConfig = (childEdit as any).config as Config;
    expect(boundConfig.getFileReadCache()).toBe(child.getFileReadCache());
    expect(boundConfig.getFileReadCache()).not.toBe(parent.getFileReadCache());
  });

  it('preserves the override approval mode on the bound tools', async () => {
    const parent = new Config(baseParams);
    const parentRegistry = await parent.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (parent as any).toolRegistry = parentRegistry;

    expect(parent.getApprovalMode()).toBe(ApprovalMode.DEFAULT);

    const { config: child } = await createApprovalModeOverride(
      parent,
      ApprovalMode.YOLO,
    );
    expect(child.getApprovalMode()).toBe(ApprovalMode.YOLO);

    const childEdit = await child.getToolRegistry().ensureTool(ToolNames.EDIT);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const boundConfig = (childEdit as any).config as Config;
    expect(boundConfig.getApprovalMode()).toBe(ApprovalMode.YOLO);
  });

  it('lets a plan-mode override leave plan mode without changing the parent', async () => {
    const parent = await createParentWithRegistry();

    const { config: child } = await createApprovalModeOverride(
      parent,
      ApprovalMode.PLAN,
    );

    expect(child.getApprovalMode()).toBe(ApprovalMode.PLAN);

    child.setApprovalMode(ApprovalMode.DEFAULT);

    expect(child.getApprovalMode()).toBe(ApprovalMode.DEFAULT);
    expect(parent.getApprovalMode()).toBe(ApprovalMode.DEFAULT);
  });

  it('lets an approval override above a worktree Config change mode', async () => {
    const parent = await createParentWithRegistry();
    const worktree = deriveWorktreeConfig(parent, '/tmp/worktree');
    const { config: child } = await createApprovalModeOverride(
      worktree,
      ApprovalMode.PLAN,
    );

    expect(() => worktree.setApprovalMode(ApprovalMode.DEFAULT)).toThrow(
      'Derived Configs cannot change approval mode',
    );
    expect(() => child.setApprovalMode(ApprovalMode.DEFAULT)).not.toThrow();
    expect(child.getApprovalMode()).toBe(ApprovalMode.DEFAULT);
    expect(parent.getApprovalMode()).toBe(ApprovalMode.DEFAULT);
  });

  // AgentTool's isolation path layers the approval override above a
  // deriveWorktreeConfig wrapper; both layers sit between the subagent's
  // tools and the root Config. Without the worktree layer forwarding
  // revision mutations (as AgentTool installs it), the approval
  // override's write-through would land as an OWN property on the
  // worktree wrapper and shadow the session-global revision.
  it('forwards Session Workflow revision mutations through a worktree wrapper beneath the approval override', async () => {
    const parent = new Config({
      ...baseParams,
      sessionWorkflowEnabled: true,
    });
    const parentRegistry = await parent.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (parent as any).toolRegistry = parentRegistry;
    const worktree = deriveWorktreeConfig(parent, '/tmp/worktree');
    installSessionWorkflowRevisionWriteThrough(worktree, parent);
    const { config: child } = await createApprovalModeOverride(
      worktree,
      ApprovalMode.DEFAULT,
    );

    const sentinel: SessionWorkflowPlanRevision = {
      planId: 'plan-isolated',
      sourceCallId: 'call-isolated',
      todoIds: ['t1'],
    };
    child.setSessionWorkflowPlanRevision(sentinel);
    expect(parent.getSessionWorkflowPlanRevision()).toEqual(sentinel);
    expect(Object.hasOwn(child, 'sessionWorkflowPlanRevision')).toBe(false);
    expect(Object.hasOwn(worktree, 'sessionWorkflowPlanRevision')).toBe(false);

    child.clearSessionWorkflowPlanRevision();
    expect(parent.getSessionWorkflowPlanRevision()).toBeUndefined();
    expect(Object.hasOwn(worktree, 'sessionWorkflowPlanRevision')).toBe(false);
  });

  it('stops plan-mode blocking exec tools after a child override exits plan mode', async () => {
    const parent = await createParentWithRegistry();

    const { config: child } = await createApprovalModeOverride(
      parent,
      ApprovalMode.PLAN,
    );

    child.setApprovalMode(ApprovalMode.DEFAULT);

    const execDetails = {
      type: 'exec',
    } as unknown as ToolCallConfirmationDetails;
    expect(child.getApprovalMode()).toBe(ApprovalMode.DEFAULT);
    const isPlanMode = child.getApprovalMode() === ApprovalMode.PLAN;

    expect(isPlanModeBlocked(isPlanMode, false, false, execDetails)).toBe(
      false,
    );
  });

  it('isolates child approval-mode revisions from a parent in plan mode', async () => {
    const parent = await createParentWithRegistry();
    vi.spyOn(parent, 'isTrustedFolder').mockReturnValue(true);
    parent.setApprovalMode(ApprovalMode.YOLO);
    parent.setApprovalMode(ApprovalMode.PLAN);
    const parentRevision = parent.getApprovalModeRevision();
    expect(parent.getPrePlanMode()).toBe(ApprovalMode.YOLO);

    const { config: child } = await createApprovalModeOverride(
      parent,
      ApprovalMode.PLAN,
    );

    expect(child.getPrePlanMode()).toBe(ApprovalMode.YOLO);
    expect(child.getApprovalModeRevision()).toBe(0);

    child.setApprovalMode(ApprovalMode.DEFAULT);
    child.setApprovalMode(ApprovalMode.PLAN);

    expect(child.getApprovalMode()).toBe(ApprovalMode.PLAN);
    expect(child.getApprovalModeRevision()).toBe(2);
    expect(parent.getApprovalMode()).toBe(ApprovalMode.PLAN);
    expect(parent.getApprovalModeRevision()).toBe(parentRevision);
  });

  it('starts child AUTO denial state independent from the parent', async () => {
    const parent = await createParentWithRegistry();
    parent.setAutoModeDenialState(recordBlock(parent.getAutoModeDenialState()));
    const parentDenialState = parent.getAutoModeDenialState();

    const { config: child } = await createApprovalModeOverride(
      parent,
      ApprovalMode.DEFAULT,
    );

    expect(child.getAutoModeDenialState()).toEqual({
      consecutiveBlock: 0,
      consecutiveUnavailable: 0,
      totalBlock: 0,
      totalUnavailable: 0,
    });
    expect(child.getAutoModeDenialState()).not.toBe(parentDenialState);
  });

  it('uses the parent current mode as pre-plan mode when a non-plan parent creates a plan child', async () => {
    const parent = await createParentWithRegistry();
    vi.spyOn(parent, 'isTrustedFolder').mockReturnValue(true);
    parent.setApprovalMode(ApprovalMode.AUTO_EDIT);

    const { config: child } = await createApprovalModeOverride(
      parent,
      ApprovalMode.PLAN,
    );

    expect(child.getPrePlanMode()).toBe(ApprovalMode.AUTO_EDIT);
  });

  it('restores AUTO rules when an AUTO child finishes still in AUTO mode', async () => {
    const parent = await createParentWithRegistry();
    const { stripDangerousRulesForAutoMode, restoreDangerousRules } =
      attachFakePermissionManager(parent);

    const { cleanup } = await createApprovalModeOverride(
      parent,
      ApprovalMode.AUTO,
    );

    expect(stripDangerousRulesForAutoMode).toHaveBeenCalledTimes(1);

    cleanup();
    expect(restoreDangerousRules).toHaveBeenCalledTimes(1);
  });

  it('restores AUTO rules when registry setup fails', async () => {
    const parent = await createParentWithRegistry();
    const { stripDangerousRulesForAutoMode, restoreDangerousRules } =
      attachFakePermissionManager(parent);
    vi.spyOn(parent, 'createToolRegistry').mockRejectedValue(
      new Error('registry boom'),
    );

    await expect(
      createApprovalModeOverride(parent, ApprovalMode.AUTO),
    ).rejects.toThrow('registry boom');

    expect(stripDangerousRulesForAutoMode).toHaveBeenCalledTimes(1);
    expect(restoreDangerousRules).toHaveBeenCalledTimes(1);
  });

  it('does not need cleanup restore after a child leaves AUTO mode itself', async () => {
    const parent = await createParentWithRegistry();
    const { stripDangerousRulesForAutoMode, restoreDangerousRules } =
      attachFakePermissionManager(parent);

    const { config: child, cleanup } = await createApprovalModeOverride(
      parent,
      ApprovalMode.AUTO,
    );

    expect(stripDangerousRulesForAutoMode).toHaveBeenCalledTimes(1);

    child.setApprovalMode(ApprovalMode.DEFAULT);
    expect(restoreDangerousRules).toHaveBeenCalledTimes(1);

    cleanup();
    expect(restoreDangerousRules).toHaveBeenCalledTimes(1);
  });

  it('does not restore AUTO rules on cleanup when the parent is already in AUTO mode', async () => {
    const parent = await createParentWithRegistry();
    const { stripDangerousRulesForAutoMode, restoreDangerousRules } =
      attachFakePermissionManager(parent);
    vi.spyOn(parent, 'isTrustedFolder').mockReturnValue(true);
    parent.setApprovalMode(ApprovalMode.AUTO);

    const { cleanup } = await createApprovalModeOverride(
      parent,
      ApprovalMode.AUTO,
    );

    expect(stripDangerousRulesForAutoMode).toHaveBeenCalledTimes(1);

    cleanup();
    expect(restoreDangerousRules).not.toHaveBeenCalled();
  });

  it('does not restore AUTO rules when a child leaves AUTO while the parent stays in AUTO', async () => {
    const parent = await createParentWithRegistry();
    const { stripDangerousRulesForAutoMode, restoreDangerousRules } =
      attachFakePermissionManager(parent);
    vi.spyOn(parent, 'isTrustedFolder').mockReturnValue(true);
    parent.setApprovalMode(ApprovalMode.AUTO);

    const { config: child, cleanup } = await createApprovalModeOverride(
      parent,
      ApprovalMode.AUTO,
    );

    child.setApprovalMode(ApprovalMode.DEFAULT);

    expect(stripDangerousRulesForAutoMode).toHaveBeenCalledTimes(1);
    expect(restoreDangerousRules).not.toHaveBeenCalled();

    cleanup();
    expect(restoreDangerousRules).not.toHaveBeenCalled();
  });

  it('restores the inherited permission manager when AUTO-parent mode changes throw', async () => {
    const parent = await createParentWithRegistry();
    attachFakePermissionManager(parent);
    const parentPermissionManager = parent.getPermissionManager();
    const trustSpy = vi.spyOn(parent, 'isTrustedFolder').mockReturnValue(true);
    parent.setApprovalMode(ApprovalMode.AUTO);

    const { config: child } = await createApprovalModeOverride(
      parent,
      ApprovalMode.AUTO,
    );

    trustSpy.mockReturnValue(false);

    expect(() => child.setApprovalMode(ApprovalMode.AUTO_EDIT)).toThrow(
      'Cannot enable privileged approval modes in an untrusted folder.',
    );
    expect(child.getPermissionManager()).toBe(parentPermissionManager);
    expect(
      Object.prototype.hasOwnProperty.call(child, 'permissionManager'),
    ).toBe(false);
  });

  it('restores AUTO rules when a non-AUTO child enters AUTO and finishes there', async () => {
    const parent = await createParentWithRegistry();
    const { stripDangerousRulesForAutoMode, restoreDangerousRules } =
      attachFakePermissionManager(parent);

    const { config: child, cleanup } = await createApprovalModeOverride(
      parent,
      ApprovalMode.PLAN,
    );

    child.setApprovalMode(ApprovalMode.AUTO);
    expect(stripDangerousRulesForAutoMode).toHaveBeenCalledTimes(1);

    cleanup();
    expect(restoreDangerousRules).toHaveBeenCalledTimes(1);
  });

  it('copies discovered tools from the parent registry without re-discovering', async () => {
    const parent = new Config(baseParams);
    const parentRegistry = await parent.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (parent as any).toolRegistry = parentRegistry;

    // Bare mode keeps the parent registry small; this test mostly
    // guards that copyDiscoveredToolsFrom is invoked. We verify the
    // hook is reachable by introspecting the parent registry first.
    const beforeNames = parentRegistry.getAllToolNames().sort();

    const { config: child } = await createApprovalModeOverride(
      parent,
      ApprovalMode.AUTO_EDIT,
    );
    // Force registration of all lazy factories on the child so
    // getAllToolNames() reflects core tools too. (Without warming, only
    // already-resolved tools and discovered tools show up.)
    await child.getToolRegistry().warmAll();
    await parentRegistry.warmAll();

    const childNames = child.getToolRegistry().getAllToolNames().sort();
    const topLevelOnlyTools = new Set<string>([
      ToolNames.GET_GOAL,
      ToolNames.UPDATE_GOAL,
    ]);
    const expectedChildNames = parentRegistry
      .getAllToolNames()
      .filter((name) => !topLevelOnlyTools.has(name))
      .sort();

    // The child registry copies discovered tools and rebuilds the same core
    // toolset, except for session-owned tools intentionally excluded from
    // subagent contexts.
    expect(childNames).toEqual(expectedChildNames);
    // And the parent's pre-warm names must be a subset of the post-warm
    // names — sanity check that warmAll didn't lose anything.
    const beforeSet = new Set(
      beforeNames.filter((name) => !topLevelOnlyTools.has(name)),
    );
    for (const name of beforeSet) {
      expect(childNames).toContain(name);
    }
    expect(childNames).not.toContain(ToolNames.GET_GOAL);
    expect(childNames).not.toContain(ToolNames.UPDATE_GOAL);

    // Sanity: WriteFile is registered in non-bare mode only, so bare mode
    // should NOT have it.
    expect(childNames).not.toContain(ToolNames.WRITE_FILE);

    // Spy-side check via plain reflection: ensure WriteFile import path
    // is wired correctly by switching to non-bare and re-running.
    const parentNonBare = new Config({ ...baseParams, bareMode: false });
    const parentNonBareRegistry = await parentNonBare.createToolRegistry(
      undefined,
      { skipDiscovery: true },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (parentNonBare as any).toolRegistry = parentNonBareRegistry;

    const { config: childNonBare } = await createApprovalModeOverride(
      parentNonBare,
      ApprovalMode.AUTO_EDIT,
    );
    const childNonBareWrite = await childNonBare
      .getToolRegistry()
      .ensureTool(ToolNames.WRITE_FILE);
    expect(childNonBareWrite).toBeInstanceOf(WriteFileTool);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((childNonBareWrite as any).config).toBe(childNonBare);
  });

  it('applies persisted launch flags before rebuilding the child registry', async () => {
    const parent = new Config({ ...baseParams, bareMode: false });
    const parentRegistry = await parent.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (parent as any).toolRegistry = parentRegistry;

    const { config: child } = await createApprovalModeOverride(
      parent,
      ApprovalMode.AUTO_EDIT,
      {
        persistedCliFlags: {
          bare: true,
          sandbox: null,
          screenReader: true,
          model: 'agent-model',
          maxSessionTurns: 7,
          maxToolCalls: 11,
          maxSubagentDepth: 2,
        },
      },
    );

    expect(child.getBareMode()).toBe(true);
    expect(child.getSandbox()).toBeUndefined();
    expect(child.getScreenReader()).toBe(true);
    expect(child.getModel()).toBe('agent-model');
    expect(child.getMaxSessionTurns()).toBe(7);
    expect(child.getMaxToolCalls()).toBe(11);
    // Launch-time nesting cap survives resume even when the resuming
    // session's own cap differs (codex review).
    expect(child.getMaxSubagentDepth()).toBe(2);

    await child.getToolRegistry().warmAll();
    expect(child.getToolRegistry().getAllToolNames()).not.toContain(
      ToolNames.WRITE_FILE,
    );
  });

  it('rejects fractional maxSessionTurns from persisted launch flags', async () => {
    const parent = await createParentWithRegistry();

    await expect(
      createApprovalModeOverride(parent, ApprovalMode.DEFAULT, {
        persistedCliFlags: { maxSessionTurns: 0.5 },
      }),
    ).rejects.toThrow(/maxSessionTurns: must be an integer/);
  });

  describe('TOOL_REGISTRY_REBUILT marker propagation', () => {
    // Reviewer raised a concern that
    // `Object.prototype.hasOwnProperty.call(base, 'getToolRegistry')`
    // returns false when `base` is an Object.create wrapper above the
    // rebuilt Config (e.g. `bgConfig = Object.create(agentConfig)`),
    // causing a redundant rebuild. Switching to a Symbol-keyed marker
    // fixes that because Symbol property reads walk the prototype
    // chain through normal lookup. These tests pin that contract.

    it('hasRebuiltToolRegistry returns true even when checked on an Object.create wrapper above the rebuilt Config', async () => {
      const parent = new Config(baseParams);
      const parentRegistry = await parent.createToolRegistry(undefined, {
        skipDiscovery: true,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (parent as any).toolRegistry = parentRegistry;

      const { config: upstream } = await createApprovalModeOverride(
        parent,
        ApprovalMode.AUTO_EDIT,
      );
      expect(hasRebuiltToolRegistry(upstream)).toBe(true);

      // bgConfig pattern: Object.create wrapper above the rebuilt
      // Config, with a method override layered on top.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bgWrapper = Object.create(upstream) as any;
      bgWrapper.getShouldAvoidPermissionPrompts = () => true;

      // The plain own-property check would miss this — Symbol lookup
      // doesn't.
      expect(
        Object.prototype.hasOwnProperty.call(bgWrapper, 'getToolRegistry'),
      ).toBe(false);
      expect(hasRebuiltToolRegistry(bgWrapper as Config)).toBe(true);
    });

    it('hasRebuiltToolRegistry returns false on a fresh Config and on a wrapper that was not rebuilt', () => {
      const parent = new Config(baseParams);
      expect(hasRebuiltToolRegistry(parent)).toBe(false);

      // Plain Object.create wrapper without a rebuild — must still
      // report false so the downstream caller knows it has to rebuild.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const plainWrapper = Object.create(parent) as any;
      plainWrapper.getApprovalMode = () => ApprovalMode.AUTO_EDIT;
      expect(hasRebuiltToolRegistry(plainWrapper as Config)).toBe(false);
    });

    it('rebuildToolRegistryOnOverride installs the marker and an own getToolRegistry', async () => {
      const parent = new Config(baseParams);
      const parentRegistry = await parent.createToolRegistry(undefined, {
        skipDiscovery: true,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (parent as any).toolRegistry = parentRegistry;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const override = Object.create(parent) as any;
      override.getApprovalMode = () => ApprovalMode.YOLO;
      await rebuildToolRegistryOnOverride(override as Config, parent);

      expect(
        Object.prototype.hasOwnProperty.call(override, 'getToolRegistry'),
      ).toBe(true);
      expect(
        Object.prototype.hasOwnProperty.call(override, TOOL_REGISTRY_REBUILT),
      ).toBe(true);
      expect(override[TOOL_REGISTRY_REBUILT]).toBe(true);
      expect(hasRebuiltToolRegistry(override as Config)).toBe(true);
    });
  });
});
