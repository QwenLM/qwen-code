/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { Config, ApprovalMode, deriveConfig } from '../config/config.js';
import type { ConfigParameters } from '../config/config.js';
import { SubagentManager } from './subagent-manager.js';
import type { SubagentConfig } from './types.js';
import { ToolNames } from '../tools/tool-names.js';
import { EditTool } from '../tools/edit.js';
import { ReadFileTool } from '../tools/read-file.js';
import { createApprovalModeOverride } from '../tools/agent/agent.js';

/**
 * Companion to `tools/agent/agent-override.test.ts`. A derived child must
 * rebuild core tools so Edit/Write/Read resolve its child-local cache rather
 * than the parent's recorded reads.
 */
describe('SubagentManager.buildSubagentContextOverride bound-tool isolation', () => {
  // Bare mode keeps the registry small (ReadFile / Edit / Shell only) and
  // avoids needing extra setup for optional tools.
  const baseParams = {
    cwd: '/tmp',
    targetDir: '/tmp',
    debugMode: false,
    model: 'test-model',
    usageStatisticsEnabled: false,
    bareMode: true,
  };

  /** A bare-mode parent Config with its own tool registry installed. */
  async function createParent(extra: Partial<ConfigParameters> = {}) {
    const parent = new Config({ ...baseParams, ...extra });
    const parentRegistry = await parent.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (parent as any).toolRegistry = parentRegistry;
    return { parent, parentRegistry };
  }

  // The method is `private`. Cast via `unknown` to invoke it directly —
  // testing through the public `createAgentHeadless` pathway would also
  // work but pulls in a much larger graph (file IO, hooks, etc.).
  // Builds the child context over `base` with a `SubagentManager(parent)`.
  async function buildChild(
    parent: Config,
    base: Config = parent,
    config?: Partial<SubagentConfig>,
  ): Promise<Config> {
    const manager = new SubagentManager(parent) as unknown as {
      buildSubagentContextOverride(
        b: Config,
        c: SubagentConfig,
      ): Promise<{ context: Config }>;
    };
    const result = await manager.buildSubagentContextOverride(base, {
      name: 'test-agent',
      description: 'test',
      systemPrompt: '',
      level: 'session',
      ...config,
    });
    return result.context;
  }

  /** The Config a registry tool was constructed with. */
  const boundConfigOf = (tool: unknown) => (tool as { config: Config }).config;
  const ensureEdit = (config: Config) =>
    config.getToolRegistry().ensureTool(ToolNames.EDIT);

  it('returns a Config whose registry is distinct from the parent and binds Edit/Read to the override', async () => {
    const { parent, parentRegistry } = await createParent();
    const child = await buildChild(parent);

    expect(child).not.toBe(parent);
    expect(child.getToolRegistry()).not.toBe(parentRegistry);

    const childEdit = await ensureEdit(child);
    const childRead = await child
      .getToolRegistry()
      .ensureTool(ToolNames.READ_FILE);

    expect(childEdit).toBeInstanceOf(EditTool);
    expect(childRead).toBeInstanceOf(ReadFileTool);
    expect(boundConfigOf(childEdit)).toBe(child);
    expect(boundConfigOf(childRead)).toBe(child);

    // The bound tool's FileReadCache must be the child's, not the parent's.
    const boundConfig = boundConfigOf(childEdit);
    expect(boundConfig.getFileReadCache()).toBe(child.getFileReadCache());
    expect(boundConfig.getFileReadCache()).not.toBe(parent.getFileReadCache());
  });

  it('parent and child caches are independent', async () => {
    const { parent } = await createParent();
    const child = await buildChild(parent);

    // Record a read on parent. Child must not see it.
    const fakeStats = {
      dev: 1,
      ino: 100,
      mtimeMs: 1_000_000,
      size: 42,
    } as unknown as import('node:fs').Stats;
    parent.getFileReadCache().recordRead('/tmp/parent.ts', fakeStats, {
      full: true,
      cacheable: true,
    });

    expect(parent.getFileReadCache().size()).toBe(1);
    expect(child.getFileReadCache().size()).toBe(0);
  });

  it('skips rebuild and inherits registry when an upstream derived wrapper already rebuilt it', async () => {
    const { parent } = await createParent();
    // Layer 1: actual createApprovalModeOverride (sets the marker).
    const { config: upstreamWrapper } = await createApprovalModeOverride(
      parent,
      ApprovalMode.AUTO_EDIT,
    );
    const upstreamRegistry = upstreamWrapper.getToolRegistry();
    // Layer 2: add the background prompt policy through the factory.
    const bgWrapper = deriveConfig(upstreamWrapper, {
      getShouldAvoidPermissionPrompts: () => true,
    });

    const child = await buildChild(parent, bgWrapper as Config);

    // The child is distinct, but the rebuilt registry remains inherited from
    // the approval profile so no duplicate registry lifecycle is created.
    expect(child).not.toBe(bgWrapper);
    expect(child.getToolRegistry()).toBe(upstreamRegistry);
    const childEdit = await ensureEdit(child);
    expect(childEdit).toBeInstanceOf(EditTool);
    expect(boundConfigOf(childEdit)).toBe(upstreamWrapper);
  });

  it('the override approval mode (inherited via prototype) still resolves via the override Config', async () => {
    const { parent } = await createParent();
    const child = await buildChild(parent);

    // Child has no own getApprovalMode; falls through prototype to parent.
    // Verify mutating parent's mode via setter is observed by child.
    parent.setApprovalMode(ApprovalMode.AUTO_EDIT);
    expect(child.getApprovalMode()).toBe(ApprovalMode.AUTO_EDIT);

    // And the bound EditTool sees the same mode.
    const boundConfig = boundConfigOf(await ensureEdit(child));
    expect(boundConfig.getApprovalMode()).toBe(ApprovalMode.AUTO_EDIT);
  });

  describe('per-agent mcpServers override', () => {
    it('exposes session + agent servers via getMcpServers, with agent winning on key collision', async () => {
      const { parent } = await createParent();
      // Pre-seed a session-level MCP server so the merge has something to
      // shadow. addMcpServers must be called before initialization, which
      // bareMode skips for us.
      parent.addMcpServers({
        'session-only': { type: 'stdio', command: 'node-a' } as never,
        shared: { type: 'stdio', command: 'session-version' } as never,
      });

      const child = await buildChild(parent, parent, {
        mcpServers: {
          'agent-only': { type: 'stdio', command: 'node-b' },
          shared: { type: 'stdio', command: 'agent-version' },
        },
      });

      const merged = child.getMcpServers();
      expect(Object.keys(merged ?? {}).sort()).toEqual([
        'agent-only',
        'session-only',
        'shared',
      ]);
      // Agent wins on collision (CC `scope: 'agent'` semantics).
      expect((merged?.['shared'] as { command: string }).command).toBe(
        'agent-version',
      );
      // Session server passes through unchanged.
      expect((merged?.['session-only'] as { command: string }).command).toBe(
        'node-a',
      );
    });

    it('leaves getMcpServers untouched when no per-agent servers are declared', async () => {
      const { parent } = await createParent();
      parent.addMcpServers({
        'session-only': { type: 'stdio', command: 'node' } as never,
      });
      const child = await buildChild(parent);
      // Child has no own getMcpServers; prototype resolves to parent's.
      expect(child.getMcpServers()).toEqual(parent.getMcpServers());
    });
  });

  describe('Session Workflow revision write-through', () => {
    async function createWorkflowParent(): Promise<Config> {
      const { parent } = await createParent({ sessionWorkflowEnabled: true });
      parent.setSessionWorkflowPlanRevision({
        planId: 'plan-approved',
        sourceCallId: 'call-approved',
        todoIds: ['a', 'b', 'c'],
      });
      expect(parent.isSessionWorkflowTodoContextActive()).toBe(true);
      return parent;
    }

    it('routes revision mutations from a subagent context wrapper to the base Config', async () => {
      const parent = await createWorkflowParent();
      const child = await buildChild(parent);

      // A divergent todo_write inside the subagent holds the wrapper as
      // this.config and clears the approved revision. The prototype
      // implementation assigns this.sessionWorkflowPlanRevision, which
      // without a shim lands as an own property on the wrapper and never
      // reaches the session-global base Config.
      child.clearSessionWorkflowPlanRevision();
      expect(parent.getSessionWorkflowPlanRevision()).toBeUndefined();
      expect(parent.isSessionWorkflowTodoContextActive()).toBe(false);

      // And a bind through the wrapper lands on the base too.
      child.setSessionWorkflowPlanRevision({
        planId: 'plan-child',
        sourceCallId: 'call-child',
        todoIds: ['d'],
      });
      expect(parent.getSessionWorkflowPlanRevision()?.planId).toBe(
        'plan-child',
      );
    });

    it('writes through the full chained override stack (approval override + background wrapper)', async () => {
      // Real-world launch stack: agent.ts wraps the parent in
      // createApprovalModeOverride, the background path wraps that in
      // Object.create(agentConfig), and createAgentHeadless wraps again via
      // buildSubagentContextOverride. Every layer must forward revision
      // mutations down to the base Config.
      const parent = await createWorkflowParent();
      const { config: upstreamWrapper } = await createApprovalModeOverride(
        parent,
        ApprovalMode.AUTO_EDIT,
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bgWrapper = Object.create(upstreamWrapper) as any;
      bgWrapper.getShouldAvoidPermissionPrompts = () => true;

      const child = await buildChild(parent, bgWrapper as Config);

      child.clearSessionWorkflowPlanRevision();
      expect(parent.getSessionWorkflowPlanRevision()).toBeUndefined();
      expect(parent.isSessionWorkflowTodoContextActive()).toBe(false);

      child.setSessionWorkflowPlanRevision({
        planId: 'plan-chained',
        sourceCallId: 'call-chained',
        todoIds: ['x', 'y'],
      });
      expect(parent.getSessionWorkflowPlanRevision()?.planId).toBe(
        'plan-chained',
      );
    });
  });
});
