/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { SESSION_MODEL_PERSIST_DEFAULT_META_KEY as KEY } from '@qwen-code/acp-bridge/bridgeTypes';
import { parseSessionModelMetadata } from './session-model-options.js';

describe('parseSessionModelMetadata', () => {
  it('leaves omitted options absent', () => {
    expect(parseSessionModelMetadata({ modelId: 'model-a' })).toEqual({});
  });

  it.each([false, true])('maps explicit persistence %s', (persistDefault) => {
    expect(
      parseSessionModelMetadata({
        persistDefault,
        _meta: { unrelated: 'retained' },
      }),
    ).toEqual({
      metadata: { unrelated: 'retained', [KEY]: persistDefault },
    });
  });

  it('retains valid legacy metadata without a public field', () => {
    expect(parseSessionModelMetadata({ _meta: { [KEY]: false } })).toEqual({
      metadata: { [KEY]: false },
    });
  });

  it('accepts matching public and legacy values', () => {
    expect(
      parseSessionModelMetadata({
        persistDefault: false,
        _meta: { [KEY]: false },
      }),
    ).toEqual({ metadata: { [KEY]: false } });
  });

  it.each([
    { persistDefault: null },
    { persistDefault: 'false' },
    { persistDefault: 0 },
    { _meta: null },
    { _meta: [] },
    { _meta: 'metadata' },
    { _meta: { [KEY]: 'false' } },
    { persistDefault: false, _meta: { [KEY]: true } },
    { persistDefault: true, _meta: { [KEY]: false } },
  ])('rejects invalid or conflicting options: %j', (params) => {
    expect(parseSessionModelMetadata(params)).toEqual({
      error: expect.any(String),
    });
  });
});
