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
      { previousBindingNames: ['previous'], cellId: 'cell-1' },
    );
    expect(prepared.source).toContain("from '@prev'");
    expect(prepared.source).toMatch(/let previous = .*previous/);
    expect(prepared.bindingExports.map((entry) => entry.bindingName)).toEqual([
      'next',
      'previous',
    ]);
    expect(prepared.resultExportName).toBeDefined();
  });

  it('does not carry a previous binding when the new cell redeclares it', async () => {
    const prepared = await prepareNodeReplCell('const value = 2;', {
      previousBindingNames: ['value'],
      cellId: 'cell-2',
    });
    expect(prepared.source).not.toMatch(/let value = .*previous/);
    expect(prepared.source).toContain('["value"] =');
  });

  it('keeps generated names distinct from carried bindings', async () => {
    const colliding = '__qwen_repl_collision_0__snapshot';
    const prepared = await prepareNodeReplCell('1;', {
      previousBindingNames: [colliding],
      cellId: 'collision',
    });
    expect(prepared.source).toContain(`let ${colliding} =`);
    expect(prepared.snapshotExportName).not.toBe(
      '__qwen_repl_collision_0__snapshot_export',
    );

    const escapedCollision = await prepareNodeReplCell(
      String.raw`const \u005f\u005fqwen_repl_escape_0__snapshot = 1;`,
      { previousBindingNames: [], cellId: 'escape' },
    );
    expect(escapedCollision.snapshotExportName).not.toBe(
      '__qwen_repl_escape_0__snapshot_export',
    );

    const escapedReference = await prepareNodeReplCell(
      String.raw`typeof \u005f\u005fqwen_repl_escape_0__snapshot;`,
      { previousBindingNames: [], cellId: 'escape' },
    );
    expect(escapedReference.snapshotExportName).not.toBe(
      '__qwen_repl_escape_0__snapshot_export',
    );
  });

  it('normalizes Unicode escapes to their JavaScript binding names', async () => {
    const prepared = await prepareNodeReplCell(String.raw`const \u0061 = 1;`, {
      previousBindingNames: [],
      cellId: 'escaped-binding',
    });
    expect(prepared.bindingExports.map((entry) => entry.bindingName)).toEqual([
      'a',
    ]);
    expect(prepared.source).toContain('["a"] = a;');

    const redeclared = await prepareNodeReplCell(
      String.raw`const \u0061 = 2;`,
      { previousBindingNames: ['a'], cellId: 'escaped-redeclaration' },
    );
    expect(redeclared.source).not.toMatch(/let a = .*previous/);
  });

  it('collects destructuring, function, class, import, and Unicode names', async () => {
    const prepared = await prepareNodeReplCell(
      [
        'import named, { other as alias } from "./fixture.mjs";',
        'const { a: renamed, nested: [first] } = { a: 1, nested: [2] };',
        'function read() { return renamed; }',
        'class Box {}',
        'const 变量 = first;',
      ].join('\n'),
      { previousBindingNames: [], cellId: 'cell-3' },
    );
    expect(prepared.bindingExports.map((entry) => entry.bindingName)).toEqual([
      'Box',
      'alias',
      'first',
      'named',
      'read',
      'renamed',
      '变量',
    ]);
  });

  it('collects module-scoped var declarations inside top-level statements', async () => {
    const prepared = await prepareNodeReplCell(
      [
        'if (true) { var fromBlock = 1; }',
        'for (var loopIndex = 0; loopIndex < 1; loopIndex++) {}',
        'function nested() { var hidden = 1; }',
      ].join('\n'),
      { previousBindingNames: [], cellId: 'hoisted-var' },
    );
    expect(prepared.bindingExports.map((entry) => entry.bindingName)).toEqual([
      'fromBlock',
      'loopIndex',
      'nested',
    ]);
  });

  it('inserts statement-boundary snapshots without corrupting Unicode', async () => {
    const prepared = await prepareNodeReplCell(
      'const 变量 = "你好";\nthrow new Error("停止");\nfunction ghost() {}',
      { previousBindingNames: ['old'], cellId: 'cell-4' },
    );
    expect(prepared.source).toContain('const 变量 = "你好";');
    expect(prepared.source).toContain('throw new Error("停止");');
    const firstCommit = prepared.source.indexOf('["变量"] = 变量;');
    const thrown = prepared.source.indexOf('throw new Error');
    const ghostCommit = prepared.source.indexOf('["ghost"] = ghost;');
    expect(firstCommit).toBeGreaterThan(0);
    expect(firstCommit).toBeLessThan(thrown);
    expect(ghostCommit).toBeGreaterThan(thrown);
  });

  it('does not capture a final result when the final item is a declaration', async () => {
    const prepared = await prepareNodeReplCell('const value = 1;', {
      previousBindingNames: [],
      cellId: 'cell-5',
    });
    expect(prepared.resultExportName).toBeUndefined();
  });

  it('rejects syntax errors and hashbangs instead of degrading semantics', async () => {
    await expect(
      prepareNodeReplCell('const = ;', {
        previousBindingNames: [],
        cellId: 'bad',
      }),
    ).rejects.toThrow(/parse/i);
    await expect(
      prepareNodeReplCell('#!/usr/bin/env node\n1;', {
        previousBindingNames: [],
        cellId: 'hashbang',
      }),
    ).rejects.toThrow(/hashbang/i);
  });

  it('rejects source and snapshot shapes that could exhaust the host', async () => {
    await expect(
      prepareNodeReplCell('x'.repeat(4 * 1024 * 1024 + 1), {
        previousBindingNames: [],
        cellId: 'oversized',
      }),
    ).rejects.toThrow(/source sanity limit/);

    const declarations = Array.from(
      { length: 450 },
      (_, index) => `let value${index} = ${index};`,
    ).join('\n');
    await expect(
      prepareNodeReplCell(declarations, {
        previousBindingNames: [],
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
        previousBindingNames: [],
        cellId: 'long-identifier',
      }),
    ).rejects.toThrow(/transformed JavaScript cell exceeds/i);

    const accumulatedLongNames = Array.from(
      { length: 43 },
      (_, index) => `binding${index}_${'x'.repeat(100_000)}`,
    );
    await expect(
      prepareNodeReplCell('0;', {
        previousBindingNames: accumulatedLongNames,
        cellId: 'accumulated-long-identifiers',
      }),
    ).rejects.toThrow(/cumulative binding-name sanity limit/i);
  });
});
