/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Part } from '@google/genai';
import { ApprovalMode, Config } from '../config/config.js';
import { convertToFunctionResponse } from '../core/coreToolScheduler.js';
import type { ToolCallResponseInfo } from '../core/turn.js';
import { MockTool } from '../test-utils/mock-tool.js';
import { ExecTool } from './exec.js';
import { ToolRegistry } from './tool-registry.js';
import { ToolNames } from './tool-names.js';
import {
  runWithToolCallRuntime,
  type ToolCallRuntimeContext,
} from '../code-mode/tool-call-runtime.js';
import type { ToolResult } from './tools.js';

function setup(
  name: string,
  result: Partial<ToolCallResponseInfo>,
  body: string | Part[],
) {
  const config = new Config({
    cwd: '/tmp',
    targetDir: '/tmp',
    model: 'test',
    embeddingModel: 'test',
    sandbox: undefined,
    debugMode: false,
    userMemory: '',
    memoryFileCount: 0,
    approvalMode: ApprovalMode.DEFAULT,
    codeModeOnly: true,
  });
  const registry = new ToolRegistry(config);
  vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
  registry.registerTool(new MockTool({ name }));
  registry.registerTool(new MockTool({ name: ToolNames.WRITE_FILE }));
  const dispatch = vi.fn<ToolCallRuntimeContext['dispatch']>(
    async (name, _args, _signal, onResult) => {
      const response: ToolCallResponseInfo = {
        callId: 'nested',
        responseParts: convertToFunctionResponse(name, 'nested', body),
        resultDisplay: '',
        error: undefined,
        errorType: undefined,
        ...result,
      };
      onResult?.(response);
      if (response.error) throw response.error;
      return {
        callId: 'nested',
        name,
        status: 'success',
        output:
          typeof body === 'string' ? body : 'Untrusted app screenshot context',
        content:
          typeof body === 'string'
            ? undefined
            : [
                {
                  type: 'image',
                  mimeType: 'image/png',
                  data: 'A'.repeat(100_000),
                },
              ],
      };
    },
  );
  const run = (source: string, signal = new AbortController().signal) =>
    runWithToolCallRuntime({ parentCallId: 'exec-test', dispatch }, () =>
      new ExecTool(config).build({ source }).execute(signal),
    );
  return { run, dispatch, registry };
}

function payload(result: ToolResult) {
  const body = result.llmContent;
  const text = typeof body === 'string' ? body : (body as Part[])[0].text!;
  return JSON.parse(text.split('\n')[0]) as {
    status: string;
    outputs: string[];
    error?: string;
    toolResults: Array<{
      name: string;
      args: Record<string, unknown>;
      output: string;
    }>;
  };
}

describe('exec context tool results', () => {
  it.each([false, true])(
    'retains skill instructions without text(), including later failure: %s',
    async (fail) => {
      const body = 'skill instruction '.repeat(4000);
      const { run } = setup(
        ToolNames.SKILL,
        { modelOverride: 'skill-model' },
        body,
      );
      const result = await run(
        `await tools.skill({skill: 'test'}); ${fail ? 'throw new Error("later failure");' : ''}`,
      );
      expect(payload(result).toolResults).toEqual([
        { name: 'skill', args: { skill: 'test' }, output: body },
      ]);
      expect(JSON.stringify(result.llmContent)).toContain(
        fail ? 'later failure' : 'completed successfully',
      );
      expect(result.modelOverride).toBe('skill-model');
      expect(result.error).toBeUndefined();
    },
  );

  it('preserves an explicit undefined model override', async () => {
    const { run } = setup(
      ToolNames.SKILL,
      { modelOverride: undefined },
      'skill body',
    );
    const result = await run("await tools.skill({skill: 'test'});");
    expect(Object.hasOwn(result, 'modelOverride')).toBe(true);
    expect(result.modelOverride).toBeUndefined();
  });

  it('retains screenshot images as native parts outside JavaScript text output', async () => {
    const data = 'A'.repeat(100_000);
    const { run } = setup('capture_screen_context', {}, [
      { text: 'Untrusted app screenshot context' },
      { inlineData: { mimeType: 'image/png', data } },
    ]);
    const result = await run('text(await tools.capture_screen_context({}));');
    expect(payload(result).toolResults[0].output).toBe(
      'Untrusted app screenshot context',
    );
    expect(result.llmContent).toEqual([
      expect.objectContaining({ text: expect.not.stringContaining(data) }),
      { inlineData: { mimeType: 'image/png', data } },
    ]);
    expect(JSON.stringify(result.llmContent)).toContain(
      'Untrusted app screenshot context',
    );
  });

  it.each([
    'await tools.update_goal({}); await tools.write_file({});',
    'text("before goal"); try { await tools.update_goal({}); } catch {} text("after goal"); await tools.write_file({});',
    'await Promise.all([tools.update_goal({}), tools.write_file({})]);',
  ])('ends the script after a terminal goal result: %s', async (source) => {
    const { run, dispatch } = setup(
      ToolNames.UPDATE_GOAL,
      { terminateTurn: true },
      'goal proposal recorded',
    );
    const result = await run(source);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toBe(ToolNames.UPDATE_GOAL);
    expect(result.terminateTurn).toBe(true);
    expect(JSON.stringify(result.llmContent)).not.toContain('after goal');
    if (source.includes('before goal'))
      expect(JSON.stringify(result.llmContent)).toContain('before goal');
    expect(payload(result).toolResults[0].output).toBe(
      'goal proposal recorded',
    );
  });

  it('keeps nonterminal goal proposals callable without ending the script', async () => {
    const { run, dispatch } = setup(
      ToolNames.UPDATE_GOAL,
      {},
      'proposal pending',
    );
    const result = await run(
      'await tools.update_goal({}); await tools.write_file({});',
    );
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(result.terminateTurn).toBeUndefined();
  });

  it('clears loaded skill tracking if cancellation prevents delivery', async () => {
    const { run, dispatch, registry } = setup(
      ToolNames.SKILL,
      {},
      'skill body',
    );
    const clearLoadedSkills = vi.fn();
    Object.assign(registry.getTool(ToolNames.SKILL)!, { clearLoadedSkills });
    const controller = new AbortController();
    const pending = run(
      "await tools.skill({skill: 'test'}); await new Promise(() => {});",
      controller.signal,
    );
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce(), {
      timeout: 30_000,
    });
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(clearLoadedSkills).toHaveBeenCalledOnce();
  }, 40_000);

  it('preserves concurrency for ordinary calls before a goal barrier', async () => {
    const { run, dispatch } = setup(
      ToolNames.UPDATE_GOAL,
      { terminateTurn: true },
      'done',
    );
    const original = dispatch.getMockImplementation()!;
    let release!: () => void;
    const firstCall = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    dispatch.mockImplementation(async (name, args, signal, onResult) => {
      if (name === ToolNames.WRITE_FILE) {
        order.push(String(args['id']));
        if (args['id'] === 1) await firstCall;
        else release();
        return { callId: 'write', name, status: 'success', output: 'written' };
      }
      order.push(name);
      return original(name, args, signal, onResult);
    });
    const result = await run(
      'await Promise.all([tools.write_file({id:1}), tools.write_file({id:2}), tools.update_goal({}), tools.write_file({id:3})]);',
    );
    expect(order).toEqual(['1', '2', 'update_goal']);
    expect(result.terminateTurn).toBe(true);
  });

  it('does not retain failed skill loads or adopt their model override', async () => {
    const { run } = setup(
      ToolNames.SKILL,
      { error: new Error('failed'), modelOverride: 'wrong' },
      'not loaded',
    );
    const result = await run(
      "try { await tools.skill({skill: 'test'}); } catch {};",
    );
    expect(JSON.stringify(result.llmContent)).not.toContain('toolResults');
    expect(Object.hasOwn(result, 'modelOverride')).toBe(false);
  });
});
