/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Model } from '../model/model.js';
import { ModelWireUtils } from './modelWireUtils.js';

function model(source: string, key: string): Model {
  return {
    source,
    key,
    displayName: key,
    capabilities: {
      tools: true,
      vision: false,
      reasoning: { supported: false, supportedEfforts: [] },
      contextWindows: [],
    },
    limits: { maxContextTokens: 200_000 },
  };
}

describe('ModelWireUtils', () => {
  it('key 带 <source>/ 前缀时剥掉前缀，modelId 自身的 / 保留', () => {
    expect(ModelWireUtils.modelId(model('my-provider', 'my-provider/gpt-4o'))).toBe(
      'gpt-4o',
    );
    expect(
      ModelWireUtils.modelId(model('router', 'router/openai/gpt-4o')),
    ).toBe('openai/gpt-4o');
  });

  it('key 不带归属前缀时原样返回', () => {
    expect(ModelWireUtils.modelId(model('local', 'example'))).toBe('example');
    expect(ModelWireUtils.modelId(model('local', 'other/example'))).toBe(
      'other/example',
    );
  });
});
