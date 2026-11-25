/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_STRUCTURED_OUTPUT_RETRIES,
  WorkflowStructuredOutputResultHolder,
  WorkflowStructuredOutputTool,
} from './workflow-structured-output-tool.js';

const ENV_NAME = 'MAX_STRUCTURED_OUTPUT_RETRIES';
const originalEnvValue = process.env[ENV_NAME];
const schema = {
  type: 'object',
  properties: { value: { type: 'number' } },
  required: ['value'],
  additionalProperties: false,
};

afterEach(() => {
  if (originalEnvValue === undefined) {
    delete process.env[ENV_NAME];
  } else {
    process.env[ENV_NAME] = originalEnvValue;
  }
});

describe('WorkflowStructuredOutputTool', () => {
  it('ends the turn after recording valid structured output', async () => {
    const holder = new WorkflowStructuredOutputResultHolder();
    const tool = new WorkflowStructuredOutputTool(holder, schema);

    const result = await tool
      .build({ value: 42 })
      .execute(new AbortController().signal);

    expect(result.endsTurn).toBe(true);
    expect(result.error).toBeUndefined();
    expect(holder.result).toEqual({ value: 42 });
    expect(holder.attemptCount).toBe(1);
    expect(holder.failedCallCount).toBe(0);
  });

  it('stops after the configured number of validation failures', async () => {
    process.env[ENV_NAME] = '2';
    const holder = new WorkflowStructuredOutputResultHolder();
    const tool = new WorkflowStructuredOutputTool(holder, schema);

    const first = await tool
      .build({ value: 'bad' })
      .execute(new AbortController().signal);
    const second = await tool
      .build({ value: 'still-bad' })
      .execute(new AbortController().signal);
    const afterCap = await tool
      .build({ value: 'not-evaluated' })
      .execute(new AbortController().signal);

    expect(first.endsTurn).toBeUndefined();
    expect(second.endsTurn).toBe(true);
    expect(second.error?.message).toContain(
      'StructuredOutput retry cap (2) exceeded',
    );
    expect(afterCap.endsTurn).toBe(true);
    expect(holder.retryCapExceeded).toBe(true);
    expect(holder.attemptCount).toBe(2);
    expect(holder.failedCallCount).toBe(2);
  });

  it.each(['', '0', '-1', '1.5', 'invalid'])(
    'falls back to the default retry cap for invalid env value %j',
    (value) => {
      process.env[ENV_NAME] = value;
      const holder = new WorkflowStructuredOutputResultHolder();
      expect(holder.maxRetries).toBe(DEFAULT_MAX_STRUCTURED_OUTPUT_RETRIES);
    },
  );
});
