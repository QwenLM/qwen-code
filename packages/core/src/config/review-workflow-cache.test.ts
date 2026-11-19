/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Config } from './config.js';
import type { LlmChat } from '../core/llm-chat.js';
import { PermissionManager } from '../permissions/permission-manager.js';
import { ExecTool } from '../tools/exec.js';
import { ToolNames } from '../tools/tool-names.js';
import { DiscoveredTool, ToolRegistry } from '../tools/tool-registry.js';
import { ToolSearchTool } from '../tools/tool-search.js';

describe('Workflow registration and cache continuity', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'review-workflow-cache-'));
    vi.stubEnv('QWEN_HOME', directory);
    vi.stubEnv('QWEN_CODE_ENABLE_WORKFLOWS', undefined);
    vi.stubEnv('QWEN_CODE_DISABLE_WORKFLOWS', undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it('keeps declarations stable through workflow activation and search', async () => {
    const config = new Config({
      cwd: directory,
      targetDir: directory,
      model: 'test-model',
      debugMode: false,
      codeModeOnly: true,
    });
    const permissions = new PermissionManager(config);
    permissions.initialize();
    vi.spyOn(config, 'getPermissionManager').mockReturnValue(permissions);
    const registry = new ToolRegistry(config);
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
    registry.registerTool(new ExecTool(config));
    registry.registerTool(new ToolSearchTool(config));
    const setTools = vi.fn();
    const client = config.getLlmClient();
    vi.spyOn(client, 'isInitialized').mockReturnValue(true);
    vi.spyOn(client, 'getChat').mockReturnValue({
      setTools,
    } as unknown as LlmChat);

    await client.setTools();
    const before = JSON.stringify(setTools.mock.lastCall?.[0]);
    expect(registry.getAllToolNames()).not.toContain(ToolNames.WORKFLOW);
    await config.enableReviewWorkflow();
    expect(setTools).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(setTools.mock.lastCall?.[0])).toBe(before);

    const result = await registry
      .getTool(ToolNames.TOOL_SEARCH)!
      .build({ query: 'select:workflow' })
      .execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    const declaration = String(result.llmContent).match(
      /<function>(.*?)<\/function>/s,
    )?.[1];
    expect(declaration).toBeDefined();
    expect(JSON.parse(declaration!)).toMatchObject({
      ...registry.getTool(ToolNames.WORKFLOW)!.schema,
      jsName: 'workflow',
      signature: expect.stringContaining('tools.workflow(args:'),
    });
    await client.setTools();
    expect(JSON.stringify(setTools.mock.lastCall?.[0])).toBe(before);
  });

  async function startWithWorkflowsOff(): Promise<Config> {
    const config = new Config({
      cwd: directory,
      targetDir: directory,
      model: 'test-model',
      debugMode: false,
      workflowsEnabled: false,
    });
    await config.initialize({
      skipLlmInitialization: true,
      skipFileWatching: true,
      skipMcpDiscovery: true,
      skipHooks: true,
    });
    return config;
  }

  it('reconciles Workflow against the setting and disabled list on reload', async () => {
    const config = await startWithWorkflowsOff();
    try {
      const registry = config.getToolRegistry();
      const refreshTools = vi.spyOn(config.getLlmClient(), 'setTools');
      expect(registry.getTool(ToolNames.WORKFLOW)).toBeUndefined();

      const disabled = new Set([ToolNames.WORKFLOW]);
      await config.applyWorkflowsEnabledSetting(undefined, disabled);
      expect(config.isWorkflowsEnabled()).toBe(false);
      expect(registry.hasRegisteredTool(ToolNames.WORKFLOW)).toBe(false);

      await config.applyWorkflowsEnabledSetting(undefined, new Set());
      const workflow = registry.getTool(ToolNames.WORKFLOW);
      expect(workflow?.name).toBe(ToolNames.WORKFLOW);

      await config.applyWorkflowsEnabledSetting(true, disabled);
      expect(registry.getAllToolNames()).not.toContain(ToolNames.WORKFLOW);
      expect(await registry.ensureTool(ToolNames.WORKFLOW)).toBeUndefined();
      expect(registry.getTool(ToolNames.WORKFLOW)).toBeUndefined();

      await config.applyWorkflowsEnabledSetting(true, new Set());
      expect(registry.getTool(ToolNames.WORKFLOW)).toBe(workflow);
      expect(refreshTools).toHaveBeenCalledTimes(3);
    } finally {
      await config.shutdown();
    }
  });

  it('keeps a same-name custom tool available across Workflow settings changes', async () => {
    const config = await startWithWorkflowsOff();
    try {
      const registry = config.getToolRegistry();
      const custom = new DiscoveredTool(
        config,
        ToolNames.WORKFLOW,
        'Custom discovered workflow',
        {},
      );
      registry.registerTool(custom);
      expect(registry.getAllToolNames()).toContain(ToolNames.WORKFLOW);
      expect(registry.getTool(ToolNames.WORKFLOW)).toBe(custom);

      await config.applyWorkflowsEnabledSetting(true);
      expect(registry.getTool(ToolNames.WORKFLOW)).toBe(custom);
      expect(config.isWorkflowsEnabled()).toBe(false);
    } finally {
      await config.shutdown();
    }
  });

  it('reconciles the Workflow tool after a live whole-tool permission change', async () => {
    const config = new Config({
      cwd: directory,
      targetDir: directory,
      model: 'test-model',
      debugMode: false,
      permissions: { deny: ['Workflow'] },
    });
    await config.initialize({
      skipLlmInitialization: true,
      skipFileWatching: true,
      skipMcpDiscovery: true,
      skipHooks: true,
    });
    try {
      const registry = config.getToolRegistry();
      const permissions = config.getPermissionManager()!;
      const refreshTools = vi.spyOn(config.getLlmClient(), 'setTools');
      expect(config.isWorkflowsEnabled()).toBe(false);
      expect(registry.hasRegisteredTool(ToolNames.WORKFLOW)).toBe(false);

      permissions.removePersistentRule('Workflow', 'deny');
      await config.reconcileWorkflowToolAvailability(false);
      const workflow = registry.getTool(ToolNames.WORKFLOW)!;
      expect(workflow.name).toBe(ToolNames.WORKFLOW);
      const prepared = workflow.build({ script: 'return "allowed";' });

      permissions.addPersistentRule('Workflow', 'deny');
      await config.reconcileWorkflowToolAvailability(true);
      expect(registry.getTool(ToolNames.WORKFLOW)).toBeUndefined();
      await expect(
        prepared.execute(new AbortController().signal),
      ).resolves.toMatchObject({
        error: { message: 'Workflows are disabled for this session.' },
      });

      permissions.removePersistentRule('Workflow', 'deny');
      permissions.addPersistentRule('Workflow(name:other)', 'deny');
      await config.reconcileWorkflowToolAvailability(false);
      expect(registry.getTool(ToolNames.WORKFLOW)).toBe(workflow);
      expect(refreshTools).toHaveBeenCalledTimes(3);
    } finally {
      await config.shutdown();
    }
  });
});
