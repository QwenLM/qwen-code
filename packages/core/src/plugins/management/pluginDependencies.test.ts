/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  checkDependencies,
  resolveDependencyOrder,
  verifyAndDemoteDependencies,
  findDependents,
  findEnabledDependents,
} from './pluginDependencies.js';
import type { LoadedPlugin } from '../types.js';
import { isPluginInstalled } from './installedPluginsManager.js';

vi.mock('./installedPluginsManager.js', () => ({
  isPluginInstalled: vi.fn().mockReturnValue(true),
}));

const mockedIsInstalled = isPluginInstalled as ReturnType<typeof vi.fn>;

function makePlugin(
  name: string,
  source: string,
  dependencies?: string[],
): LoadedPlugin {
  return {
    name,
    source,
    path: `/fake/path/${name}`,
    enabled: true,
    manifest: {
      name,
      version: '1.0.0',
      ...(dependencies ? { dependencies } : {}),
    },
  } as unknown as LoadedPlugin;
}

describe('pluginDependencies', () => {
  describe('checkDependencies', () => {
    it('returns satisfied when plugin has no dependencies', () => {
      const plugin = makePlugin('my-plugin', 'marketplace-a');
      const result = checkDependencies(plugin, new Set());
      expect(result.satisfied).toBe(true);
      expect(result.unsatisfied).toHaveLength(0);
    });

    it('returns satisfied when all dependencies are enabled', () => {
      const plugin = makePlugin('my-plugin', 'marketplace-a', [
        'dep-a',
        'dep-b@marketplace-a',
      ]);
      const enabled = new Set([
        'dep-a@marketplace-a',
        'dep-b@marketplace-a',
        'dep-a',
        'dep-b',
      ]);
      const result = checkDependencies(plugin, enabled);
      expect(result.satisfied).toBe(true);
      expect(result.resolved).toContain('dep-a@marketplace-a');
      expect(result.resolved).toContain('dep-b@marketplace-a');
    });

    it('returns unsatisfied for missing dependencies', () => {
      mockedIsInstalled.mockReturnValue(false);
      const plugin = makePlugin('my-plugin', 'marketplace-a', ['missing-dep']);
      const enabled = new Set(['other-plugin@marketplace-a']);
      const result = checkDependencies(plugin, enabled);
      expect(result.satisfied).toBe(false);
      expect(result.unsatisfied).toHaveLength(1);
      expect(result.unsatisfied[0].ref).toBe('missing-dep');
      expect(result.unsatisfied[0].reason).toBe('not-installed');
      mockedIsInstalled.mockReturnValue(true);
    });

    it('resolves bare dependency names against plugin source marketplace', () => {
      const plugin = makePlugin('my-plugin', 'my-market', ['bare-dep']);
      // bare-dep should resolve to bare-dep@my-market
      const enabled = new Set(['bare-dep@my-market', 'bare-dep']);
      const result = checkDependencies(plugin, enabled);
      expect(result.satisfied).toBe(true);
      expect(result.resolved).toContain('bare-dep@my-market');
    });
  });

  describe('resolveDependencyOrder', () => {
    it('returns topological order for a dependency chain', () => {
      const plugins = [
        makePlugin('a', 'mp', ['b']),
        makePlugin('b', 'mp', ['c']),
        makePlugin('c', 'mp'),
      ];
      const result = resolveDependencyOrder('a@mp', plugins);
      expect('order' in result).toBe(true);
      if ('order' in result) {
        // c should come before b, b before a
        const idxC = result.order.indexOf('c@mp');
        const idxB = result.order.indexOf('b@mp');
        const idxA = result.order.indexOf('a@mp');
        expect(idxC).toBeLessThan(idxB);
        expect(idxB).toBeLessThan(idxA);
      }
    });

    it('detects cycles', () => {
      const plugins = [
        makePlugin('a', 'mp', ['b']),
        makePlugin('b', 'mp', ['a']),
      ];
      const result = resolveDependencyOrder('a@mp', plugins);
      expect('cycle' in result).toBe(true);
    });
  });

  describe('verifyAndDemoteDependencies', () => {
    it('demotes plugins with disabled dependencies and cascades to dependents', () => {
      const provider = makePlugin('provider', 'mp');
      provider.enabled = false;
      const consumer = makePlugin('consumer', 'mp', ['provider']);
      const downstream = makePlugin('downstream', 'mp', ['consumer']);

      const result = verifyAndDemoteDependencies([
        provider,
        consumer,
        downstream,
      ]);

      expect(result.demoted).toEqual(
        new Set(['consumer@mp', 'downstream@mp']),
      );
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'dependency-unsatisfied',
            plugin: 'consumer',
            dependency: 'provider@mp',
            reason: 'not-enabled',
          }),
          expect.objectContaining({
            type: 'dependency-unsatisfied',
            plugin: 'downstream',
            dependency: 'consumer@mp',
            reason: 'not-enabled',
          }),
        ]),
      );
    });

    it('reports not-found when a dependency is not loaded at all', () => {
      const consumer = makePlugin('consumer', 'mp', ['missing']);

      const result = verifyAndDemoteDependencies([consumer]);

      expect(result.demoted).toEqual(new Set(['consumer@mp']));
      expect(result.errors[0]).toMatchObject({
        type: 'dependency-unsatisfied',
        plugin: 'consumer',
        dependency: 'missing@mp',
        reason: 'not-found',
      });
    });

    it('does not satisfy marketplace bare dependencies by same-name plugins from other marketplaces', () => {
      const consumer = makePlugin('consumer', 'mp-a', ['provider']);
      const provider = makePlugin('provider', 'mp-b');

      const result = verifyAndDemoteDependencies([consumer, provider]);

      expect(result.demoted).toEqual(new Set(['consumer@mp-a']));
      expect(result.errors[0]).toMatchObject({
        plugin: 'consumer',
        dependency: 'provider@mp-a',
        reason: 'not-found',
      });
    });
  });

  describe('findDependents', () => {
    it('finds plugins that depend on a given plugin', () => {
      const plugins = [
        makePlugin('consumer', 'mp', ['provider']),
        makePlugin('provider', 'mp'),
        makePlugin('unrelated', 'mp'),
      ];
      const dependents = findDependents('provider@mp', plugins);
      expect(dependents).toContain('consumer@mp');
      expect(dependents).not.toContain('unrelated@mp');
    });

    it('returns empty when no plugins depend on the target', () => {
      const plugins = [
        makePlugin('standalone', 'mp'),
        makePlugin('other', 'mp'),
      ];
      const dependents = findDependents('standalone@mp', plugins);
      expect(dependents).toHaveLength(0);
    });

    it('does not match bare dependency names across marketplaces', () => {
      const plugins = [
        makePlugin('consumer', 'other-mp', ['provider']),
        makePlugin('provider', 'mp'),
      ];
      const dependents = findDependents('provider@mp', plugins);
      expect(dependents).toHaveLength(0);
    });

    it('can restrict reverse dependency checks to enabled plugins', () => {
      const disabledConsumer = makePlugin('consumer', 'mp', ['provider']);
      disabledConsumer.enabled = false;
      const plugins = [
        disabledConsumer,
        makePlugin('enabled-consumer', 'mp', ['provider']),
        makePlugin('provider', 'mp'),
      ];

      const dependents = findEnabledDependents('provider@mp', plugins);

      expect(dependents).toEqual(['enabled-consumer@mp']);
    });
  });
});
