/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyMalformedToolUseRetryOutcome,
  isMalformedToolUseRetryDisabled,
  MALFORMED_TOOL_USE_RETRY_DISABLE_ENV,
  MalformedToolUseError,
  MalformedToolUseExhaustedError,
  textHasLeakedInvoke,
} from './malformed-tool-use.js';

describe('malformed tool use helpers', () => {
  const originalDisableValue =
    process.env[MALFORMED_TOOL_USE_RETRY_DISABLE_ENV];

  afterEach(() => {
    if (originalDisableValue === undefined) {
      delete process.env[MALFORMED_TOOL_USE_RETRY_DISABLE_ENV];
    } else {
      process.env[MALFORMED_TOOL_USE_RETRY_DISABLE_ENV] = originalDisableValue;
    }
  });

  it('uses stable non-retryable error codes', () => {
    expect(new MalformedToolUseError()).toMatchObject({
      code: 'MALFORMED_TOOL_USE',
      error_code: 'MALFORMED_TOOL_USE',
      retryable: false,
    });
    expect(new MalformedToolUseExhaustedError()).toMatchObject({
      code: 'MALFORMED_TOOL_USE_EXHAUSTED',
      error_code: 'MALFORMED_TOOL_USE_EXHAUSTED',
      retryable: false,
    });
  });

  it('classifies retry outcomes', () => {
    expect(
      classifyMalformedToolUseRetryOutcome({
        stopReason: 'tool_use',
        blocks: [],
      }),
    ).toBe('gave_up');
    expect(
      classifyMalformedToolUseRetryOutcome({
        stopReason: 'tool_use',
        blocks: [{ type: 'tool_use', id: '1', name: 'read_file', input: {} }],
      }),
    ).toBe('succeeded');
    expect(
      classifyMalformedToolUseRetryOutcome({
        stopReason: 'end_turn',
        blocks: [{ type: 'text', text: 'done' }],
      }),
    ).toBe('end_turn');
    expect(
      classifyMalformedToolUseRetryOutcome({
        stopReason: 'max_tokens',
        blocks: [{ type: 'text', text: 'partial' }],
      }),
    ).toBe('other');
  });

  it('parses only valid boolean escape-hatch values', () => {
    delete process.env[MALFORMED_TOOL_USE_RETRY_DISABLE_ENV];
    expect(isMalformedToolUseRetryDisabled()).toBe(false);
    process.env[MALFORMED_TOOL_USE_RETRY_DISABLE_ENV] = 'true';
    expect(isMalformedToolUseRetryDisabled()).toBe(true);
    process.env[MALFORMED_TOOL_USE_RETRY_DISABLE_ENV] = 'invalid';
    expect(isMalformedToolUseRetryDisabled()).toBe(false);
  });

  it('detects leaked invoke markers without retaining response text', () => {
    expect(textHasLeakedInvoke('prefix <invoke name="read_file">')).toBe(true);
    expect(textHasLeakedInvoke('ordinary response')).toBe(false);
  });
});
