/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { DeferredToolCallTool } from './deferred-tool-call.js';
import { ToolErrorType } from './tool-error.js';
import { ToolNames } from './tool-names.js';

describe('DeferredToolCallTool', () => {
  it('requires direct discovery in the current active conversation', () => {
    const schema = new DeferredToolCallTool().schema;

    expect(schema.description).toContain('successful direct tool_search');
    expect(schema.description).toContain('current active conversation');
    expect(schema.description).toContain('after context compression');
    expect(schema.description).toContain(
      'Call tool_search directly; never set name to "tool_search"',
    );
    expect(JSON.stringify(schema.parametersJsonSchema)).toContain(
      'Never use \\"tool_search\\"',
    );
  });

  it('fails closed when executed without scheduler normalization', async () => {
    const tool = new DeferredToolCallTool();

    const result = await tool
      .build({
        name: ToolNames.CRON_CREATE,
        arguments: { schedule: '0 9 * * *' },
      })
      .execute(new AbortController().signal);

    expect(result.error).toEqual({
      message: expect.stringContaining('must be normalized by the scheduler'),
      type: ToolErrorType.EXECUTION_FAILED,
    });
    expect(String(result.llmContent)).toContain('Error:');
    expect(String(result.returnDisplay)).toContain(
      'must be normalized by the scheduler',
    );
  });
});
