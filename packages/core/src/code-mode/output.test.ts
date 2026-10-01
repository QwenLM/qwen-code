/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { boundCodeModeOutput, EXEC_MAX_OUTPUT_CHARS } from './output.js';
import { executeCodeMode, CodeModeExecutionError } from './host-client.js';
import { ExecTool } from '../tools/exec.js';
import { runWithToolCallRuntime } from './tool-call-runtime.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { makeFakeConfig } from '../test-utils/config.js';

const plan = { bindings: [], collisions: [] };
let outputDir: string;
const runtime = {
  parentCallId: 'exec-test',
  dispatch: async () => {
    throw new Error('nested failure');
  },
};

async function exec(source: string) {
  const config = makeFakeConfig();
  vi.spyOn(config.storage, 'getToolResultsDir').mockReturnValue(outputDir);
  const registry = new ToolRegistry(config);
  config.getToolRegistry = () => registry;
  return runWithToolCallRuntime(runtime, () =>
    new ExecTool(config)
      .build({ source })
      .execute(new AbortController().signal),
  );
}

describe('CodeMode output recovery', () => {
  beforeEach(async () => {
    outputDir = await mkdtemp(path.join(os.tmpdir(), 'exec-output-'));
  });
  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });
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
    'bounds oversized output and preserves the full explicit text (failure %s)',
    async (failed) => {
      const result = await exec(
        `text('BEGIN' + 'x'.repeat(40000) + 'END'); ${failed ? "throw new Error('LATER_ERROR');" : ''}`,
      );
      expect(result.persistedOutputFiles).toHaveLength(1);
      const fullOutput = await readFile(
        result.persistedOutputFiles![0],
        'utf8',
      );
      const text = (result.llmContent as Array<{ text: string }>)[0].text;
      expect(text.length).toBeLessThanOrEqual(EXEC_MAX_OUTPUT_CHARS);
      expect(text).toContain('BEGIN');
      expect(fullOutput).toContain('END');
      expect(text).toContain('Full output saved to:');
      expect(fullOutput).toContain('x'.repeat(40000));
      if (failed) {
        expect(result.error?.message).toBe(text);
        expect(fullOutput).toContain('Script error:');
        expect(fullOutput).toContain('LATER_ERROR');
      } else expect(result.error).toBeUndefined();
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
    expect(await readFile(error.persistedOutputFiles![0], 'utf8')).toContain(
      'LAST',
    );
    const value = await exec("text('BEFORE'); return 'v'.repeat(100000);");
    expect(value.returnDisplay).toBe('BEFORE');
    expect((value.llmContent as Array<{ text: string }>)[0].text).toBe(
      'BEFORE',
    );
  });

  it('does not expose implicit return values or success text', async () => {
    const result = await exec("'hidden return value'");
    expect(result.returnDisplay).toBe('');
    expect((result.llmContent as Array<{ text: string }>)[0].text).toBe('');
    expect(result.error).toBeUndefined();
  });

  it('respects small budgets at the marker boundary', () => {
    for (let size = 1; size < 40; size++)
      expect(
        boundCodeModeOutput('x'.repeat(100), size).length,
      ).toBeLessThanOrEqual(size);
  });
});
