/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { orderModPlugins, parseModDependencies } from './dependencies.js';
import type { ModDependency } from './types.js';

const plugin = (
  name: string,
  dependencies: ModDependency[] = [],
  marketplace?: string,
  version = '1.0.0',
) => ({ name, dependencies, marketplace, version });

describe('installed Mod dependencies', () => {
  it('parses qualified strings and preserves object version constraints', () => {
    expect(parseModDependencies(['base.v2@market.dev'])).toEqual([
      { name: 'base.v2', marketplace: 'market.dev' },
    ]);
    expect(() => parseModDependencies(['_bad'])).toThrow(/declaration/);
    expect(
      parseModDependencies([
        'base',
        'other@market',
        { name: 'third', marketplace: 'elsewhere', version: '^2.0.0' },
      ]),
    ).toEqual([
      { name: 'base' },
      { name: 'other', marketplace: 'market' },
      { name: 'third', marketplace: 'elsewhere', version: '^2.0.0' },
    ]);
    expect(() => parseModDependencies({ base: '*' })).toThrow(/declaration/);
    expect(() =>
      parseModDependencies([{ name: 'base', version: 'not-semver' }]),
    ).toThrow(/version range/);
  });

  it('registers consumers first while retaining stable unrelated order', () => {
    const provider = plugin('base');
    const unrelated = plugin('unrelated');
    const consumer = plugin('consumer', [{ name: 'base' }]);
    expect(orderModPlugins([provider, unrelated, consumer])).toEqual([
      unrelated,
      consumer,
      provider,
    ]);
  });

  it('resolves same-market versions and qualified local overrides', () => {
    const consumer = plugin(
      'consumer',
      [{ name: 'base', version: '^2.0.0' }],
      'market',
    );
    expect(() =>
      orderModPlugins([consumer, plugin('base', [], 'other', '2.0.0')]),
    ).toThrow(/installed, enabled/);
    expect(() =>
      orderModPlugins([consumer, plugin('base', [], 'market')]),
    ).toThrow(/incompatible/);
    expect(
      orderModPlugins([consumer, plugin('base', [], 'market', '2.1.0')]),
    ).toHaveLength(2);
    expect(orderModPlugins([consumer, plugin('base')])).toHaveLength(2);
    expect(
      orderModPlugins([
        plugin('consumer', [
          { name: 'base', marketplace: 'market', version: '^2.0.0' },
        ]),
        plugin('base'),
      ]),
    ).toHaveLength(2);
  });

  it('rejects missing, ambiguous and cyclic graphs', () => {
    const consumer = plugin('consumer', [{ name: 'base' }]);
    expect(() => orderModPlugins([consumer])).toThrow(/installed, enabled/);
    expect(() =>
      orderModPlugins([consumer, plugin('base'), plugin('base')]),
    ).toThrow(/one installed/);
    expect(() =>
      orderModPlugins([consumer, plugin('base', [{ name: 'consumer' }])]),
    ).toThrow(/cycle/);
    expect(() => orderModPlugins([plugin('self', [{ name: 'self' }])])).toThrow(
      /cycle/,
    );
  });
});
