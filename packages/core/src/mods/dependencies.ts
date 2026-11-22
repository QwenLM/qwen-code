/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { satisfies, validRange } from 'semver';
import { z } from 'zod';
import type { ModDependency } from './types.js';

const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const dependency = z.union([
  z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:@[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/),
  z
    .object({
      name,
      marketplace: name.optional(),
      version: z.string().optional(),
    })
    .strict(),
]);

export function parseModDependencies(value: unknown): ModDependency[] {
  const parsed = z
    .array(dependency)
    .safeParse(value === undefined ? [] : value);
  if (!parsed.success) throw new Error('Invalid Mod dependencies declaration.');
  return parsed.data.map((item) => {
    if (typeof item === 'string') {
      const [name, marketplace] = item.split('@');
      return { name, marketplace };
    }
    if (item.version !== undefined && !validRange(item.version)) {
      throw new Error(`Invalid Mod dependency version range for ${item.name}.`);
    }
    return item;
  });
}

interface ModPlugin {
  name: string;
  marketplace?: string;
  version: string;
  dependencies: ModDependency[];
}

export function resolveModDependency<T extends ModPlugin>(
  plugins: readonly T[],
  plugin: T,
  dependency: ModDependency,
): T {
  const marketplace = dependency.marketplace ?? plugin.marketplace;
  const local = plugins.filter(
    (item) => item.name === dependency.name && !item.marketplace,
  );
  const matches = local.length
    ? local
    : plugins.filter(
        (item) =>
          item.name === dependency.name && item.marketplace === marketplace,
      );
  if (matches.length !== 1) {
    throw new Error(
      `Mod ${plugin.name}: dependency ${dependency.name} must identify one installed, enabled plugin.`,
    );
  }
  const target = matches[0];
  if (
    target.marketplace &&
    dependency.version &&
    !satisfies(target.version, dependency.version)
  ) {
    throw new Error(
      `Mod ${plugin.name}: dependency ${dependency.name} has an incompatible installed version.`,
    );
  }
  return target;
}

export function orderModPlugins<T extends ModPlugin>(
  plugins: readonly T[],
): T[] {
  const edges = plugins.map(() => new Set<number>());
  const incoming = plugins.map(() => 0);
  for (const [index, plugin] of plugins.entries()) {
    for (const dependency of plugin.dependencies) {
      const targetIndex = plugins.indexOf(
        resolveModDependency(plugins, plugin, dependency),
      );
      if (!edges[index].has(targetIndex)) {
        edges[index].add(targetIndex);
        incoming[targetIndex]++;
      }
    }
  }
  const ordered: T[] = [];
  const remaining = new Set(plugins.map((_, index) => index));
  while (remaining.size) {
    const next = [...remaining].find((index) => incoming[index] === 0);
    if (next === undefined)
      throw new Error('Mod dependency cycle: activation refused.');
    remaining.delete(next);
    ordered.push(plugins[next]);
    for (const target of edges[next]) incoming[target]--;
  }
  return ordered;
}
