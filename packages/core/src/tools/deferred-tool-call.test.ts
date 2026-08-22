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
  it('describes the live-catalog bridge contract', () => {
    const schema = new DeferredToolCallTool().schema;

    expect(schema.description).toContain('live tool_search catalog');
    expect(schema.description).toContain(
      'Use tool_search first when the target schema or arguments are unknown',
    );
    expect(schema.description).toContain(
      'Policy, permissions, hooks, validation, telemetry, and execution',
    );
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
