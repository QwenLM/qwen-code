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
