/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { prepareNodeReplCell } from './cell-transform.js';

describe('prepareNodeReplCell', () => {
  it('carries previous bindings through @prev and exports current bindings', async () => {
    const prepared = await prepareNodeReplCell(
      'const next = previous + 1; next;',
      {
        previousBindings: [{ name: 'previous', kind: 'const' }],
        cellId: 'cell-1',
      },
    );
    expect(prepared.source).toContain("from '@prev'");
    expect(prepared.source).toMatch(/const previous = .*previous/);
    expect(prepared.bindingExports.map((entry) => entry.bindingName)).toEqual([
      'next',
      'previous',
    ]);
    expect(
      prepared.bindingExports.map(({ bindingName, bindingKind }) => [
        bindingName,
        bindingKind,
      ]),
    ).toEqual([
      ['next', 'const'],
      ['previous', 'const'],
    ]);
    expect(prepared.source).toContain('next;');
  });

  it('carries a previous binding with its declaration kind so conflicts are native', async () => {
    const prepared = await prepareNodeReplCell('const value = 2;', {
      previousBindings: [{ name: 'value', kind: 'const' }],
      cellId: 'cell-2',
    });
    expect(prepared.source).toMatch(/const value = .*previous/);
    expect(prepared.source).toContain('["value"] =');
  });

  it('keeps generated names distinct from carried bindings', async () => {
    const colliding = '__qwen_repl_collision_0__snapshot';
    const prepared = await prepareNodeReplCell('1;', {
      previousBindings: [{ name: colliding, kind: 'let' }],
      cellId: 'collision',
    });
    expect(prepared.source).toContain(`let ${colliding} =`);
    expect(prepared.snapshotExportName).not.toBe(
      '__qwen_repl_collision_0__snapshot_export',
    );

    const escapedCollision = await prepareNodeReplCell(
      String.raw`const \u005f\u005fqwen_repl_escape_0__snapshot = 1;`,
      { previousBindings: [], cellId: 'escape' },
    );
    expect(escapedCollision.snapshotExportName).not.toBe(
      '__qwen_repl_escape_0__snapshot_export',
    );

    const escapedReference = await prepareNodeReplCell(
      String.raw`typeof \u005f\u005fqwen_repl_escape_0__snapshot;`,
      { previousBindings: [], cellId: 'escape' },
    );
    expect(escapedReference.snapshotExportName).not.toBe(
      '__qwen_repl_escape_0__snapshot_export',
    );
  });

  it('normalizes Unicode escapes to their JavaScript binding names', async () => {
    const prepared = await prepareNodeReplCell(String.raw`const \u0061 = 1;`, {
      previousBindings: [],
      cellId: 'escaped-binding',
    });
    expect(prepared.bindingExports.map((entry) => entry.bindingName)).toEqual([
      'a',
    ]);
    expect(prepared.source).toContain('["a"] = a;');

    const redeclared = await prepareNodeReplCell(
      String.raw`const \u0061 = 2;`,
      {
        previousBindings: [{ name: 'a', kind: 'const' }],
        cellId: 'escaped-redeclaration',
      },
    );
    expect(redeclared.source).toMatch(/const a = .*previous/);
  });

  it('collects destructuring, function, class, and Unicode names', async () => {
    const prepared = await prepareNodeReplCell(
      [
        'const { a: renamed, nested: [first] } = { a: 1, nested: [2] };',
        'function read() { return renamed; }',
        'class Box {}',
        'const 变量 = first;',
      ].join('\n'),
      { previousBindings: [], cellId: 'cell-3' },
    );
    expect(prepared.bindingExports.map((entry) => entry.bindingName)).toEqual([
      'Box',
      'first',
      'read',
      'renamed',
      '变量',
    ]);
    expect(
      Object.fromEntries(
        prepared.bindingExports.map(({ bindingName, bindingKind }) => [
          bindingName,
          bindingKind,
        ]),
      ),
    ).toEqual({
      Box: 'let',
      first: 'const',
      read: 'let',
      renamed: 'const',
      变量: 'const',
    });
  });

  it('persists var declarations nested inside top-level statements (hoisting)', async () => {
    const prepared = await prepareNodeReplCell(
      [
        'if (true) { var fromBlock = 1; }',
        'for (var loopIndex = 0; loopIndex < 1; loopIndex++) {}',
        'for (; false;) var fromBareLoopBody = 1;',
        'for (const value of []) var fromBareForOfBody = value;',
        'function nested() { var hidden = 1; }',
      ].join('\n'),
      { previousBindings: [], cellId: 'hoisted-var' },
    );
    // `var` hoists to module scope from blocks and loop bodies, so all of these
    // must persist. `hidden` must NOT: it belongs to nested()'s function scope.
    expect(
      prepared.bindingExports.map((entry) => entry.bindingName).sort(),
    ).toEqual([
      'fromBareForOfBody',
      'fromBareLoopBody',
      'fromBlock',
      'loopIndex',
      'nested',
    ]);
  });

  it('does not persist var declarations from inner function scopes', async () => {
    const prepared = await prepareNodeReplCell(
      [
        'function fn() { var inFn = 1; }',
        'const arrow = () => { var inArrow = 2; };',
        'class Klass { method() { var inMethod = 3; } }',
        'var kept = 4;',
      ].join('\n'),
      { previousBindings: [], cellId: 'fn-scope-var' },
    );
    expect(
      prepared.bindingExports.map((entry) => entry.bindingName).sort(),
    ).toEqual(['Klass', 'arrow', 'fn', 'kept']);
  });

  it('persists var bindings from each top-level loop initializer form', async () => {
    const prepared = await prepareNodeReplCell(
      [
        'for (var classic = 0; classic < 1; classic++) {}',
        'for (var objectKey in {}) {}',
        'for (var [arrayValue] of []) {}',
      ].join('\n'),
      { previousBindings: [], cellId: 'loop-initializers' },
    );
    expect(prepared.bindingExports.map((entry) => entry.bindingName)).toEqual([
      'arrayValue',
      'classic',
      'objectKey',
    ]);
  });

  it('inserts statement-boundary snapshots without corrupting Unicode', async () => {
    const prepared = await prepareNodeReplCell(
      'const 变量 = "你好";\nthrow new Error("停止");\nfunction ghost() {}',
      {
        previousBindings: [{ name: 'old', kind: 'const' }],
        cellId: 'cell-4',
      },
    );
    expect(prepared.source).toContain('const 变量 = "你好",');
    expect(prepared.source).toContain('throw new Error("停止");');
    const firstCommit = prepared.source.indexOf('["变量"] = 变量;');
    const thrown = prepared.source.indexOf('throw new Error');
    const ghostCommit = prepared.source.indexOf('["ghost"] = ghost;');
    expect(firstCommit).toBeGreaterThan(0);
    expect(firstCommit).toBeLessThan(thrown);
    expect(ghostCommit).toBeGreaterThan(thrown);
  });

  it('does not synthesize an export for the final expression', async () => {
    const prepared = await prepareNodeReplCell('const value = 1; value + 1;', {
      previousBindings: [],
      cellId: 'cell-5',
    });
    expect(prepared.source).toContain('value + 1;');
    expect(prepared.source).not.toContain('_result_export');
  });

  it('guards every explicit and implicit async continuation', async () => {
    const prepared = await prepareNodeReplCell(
      [
        'const first = await load();',
        'async function nested() { return await loadAgain(); }',
        'for await (const item of stream) { nodeRepl.write(item); }',
      ].join('\n'),
      { previousBindings: [], cellId: 'async-guards' },
    );
    expect(prepared.source).toContain(
      'await nodeRepl.signal.guardAwait(load())',
    );
    expect(prepared.source).toContain(
      'return await nodeRepl.signal.guardAwait(loadAgain())',
    );
    expect(prepared.source).toContain(
      'for await (const item of nodeRepl.signal.guardAsyncIterable(stream))',
    );
  });

  it('keeps user-exported declarations local to their cell', async () => {
    const prepared = await prepareNodeReplCell(
      [
        'export const exported = 1;',
        'export var exportedVar = 1;',
        'var exportedVar = 2;',
        'nodeRepl.write(exported + exportedVar);',
      ].join('\n'),
      { previousBindings: [], cellId: 'user-export' },
    );
    expect(prepared.bindingExports).toEqual([]);
    expect(prepared.source).not.toContain('["exported"] = exported;');
  });

  it('rejects exported declarations that collide with a previous binding', async () => {
    for (const source of [
      'export var existing = 2;',
      'export function existing() {}',
      'export const existing = 2;',
    ]) {
      await expect(
        prepareNodeReplCell(source, {
          previousBindings: [{ name: 'existing', kind: 'var' }],
          cellId: 'export-collision',
        }),
      ).rejects.toThrow("Identifier 'existing' has already been declared");
    }
  });

  it('rejects top-level static imports and directs callers to dynamic import', async () => {
    for (const source of [
      'import value from "fixture";',
      'export { value } from "fixture";',
      'export * from "fixture";',
    ]) {
      await expect(
        prepareNodeReplCell(source, {
          previousBindings: [],
          cellId: 'static-import',
        }),
      ).rejects.toThrow(
        'Top-level static import "fixture" is not supported in node_repl. Use await import("fixture") instead.',
      );
    }
  });

  it('rejects syntax errors and hashbangs instead of degrading semantics', async () => {
    await expect(
      prepareNodeReplCell('const = ;', {
        previousBindings: [],
        cellId: 'bad',
      }),
    ).rejects.toThrow(/parse/i);
    await expect(
      prepareNodeReplCell('#!/usr/bin/env node\n1;', {
        previousBindings: [],
        cellId: 'hashbang',
      }),
    ).rejects.toThrow(/hashbang/i);
  });

  it('rejects source and snapshot shapes that could exhaust the host', async () => {
    await expect(
      prepareNodeReplCell('x'.repeat(4 * 1024 * 1024 + 1), {
        previousBindings: [],
        cellId: 'oversized',
      }),
    ).rejects.toThrow(/source sanity limit/);

    const declarations = Array.from(
      { length: 450 },
      (_, index) => `let value${index} = ${index};`,
    ).join('\n');
    await expect(
      prepareNodeReplCell(declarations, {
        previousBindings: [],
        cellId: 'quadratic',
      }),
    ).rejects.toThrow(/statement-boundary binding snapshots/);

    const longName = `binding${'x'.repeat(100_000)}`;
    const longIdentifierSnapshots = [
      `let ${longName} = 1;`,
      ...Array.from({ length: 180 }, () => '0;'),
    ].join('\n');
    await expect(
      prepareNodeReplCell(longIdentifierSnapshots, {
        previousBindings: [],
        cellId: 'long-identifier',
      }),
    ).rejects.toThrow(/transformed JavaScript cell exceeds/i);

    const accumulatedLongNames = Array.from(
      { length: 43 },
      (_, index) => `binding${index}_${'x'.repeat(100_000)}`,
    );
    await expect(
      prepareNodeReplCell('0;', {
        previousBindings: accumulatedLongNames.map((name) => ({
          name,
          kind: 'let' as const,
        })),
        cellId: 'accumulated-long-identifiers',
      }),
    ).rejects.toThrow(/cumulative binding-name sanity limit/i);
  });
});
