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
});
