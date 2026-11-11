/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PLUGINS_DIR = dirname(fileURLToPath(import.meta.url));

function listProductionModules(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return listProductionModules(path);
    if (
      !entry.name.endsWith('.ts') ||
      entry.name.endsWith('.test.ts') ||
      path === resolve(PLUGINS_DIR, 'index.ts')
    ) {
      return [];
    }
    return [path];
  });
}

function getRelativePluginImports(modulePath: string): string[] {
  const source = readFileSync(modulePath, 'utf8');
  const imports: string[] = [];
  const importPattern = /\bfrom\s+['"]([^'"]+)['"]/g;

  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (!specifier.startsWith('.')) continue;

    const target = resolve(dirname(modulePath), specifier.replace(/\.js$/, '.ts'));
    const targetRelativePath = relative(PLUGINS_DIR, target);
    if (
      targetRelativePath !== '' &&
      !targetRelativePath.startsWith('..') &&
      !targetRelativePath.startsWith('/')
    ) {
      imports.push(target);
    }
  }

  return imports;
}

function findStronglyConnectedComponents(
  graph: ReadonlyMap<string, readonly string[]>,
): string[][] {
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  function visit(modulePath: string): void {
    indices.set(modulePath, nextIndex);
    lowLinks.set(modulePath, nextIndex);
    nextIndex++;
    stack.push(modulePath);
    onStack.add(modulePath);

    for (const dependency of graph.get(modulePath) ?? []) {
      if (!graph.has(dependency)) continue;
      if (!indices.has(dependency)) {
        visit(dependency);
        lowLinks.set(
          modulePath,
          Math.min(lowLinks.get(modulePath)!, lowLinks.get(dependency)!),
        );
      } else if (onStack.has(dependency)) {
        lowLinks.set(
          modulePath,
          Math.min(lowLinks.get(modulePath)!, indices.get(dependency)!),
        );
      }
    }

    if (lowLinks.get(modulePath) !== indices.get(modulePath)) return;

    const component: string[] = [];
    let current: string;
    do {
      current = stack.pop()!;
      onStack.delete(current);
      component.push(relative(PLUGINS_DIR, current));
    } while (current !== modulePath);
    components.push(component.sort());
  }

  for (const modulePath of graph.keys()) {
    if (!indices.has(modulePath)) visit(modulePath);
  }

  return components.filter((component) => component.length > 1).sort();
}

describe('plugin module architecture', () => {
  const modules = listProductionModules(PLUGINS_DIR);
  const graph = new Map(
    modules.map((modulePath) => [
      modulePath,
      getRelativePluginImports(modulePath),
    ]),
  );

  it('does not import the public plugin barrel from implementation modules', () => {
    const violations = modules.flatMap((modulePath) =>
      (graph.get(modulePath) ?? [])
        .filter((dependency) => dependency === resolve(PLUGINS_DIR, 'index.ts'))
        .map(() => relative(PLUGINS_DIR, modulePath)),
    );

    expect(violations).toEqual([]);
  });

  it('does not introduce dependency cycles beyond the existing baseline', () => {
    // Remove this allowlisted component when dependency installation no longer
    // calls back into pluginOperations.
    expect(findStronglyConnectedComponents(graph)).toEqual([
      [
        'management/pluginDependencies.ts',
        'management/pluginOperations.ts',
      ],
    ]);
  });
});
