/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { resolveModelName } from './resolveModelName.js';

describe('resolveModelName', () => {
  const official = { key: 'qmodel_38max', displayName: 'Qwen3.8-Max' };
  const custom = { key: 'custom/qwen3.8-flash', displayName: 'qa-test888' };

  it.each([
    ['Qwen3.8-Max', official],
    ['qwen3.8-max', official],
    ['QMODEL_38MAX', official],
    ['qa-test888', custom],
    ['QA-TEST888', custom],
  ])('resolves %s without altering the catalog', (input, expected) => {
    const models = Object.freeze([
      Object.freeze(official),
      Object.freeze(custom),
    ]);
    expect(resolveModelName(models, input)).toEqual({ model: expected });
  });

  it('prefers exact keys to case-insensitive keys and display names', () => {
    const models = [
      { key: 'other', displayName: 'Target', aliases: ['Target'] },
      { key: 'TARGET', displayName: 'Upper' },
      { key: 'Target', displayName: 'Mixed' },
    ];
    expect(resolveModelName(models, 'Target')).toEqual({ model: models[2] });
    expect(resolveModelName(models, 'target')).toEqual({
      ambiguous: models.slice(1),
    });
  });

  it('returns conflicting names, including disabled models, instead of picking one', () => {
    const models = [
      { ...official, enabled: true },
      { ...custom, displayName: 'qwen3.8-max', enabled: false },
    ];
    expect(resolveModelName(models, 'Qwen3.8-Max')).toEqual({
      ambiguous: models,
    });
  });

  it('resolves explicit aliases without changing their source', () => {
    const model = {
      ...custom,
      aliases: Object.freeze(['Alternate name', 'My Alias']),
    };
    expect(resolveModelName([model], 'my alias')).toEqual({ model });
  });

  it('reports collisions between aliases and display names', () => {
    const models = [
      { ...official, aliases: ['My Alias'] },
      { ...custom, displayName: 'my alias' },
    ];
    expect(resolveModelName(models, 'MY ALIAS')).toEqual({ ambiguous: models });
  });

  it('does not interpret unknown names or provider IDs', () => {
    expect(resolveModelName([official, custom], 'custom')).toEqual({
      model: undefined,
    });
    expect(resolveModelName([official, custom], 'missing')).toEqual({
      model: undefined,
    });
  });
});
