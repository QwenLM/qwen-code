/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ToolCallTool } from './tool-call.js';
import { ToolNames } from './tool-names.js';

describe('ToolCallTool', () => {
  it('is an always-visible bridge with a stable generic schema', () => {
    const tool = new ToolCallTool();

    expect(tool.name).toBe(ToolNames.TOOL_CALL);
    expect(tool.alwaysLoad).toBe(true);
    expect(tool.shouldDefer).toBe(false);
    expect(tool.schema.parametersJsonSchema).toEqual({
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Exact deferred tool name returned by tool_search.',
          minLength: 1,
        },
        arguments: {
          type: 'object',
          description:
            'Arguments matching the deferred tool schema returned by tool_search.',
        },
      },
      required: ['name', 'arguments'],
      additionalProperties: false,
    });
  });

  it('validates the bridge envelope', () => {
    const tool = new ToolCallTool();

    expect(() => tool.build({ name: '', arguments: {} })).toThrow();
    expect(() => tool.build({ name: 'deferred_tool' } as never)).toThrow();
    expect(() =>
      tool.build({ name: 'deferred_tool', arguments: {} }),
    ).not.toThrow();
  });

  it('refuses direct execution outside the scheduler', async () => {
    const result = await new ToolCallTool()
      .build({ name: 'deferred_tool', arguments: {} })
      .execute(new AbortController().signal);

    expect(result.error?.message).toContain('tool scheduler');
  });
});
