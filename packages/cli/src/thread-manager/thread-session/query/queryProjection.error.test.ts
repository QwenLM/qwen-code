/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ModelInferenceError } from '@qwen-code/core';
import { buildResultError } from './queryProjection.js';

describe('Provider error result projection', () => {
  it.each(['112', '140', 'EXTERNAL_TOKEN_RATE_LIMITED', undefined])(
    'forwards the original code %s without parsing the message or HTTP status',
    (code) => {
      const error = new ModelInferenceError('HTTP 503', {
        code,
        kind: 'server',
        status: 503,
        phase: 'before_output',
      });
      const result = buildResultError(
        'error_during_execution',
        {
          error,
          errors: [error.message],
          durationMs: 0,
          numTurns: 0,
        },
        'provider-error-session',
      );
      expect(result).toMatchObject({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
      });
      if (code === undefined) expect(result).not.toHaveProperty('error_code');
      else expect(result).toHaveProperty('error_code', code);
    },
  );
});
