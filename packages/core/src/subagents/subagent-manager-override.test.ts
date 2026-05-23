/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { Config, ApprovalMode } from '../config/config.js';
import { SubagentManager } from './subagent-manager.js';
import { ToolNames } from '../tools/tool-names.js';
import { EditTool } from '../tools/edit.js';
import { ReadFileTool } from '../tools/read-file.js';
import { createApprovalModeOverride } from '../tools/agent/agent.js';

/**
 * Companion to `tools/agent/agent-override.test.ts`. Same regression:
 * Object.create(parent) by itself is not enough to isolate a subagent's
 * core tools from the parent's bound `EditTool` / `WriteFileTool` /
 * `ReadFileTool`. The subagent path (which flows through
 * `SubagentManager.createAgentHeadless` →
 * `buildSubagentContextOverride`) must rebuild the tool registry on
 * the override Config so bound tools resolve `this.config` to the
 * subagent rather than the parent — otherwise mutations executed via
 * the bound tool reach the parent's FileReadCache and silently weaken
 * prior-read enforcement.
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

  // The method is `private`. Cast via `unknown` to invoke it directly —
  // testing through the public `createAgentHeadless` pathway would also
  // work but pulls in a much larger graph (file IO, hooks, etc.).
  function callBuildOverride(
    manager: SubagentManager,
    base: Config,
  ): Promise<Config> {
    const fn = (
      manager as unknown as {
        buildSubagentContextOverride: (b: Config) => Promise<Config>;
      }
    ).buildSubagentContextOverride.bind(manager);
    return fn(base);
  }

  it('returns a Config whose registry is distinct from the parent and binds Edit/Read to the override', async () => {
    const parent = new Config(baseParams);
    const parentRegistry = await parent.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (parent as any).toolRegistry = parentRegistry;

    const manager = new SubagentManager(parent);

    const child = await callBuildOverride(manager, parent);

    expect(child).not.toBe(parent);
    expect(child.getToolRegistry()).not.toBe(parentRegistry);

    const childEdit = await child.getToolRegistry().ensureTool(ToolNames.EDIT);
    const childRead = await child
      .getToolRegistry()
      .ensureTool(ToolNames.READ_FILE);

    expect(childEdit).toBeInstanceOf(EditTool);
    expect(childRead).toBeInstanceOf(ReadFileTool);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((childEdit as any).config).toBe(child);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((childRead as any).config).toBe(child);

    // The bound tool's FileReadCache must be the child's, not the parent's.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const boundConfig = (childEdit as any).config as Config;
    expect(boundConfig.getFileReadCache()).toBe(child.getFileReadCache());
    expect(boundConfig.getFileReadCache()).not.toBe(parent.getFileReadCache());
  });

  it('parent and child caches are independent', async () => {
    const parent = new Config(baseParams);
    const parentRegistry = await parent.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (parent as any).toolRegistry = parentRegistry;

    const manager = new SubagentManager(parent);

    const child = await callBuildOverride(manager, parent);

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

  it('skips rebuild and inherits registry via prototype when an upstream wrapper has already rebuilt the registry (real-world chained-override case)', async () => {
    // This mirrors the real-world flow: agent.ts wraps the parent in
    // `createApprovalModeOverride` (which builds R1 on the wrapper),
    // then passes that wrapper — sometimes wrapped one more level in
    // `bgConfig = Object.create(agentConfig)` for the background path —
    // through `createAgentHeadless` → `buildSubagentContextOverride`.
    // We do NOT want the second layer to build a redundant R2 — that
    // would (a) waste work, (b) leak listeners on every later
    // AgentTool/SkillTool factory invocation, and (c) split the cache
    // so client-level clears target an empty R2 cache while the bound
    // tools (still in R1) keep using R1's.
    //
    // Detection is via the `TOOL_REGISTRY_REBUILT` symbol marker that
    // `createApprovalModeOverride` sets on its return value; Symbol
    // property lookup walks the prototype chain so even an Object.create
    // wrapper above the rebuilt Config is correctly recognised as
    // having an upstream rebuild.
    const parent = new Config(baseParams);
    const parentRegistry = await parent.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (parent as any).toolRegistry = parentRegistry;

    // Layer 1: actual createApprovalModeOverride (sets the marker).
    const upstreamWrapper = await createApprovalModeOverride(
      parent,
      ApprovalMode.AUTO_EDIT,
    );
    const upstreamRegistry = upstreamWrapper.getToolRegistry();

    // Layer 2: simulate `bgConfig = Object.create(agentConfig)` from
    // the background path — own properties added on this layer should
    // not hide the marker on the prototype.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bgWrapper = Object.create(upstreamWrapper) as any;
    bgWrapper.getShouldAvoidPermissionPrompts = () => true;

    const manager = new SubagentManager(parent);

    const child = await callBuildOverride(manager, bgWrapper as Config);

    // child is still a distinct instance (Object.create) so the
    // FileReadCache lazy-init still works, but its registry must
    // resolve via the prototype back to upstreamRegistry — we did not
    // build a new one.
    expect(child).not.toBe(bgWrapper);
    expect(child.getToolRegistry()).toBe(upstreamRegistry);

    // Critically: tools the model later instantiates from the registry
    // are bound to upstreamWrapper, NOT the second-layer child. That
    // is what the optimization is for — the bound tool still resolves
    // `this.config.getFileReadCache()` to upstreamWrapper's cache,
    // which is the cache the rest of the subagent execution actually
    // uses.
    const childEdit = await child.getToolRegistry().ensureTool(ToolNames.EDIT);
    expect(childEdit).toBeInstanceOf(EditTool);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((childEdit as any).config).toBe(upstreamWrapper);
  });

  it('the override approval mode (inherited via prototype) still resolves via the override Config', async () => {
    const parent = new Config(baseParams);
    const parentRegistry = await parent.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (parent as any).toolRegistry = parentRegistry;

    const manager = new SubagentManager(parent);

    const child = await callBuildOverride(manager, parent);

    // Child has no own getApprovalMode; falls through prototype to parent.
    // Verify mutating parent's mode via setter is observed by child.
    parent.setApprovalMode(ApprovalMode.AUTO_EDIT);
    expect(child.getApprovalMode()).toBe(ApprovalMode.AUTO_EDIT);

    // And the bound EditTool sees the same mode.
    const childEdit = await child.getToolRegistry().ensureTool(ToolNames.EDIT);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const boundConfig = (childEdit as any).config as Config;
    expect(boundConfig.getApprovalMode()).toBe(ApprovalMode.AUTO_EDIT);
  });
});
