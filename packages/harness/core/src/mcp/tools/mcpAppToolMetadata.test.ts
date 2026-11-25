/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { isMcpAppToolVisible } from './mcpAppToolMetadata.js';

describe('isMcpAppToolVisible', () => {
  it('offers a tool without visibility metadata to both audiences', () => {
    expect(isMcpAppToolVisible({}, 'model')).toBe(true);
    expect(isMcpAppToolVisible({ _meta: {} }, 'app')).toBe(true);
  });

  it('reads the declared visibility', () => {
    const appOnly = { _meta: { ui: { visibility: ['app'] } } };
    const modelOnly = { _meta: { ui: { visibility: ['model'] } } };
    const both = { _meta: { ui: { visibility: ['model', 'app'] } } };

    expect(isMcpAppToolVisible(appOnly, 'model')).toBe(false);
    expect(isMcpAppToolVisible(appOnly, 'app')).toBe(true);
    expect(isMcpAppToolVisible(modelOnly, 'model')).toBe(true);
    expect(isMcpAppToolVisible(modelOnly, 'app')).toBe(false);
    expect(isMcpAppToolVisible(both, 'model')).toBe(true);
    expect(isMcpAppToolVisible(both, 'app')).toBe(true);
  });

  it('fails closed for the model when the declaration is malformed', () => {
    expect(
      isMcpAppToolVisible({ _meta: { ui: { visibility: 'app' } } }, 'model'),
    ).toBe(false);
    expect(
      isMcpAppToolVisible({ _meta: { ui: { visibility: 'model' } } }, 'app'),
    ).toBe(false);
  });
});
