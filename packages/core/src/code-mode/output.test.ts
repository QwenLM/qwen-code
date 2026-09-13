/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { boundCodeModeOutput, EXEC_MAX_OUTPUT_CHARS } from './output.js';
import { executeCodeMode, CodeModeExecutionError } from './host-client.js';
import { ExecTool } from '../tools/exec.js';
import { runWithToolCallRuntime } from './tool-call-runtime.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { makeFakeConfig } from '../test-utils/config.js';

const plan = { bindings: [], collisions: [] };
const runtime = {
  parentCallId: 'exec-test',
  dispatch: async () => {
    throw new Error('nested failure');
  },
};

async function exec(source: string) {
  const config = makeFakeConfig();
  const registry = new ToolRegistry(config);
  config.getToolRegistry = () => registry;
  return runWithToolCallRuntime(runtime, () =>
    new ExecTool(config)
      .build({ source })
      .execute(new AbortController().signal),
  );
}

describe('CodeMode output recovery', () => {
  it('keeps prior text and media with a script failure', async () => {
    try {
      await executeCodeMode(
        "text('COMPLETED'); image('data:image/png;base64,QUJD'); throw new Error('LATER');",
        plan,
        runtime,
        new AbortController().signal,
      );
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(CodeModeExecutionError);
      const failure = error as CodeModeExecutionError;
      expect(failure.result.output).toBe('COMPLETED');
      expect(failure.result.content).toEqual([
        { type: 'image', mimeType: 'image/png', data: 'QUJD' },
      ]);
      expect(failure.message).toContain('LATER');
    }
  });

  it('keeps prior text when a nested tool rejects', async () => {
    await expect(
      executeCodeMode(
        "text('DONE'); await tools.fail({});",
        {
          bindings: [
            {
              name: 'fail',
              jsName: 'fail',
              description: '',
              parametersJsonSchema: {},
              deferred: false,
            },
          ],
          collisions: [],
        },
        runtime,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      result: { output: 'DONE' },
      message: expect.stringContaining('nested failure'),
    });
  });

  it.each([false, true])(
    'bounds complete model output inline (failure %s)',
    async (failed) => {
      const result = await exec(
        `text('BEGIN' + 'x'.repeat(110000) + 'END'); ${failed ? "throw new Error('LATER_ERROR');" : ''}`,
      );
      expect(result.persistedOutputFiles).toEqual([]);
      const text = (result.llmContent as Array<{ text: string }>)[0].text;
      expect(text.length).toBeLessThanOrEqual(EXEC_MAX_OUTPUT_CHARS);
      expect(text).toContain('BEGIN');
      expect(text).toContain('END');
      expect(text).toContain('code mode output truncated');
      if (failed) {
        expect(result.error?.message).toBe(text);
        expect(text).toContain('Script error:');
        expect(text).toContain('LATER_ERROR');
      } else expect(result.error).toBeUndefined();
      expect(text).not.toMatch(/persisted|saved to|\.output/);
    },
  );

  it('bounds large error and return values with the same output budget', async () => {
    const error = await exec(
      "text('BEFORE'); throw new Error('FIRST' + 'e'.repeat(100000) + 'LAST');",
    );
    expect(error.error?.message.length).toBeLessThanOrEqual(
      EXEC_MAX_OUTPUT_CHARS,
    );
    expect(error.error?.message).toContain('BEFORE');
    expect(error.error?.message).toContain('LAST');
    const value = await exec("text('BEFORE'); return 'v'.repeat(100000);");
    expect(String(value.returnDisplay).length).toBeLessThanOrEqual(
      EXEC_MAX_OUTPUT_CHARS,
    );
  });

  it('respects small budgets at the marker boundary', () => {
    for (let size = 1; size < 40; size++)
      expect(
        boundCodeModeOutput('x'.repeat(100), size).length,
      ).toBeLessThanOrEqual(size);
  });
});
