/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Config, type ConfigParameters } from './config.js';
import type { LlmChat } from '../core/llm-chat.js';
import { PermissionManager } from '../permissions/permission-manager.js';
import { ToolMode } from '../tools/code-mode.js';
import { ExecTool } from '../tools/exec.js';
import { ToolNames } from '../tools/tool-names.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { ToolSearchTool } from '../tools/tool-search.js';

describe('review workflow cache continuity', () => {
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

  function setup(
    overrides: Partial<ConfigParameters>,
    searchAvailable: boolean,
  ) {
    const config = new Config({
      cwd: directory,
      targetDir: directory,
      model: 'test-model',
      debugMode: false,
      codeModeOnly: true,
      ...overrides,
    });
    const permissions = new PermissionManager(config);
    permissions.initialize();
    vi.spyOn(config, 'getPermissionManager').mockReturnValue(permissions);
    const registry = new ToolRegistry(config);
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
    registry.registerTool(new ExecTool(config));
    if (searchAvailable) registry.registerTool(new ToolSearchTool(config));
    const setTools = vi.fn();
    const client = config.getLlmClient();
    vi.spyOn(client, 'isInitialized').mockReturnValue(true);
    vi.spyOn(client, 'getChat').mockReturnValue({
      setTools,
      getHistory: () => [],
    } as unknown as LlmChat);
    return { config, registry, client, setTools };
  }

  it.each<{
    name: string;
    config: Partial<ConfigParameters>;
    search: boolean;
    stable: boolean;
  }>([
    { name: 'default Code Mode', config: {}, search: true, stable: true },
    {
      name: 'empty eager list',
      config: { eagerTools: [] },
      search: true,
      stable: true,
    },
    {
      name: 'explicit eager workflow',
      config: { eagerTools: ['workflow'] },
      search: true,
      stable: false,
    },
    {
      name: 'explicit visible workflow',
      config: { visibleTools: ['workflow'] },
      search: true,
      stable: false,
    },
    { name: 'no search fallback', config: {}, search: false, stable: false },
    {
      name: 'direct mode',
      config: { codeModeOnly: false },
      search: true,
      stable: false,
    },
  ])(
    '$name preserves its declaration policy on activation',
    async (scenario) => {
      const { config, registry, client, setTools } = setup(
        scenario.config,
        scenario.search,
      );
      await client.setTools();
      const before = JSON.stringify(setTools.mock.lastCall?.[0]);
      expect(registry.getAllToolNames()).not.toContain(ToolNames.WORKFLOW);

      await config.enableReviewWorkflow();
      expect(config.isWorkflowsEnabled()).toBe(true);
      expect(setTools).toHaveBeenCalledTimes(2);
      const after = JSON.stringify(setTools.mock.lastCall?.[0]);
      expect(after === before).toBe(scenario.stable);
      expect(registry.getTool(ToolNames.WORKFLOW)).toBeDefined();
      if (config.getToolMode() === ToolMode.CodeModeOnly) {
        expect(after.includes('tools.workflow(args:')).toBe(!scenario.stable);
        expect(registry.getCodeModeBindingPlan().bindings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: ToolNames.WORKFLOW }),
          ]),
        );
      }

      if (scenario.stable) {
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
      }

      await config.enableReviewWorkflow();
      expect(JSON.stringify(setTools.mock.lastCall?.[0])).toBe(after);
    },
  );
});
