/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { SyntheticOutputTool } from './syntheticOutput.js';
import { ToolNames } from './tool-names.js';
import type { Config } from '../config/config.js';

function makeTool(schema: Record<string, unknown>): SyntheticOutputTool {
  const mockConfig = { isInteractive: vi.fn().mockReturnValue(false) } as unknown as Config;
  return new SyntheticOutputTool(mockConfig, schema);
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
    expect(
      tool.validateToolParams({ summary: 'ok', score: 1 }),
    ).toBeNull();
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

  it('execute() returns success llmContent that tells the model to stop', async () => {
    const tool = makeTool(objectSchema);
    const invocation = tool.build({ summary: 'hello' });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(String(result.llmContent)).toMatch(/accepted/i);
    expect(String(result.llmContent)).toMatch(/end/i);
  });

  it('is always loaded (never hidden behind ToolSearch)', () => {
    const tool = makeTool(objectSchema);
    expect(tool.alwaysLoad).toBe(true);
    expect(tool.shouldDefer).toBe(false);
  });
});
