/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { StructuredOutputTool } from './structured-output.js';
import { ToolNames } from './tool-names.js';

const schema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    count: { type: 'integer' },
  },
  required: ['summary', 'count'],
  additionalProperties: false,
};

describe('StructuredOutputTool', () => {
  it('returns a terminal structured output payload for valid input', async () => {
    const tool = new StructuredOutputTool(schema);
    const invocation = tool.build({ summary: 'done', count: 2 });
    const result = await invocation.execute(new AbortController().signal);

    expect(tool.name).toBe(ToolNames.STRUCTURED_OUTPUT);
    expect(result.error).toBeUndefined();
    expect(result.terminalResult).toEqual({
      kind: 'structured_output',
      data: { summary: 'done', count: 2 },
    });
  });

  it('rejects invalid input without coercing values', () => {
    const tool = new StructuredOutputTool(schema);

    expect(() => tool.build({ summary: 'done', count: '2' })).toThrow(
      /must be integer/,
    );
  });
});
