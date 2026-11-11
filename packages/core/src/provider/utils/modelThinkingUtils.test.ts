/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Model } from '../model/model.js';
import { ModelThinkingUtils } from './modelThinkingUtils.js';

function model(supported: boolean): Model {
  return {
    source: 'local',
    key: 'example',
    displayName: 'Example',
    capabilities: {
      tools: true,
      vision: false,
      reasoning: { supported, supportedEfforts: [] },
      contextWindows: [],
    },
    limits: { maxContextTokens: 200_000 },
  };
}

describe('ModelThinkingUtils', () => {
  it('档位 none 或思考 disabled 视为显式关闭，关闭优先于其余档位', () => {
    expect(ModelThinkingUtils.isDisabled({})).toBe(false);
    expect(
      ModelThinkingUtils.isDisabled({ reasoning: { effort: 'none' } }),
    ).toBe(true);
    expect(
      ModelThinkingUtils.isDisabled({
        reasoning: { effort: 'high', thinking: { type: 'disabled' } },
      }),
    ).toBe(true);
    expect(
      ModelThinkingUtils.isDisabled({
        reasoning: { thinking: { type: 'adaptive' } },
      }),
    ).toBe(false);
  });

  it('实际开启需要模型支持思考且配置未关闭', () => {
    expect(ModelThinkingUtils.isEnabled(model(true), {})).toBe(true);
    expect(
      ModelThinkingUtils.isEnabled(model(true), {
        reasoning: { thinking: { type: 'enabled', budgetTokens: 4096 } },
      }),
    ).toBe(true);
    expect(
      ModelThinkingUtils.isEnabled(model(true), {
        reasoning: { effort: 'none' },
      }),
    ).toBe(false);
    expect(
      ModelThinkingUtils.isEnabled(model(false), {
        reasoning: { effort: 'high' },
      }),
    ).toBe(false);
  });

  it('单一档位：关闭为 none，其次显式档位，最后由预算推导', () => {
    expect(ModelThinkingUtils.resolveEffort({})).toBeUndefined();
    expect(
      ModelThinkingUtils.resolveEffort({
        reasoning: { thinking: { type: 'adaptive' } },
      }),
    ).toBeUndefined();
    expect(
      ModelThinkingUtils.resolveEffort({
        reasoning: { effort: 'high', thinking: { type: 'disabled' } },
      }),
    ).toBe('none');
    expect(
      ModelThinkingUtils.resolveEffort({
        reasoning: {
          effort: 'low',
          thinking: { type: 'enabled', budgetTokens: 60_000 },
        },
      }),
    ).toBe('low');
    const fromBudget = (budgetTokens: number) =>
      ModelThinkingUtils.resolveEffort({
        reasoning: { thinking: { type: 'enabled', budgetTokens } },
      });
    expect(fromBudget(1024)).toBe('low');
    expect(fromBudget(8192)).toBe('medium');
    expect(fromBudget(24_576)).toBe('high');
    expect(fromBudget(49_152)).toBe('xhigh');
    expect(fromBudget(49_153)).toBe('max');
  });
});
