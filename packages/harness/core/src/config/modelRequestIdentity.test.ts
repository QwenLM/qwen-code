/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { getModelRequestIdentity } from './modelRequestIdentity.js';
import type { ModelProvider } from '../provider/modelProvider.js';

describe('provider request identity', () => {
  it('works without a product or account policy', () => {
    expect(getModelRequestIdentity('local', [])).toBe(
      getModelRequestIdentity('local', []),
    );
    expect(getModelRequestIdentity('sdk', [])).not.toBe(
      getModelRequestIdentity('local', []),
    );
  });

  it('includes every contributed provider, independent of the selected model', () => {
    const providers = [
      { providerId: 'first' },
      { providerId: 'second' },
    ] as ModelProvider[];
    const initial = getModelRequestIdentity('local', providers);
    expect(getModelRequestIdentity('local', providers.slice(0, 1))).not.toBe(
      initial,
    );
    expect(getModelRequestIdentity('local', providers.slice(1))).not.toBe(
      initial,
    );
  });
});
