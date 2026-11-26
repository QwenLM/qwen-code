/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseHostedModelSelection } from './hosted-model-selection.js';

describe('Hosted Turn model selection', () => {
  it('keeps old callers optional and returns only the validated selection', () => {
    expect(parseHostedModelSelection(undefined)).toBeUndefined();
    expect(
      parseHostedModelSelection({ modelId: 'configured-model', revision: 1 }),
    ).toEqual({ modelId: 'configured-model', revision: 1 });
  });

  it.each([
    null,
    [],
    'model',
    {},
    { modelId: 'model', revision: 0 },
    { modelId: 'model', revision: 1.5 },
    { modelId: 'model', revision: Number.MAX_SAFE_INTEGER + 1 },
    { modelId: 'model', revision: '1' },
    { modelId: '', revision: 1 },
    { modelId: '\nmodel', revision: 1 },
    { modelId: '中'.repeat(171), revision: 1 },
    { modelId: 'model', revision: 1, apiKey: 'unexpected' },
  ])('rejects malformed selections (%j)', (value) => {
    expect(() => parseHostedModelSelection(value)).toThrow(
      'Invalid Hosted model selection',
    );
  });
});
