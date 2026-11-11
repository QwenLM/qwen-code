/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  modelRequestObservationError,
  observationWaitFailureStatus,
} from './observation.js';

describe('model request observation diagnostics', () => {
  it('normalizes bounded causes without retaining errors or secrets', () => {
    const cause = Object.assign(
      new Error('{"api_key":"secret-value","message":"connection failed"}'),
      { code: 'ECONNRESET' },
    );
    const error = Object.assign(
      new Error('wrapped request failure', { cause }),
      {
        providerError: { code: 50001, statusCode: 503 },
      },
    );
    cause.cause = error;
    const result = modelRequestObservationError(error);
    expect(result).toMatchObject({
      error_type: 'Error',
      error_code: '50001',
      status_code: 503,
      error_causes: [{ error_code: 'ECONNRESET' }],
    });
    expect(JSON.stringify(result)).not.toContain('secret-value');
    expect(result['error_causes']).toHaveLength(1);
    expect(
      modelRequestObservationError(
        Object.assign(new Error('Client request failed'), { statusCode: 503 }),
      )['status_code'],
    ).toBe(503);
    expect(() =>
      modelRequestObservationError(
        new Proxy(
          {},
          {
            get() {
              throw error;
            },
          },
        ),
      ),
    ).not.toThrow();
  });

  it('contains abort-classification failures without replacing the original error', () => {
    const original = new Error('request failed');
    Object.defineProperty(original, 'cause', {
      get() {
        throw new Error('diagnostic getter failed');
      },
    });
    expect(observationWaitFailureStatus(original)).toBe('failed');
    expect(original.message).toBe('request failed');
    expect(
      observationWaitFailureStatus(new DOMException('stopped', 'AbortError')),
    ).toBe('aborted');
  });
});
