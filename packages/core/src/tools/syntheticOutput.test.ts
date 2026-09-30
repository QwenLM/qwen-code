/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { SyntheticOutputTool } from './syntheticOutput.js';
import { ToolNames } from './tool-names.js';

function makeTool(schema: Record<string, unknown>): SyntheticOutputTool {
  return new SyntheticOutputTool(schema);
}

describe('SyntheticOutputTool', () => {
  const objectSchema = {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      score: { type: 'number' },
    },
    required: ['summary'],
    additionalProperties: false,
  };

  it('registers under the structured_output name', () => {
    expect(SyntheticOutputTool.Name).toBe(ToolNames.STRUCTURED_OUTPUT);
    expect(ToolNames.STRUCTURED_OUTPUT).toBe('structured_output');
  });

  it('surfaces the user schema as the tool parameter schema', () => {
    const tool = makeTool(objectSchema);
    expect(tool.schema.parametersJsonSchema).toBe(objectSchema);
  });

  it('accepts args that match the user schema', () => {
    const tool = makeTool(objectSchema);
    expect(tool.validateToolParams({ summary: 'ok', score: 1 })).toBeNull();
  });

  it('rejects args missing required fields', () => {
    const tool = makeTool(objectSchema);
    const result = tool.validateToolParams({ score: 1 });
    expect(result).not.toBeNull();
    expect(result).toMatch(/summary/);
  });

  it('rejects args with extra fields when additionalProperties is false', () => {
    const tool = makeTool(objectSchema);
    const result = tool.validateToolParams({
      summary: 'ok',
      unexpected: true,
    });
    expect(result).not.toBeNull();
  });

  it('validates with the given validator instead of the shared one', () => {
    const seen: unknown[] = [];
    const tool = new SyntheticOutputTool({ type: 42 }, (params) => {
      seen.push(params);
      return 'rejected by the call validator';
    });
    expect(() => tool.build({ anything: true })).toThrow(
      'rejected by the call validator',
    );
    expect(seen).toEqual([{ anything: true }]);
  });

  it('keeps the shared validation when no validator is given', () => {
    // The shared validator skips a schema it cannot compile; ordinary
    // --json-schema and MCP callers rely on that, so it is unchanged.
    expect(() =>
      makeTool({ type: 42 }).build({ anything: true }),
    ).not.toThrow();
    expect(() => makeTool(objectSchema).build({ score: 1 })).toThrow(/summary/);
  });

  it('execute() returns success llmContent that tells the model to stop', async () => {
    const tool = makeTool(objectSchema);
    const invocation = tool.build({ summary: 'hello' });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(String(result.llmContent)).toMatch(/accepted/i);
    expect(String(result.llmContent)).toMatch(/end/i);
  });

  it('is always loaded (never hidden behind the deferred-tool bridge)', () => {
    // The synthetic terminal tool MUST be visible to the model from the
    // very first turn. If deferred-tool loading ever hid it,
    // the structured-output contract would silently break (the model
    // wouldn't know the tool exists, would emit plain text, and the run
    // would exit via the "Model produced plain text..." failure path).
    const tool = makeTool(objectSchema);
    expect(tool.alwaysLoad).toBe(true);
    expect(tool.shouldDefer).toBe(false);
  });
});
