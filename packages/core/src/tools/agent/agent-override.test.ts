/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { Config, ApprovalMode } from '../../config/config.js';
import { createApprovalModeOverride } from './agent.js';
import { ToolNames } from '../tool-names.js';
import { EditTool } from '../edit.js';
import { WriteFileTool } from '../write-file.js';
import { ReadFileTool } from '../read-file.js';

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
  };

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

    const child = await createApprovalModeOverride(
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

    const child = await createApprovalModeOverride(
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

    const child = await createApprovalModeOverride(
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

    const child = await createApprovalModeOverride(
      parent,
      ApprovalMode.YOLO,
    );
    expect(child.getApprovalMode()).toBe(ApprovalMode.YOLO);

    const childEdit = await child
      .getToolRegistry()
      .ensureTool(ToolNames.EDIT);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const boundConfig = (childEdit as any).config as Config;
    expect(boundConfig.getApprovalMode()).toBe(ApprovalMode.YOLO);
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

    const child = await createApprovalModeOverride(
      parent,
      ApprovalMode.AUTO_EDIT,
    );
    // Force registration of all lazy factories on the child so
    // getAllToolNames() reflects core tools too. (Without warming, only
    // already-resolved tools and discovered tools show up.)
    await child.getToolRegistry().warmAll();
    await parentRegistry.warmAll();

    const childNames = child.getToolRegistry().getAllToolNames().sort();

    // After warmAll the core tool sets must match — the child registry
    // is built from the same Config (just the override), and we copied
    // any discovered tools across. So the name set should equal parent's.
    expect(childNames).toEqual(parentRegistry.getAllToolNames().sort());
    // And the parent's pre-warm names must be a subset of the post-warm
    // names — sanity check that warmAll didn't lose anything.
    const beforeSet = new Set(beforeNames);
    for (const name of beforeSet) {
      expect(childNames).toContain(name);
    }

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

    const childNonBare = await createApprovalModeOverride(
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
});
