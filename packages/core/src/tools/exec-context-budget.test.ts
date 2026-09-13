/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { ApprovalMode, Config } from '../config/config.js';
import {
  CoreToolScheduler,
  type CompletedToolCall,
} from '../core/coreToolScheduler.js';
import { MockTool } from '../test-utils/mock-tool.js';
import { ExecTool } from './exec.js';
import { ToolNames } from './tool-names.js';
import { ToolRegistry } from './tool-registry.js';

describe('exec context output budget', () => {
  it('delivers a complete long skill body through the real scheduler', async () => {
    const config = new Config({
      cwd: '/tmp',
      targetDir: '/tmp',
      model: 'test',
      embeddingModel: 'test',
      sandbox: undefined,
      debugMode: false,
      userMemory: '',
      memoryFileCount: 0,
      approvalMode: ApprovalMode.YOLO,
      codeModeOnly: true,
      disableAllHooks: true,
      truncateToolOutputThreshold: 200_000,
      toolOutputBatchBudget: 200_000,
    });
    const registry = new ToolRegistry(config);
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
    const body = 'Skill instructions that must reach the model. '.repeat(1400);
    registry.registerTool(
      new MockTool({
        name: ToolNames.SKILL,
        execute: async () => ({
          llmContent: [{ text: body }],
          returnDisplay: 'Loaded skill',
          modelOverride: 'skill-model',
        }),
      }),
    );
    registry.registerTool(new ExecTool(config));
    const completed = vi
      .fn<(calls: CompletedToolCall[]) => Promise<void>>()
      .mockResolvedValue(undefined);
    const scheduler = new CoreToolScheduler({
      config,
      onAllToolCallsComplete: completed,
      getPreferredEditor: () => undefined,
      onEditorClose: () => {},
    });
    await scheduler.schedule(
      {
        callId: 'exec-long-skill',
        name: ToolNames.EXEC,
        args: { source: 'await tools.skill({ skill: "long-skill" });' },
        isClientInitiated: false,
        prompt_id: 'long-skill-prompt',
      },
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
    const result = completed.mock.calls[0][0][0];
    expect(result.status).toBe('success');
    expect(result.response.modelOverride).toBe('skill-model');
    const output =
      result.response.responseParts[0].functionResponse?.response?.['output'];
    expect(typeof output).toBe('string');
    expect(JSON.parse((output as string).split('\n')[0]).toolResults).toEqual([
      { name: ToolNames.SKILL, args: { skill: 'long-skill' }, output: body },
    ]);
  });
});
