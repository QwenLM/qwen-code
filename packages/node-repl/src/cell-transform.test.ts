/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { prepareNodeReplCell } from './cell-transform.js';

/**
 * Compile `source` the way the kernel does: in a child process started with
 * `--experimental-vm-modules`, parsed by `vm.SourceTextModule` (see
 * `kernel-manager.ts`). Doing it in a child keeps the flag out of the test runner's
 * pool configuration, which cannot carry it when the suite is launched from the
 * repository root.
 */
function compileInChild(source: string, identifier: string): void {
  try {
    execFileSync(
      process.execPath,
      [
        '--experimental-vm-modules',
        '--input-type=module',
        '-e',
        "import * as vm from 'node:vm';" +
          "let source='';" +
          'for await (const chunk of process.stdin) source += chunk;' +
          'new vm.SourceTextModule(source, { identifier: process.argv[1] });',
        identifier,
      ],
      { input: source, stdio: ['pipe', 'ignore', 'pipe'] },
    );
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(
      `${identifier} does not compile: ${stderr || String(error)}`,
    );
  }
}

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

  it('keeps a cell parseable when a top-level statement omits its semicolon', async () => {
    // Invariant: the commit must be terminated, so the identifier it starts with can
    // never be glued onto the user's last token. Several edits land on the same
    // top-level statement boundary — declarator markers, the cancellation guard, the
    // carried-reference tail, and the commit itself — and the commit must sort last
    // among them. A leading `;` is what makes that true whatever the user wrote.
    //
    // The fixtures cover an inherited expression (with two bindings), a fresh `var`
    // declaration, quote and template tails, a carried reference, an `await` guard,
    // and an intermediate boundary in a multi-statement cell.
    const cases = {
      expression: {
        firstCommitKey: 'a',
        prepared: await prepareNodeReplCell('next', {
          previousBindings: [
            { name: 'a', kind: 'const' },
            { name: 'b', kind: 'const' },
          ],
          cellId: 'cell-omit-semicolon',
        }),
      },
      declaration: {
        firstCommitKey: 'next',
        prepared: await prepareNodeReplCell('var next = 1', {
          previousBindings: [],
          cellId: 'cell-omit-semicolon-declaration',
        }),
      },
      literal: {
        firstCommitKey: 'previous',
        prepared: await prepareNodeReplCell("'literal'", {
          previousBindings: [{ name: 'previous', kind: 'const' }],
          cellId: 'cell-omit-semicolon-literal',
        }),
      },
      template: {
        firstCommitKey: 'previous',
        prepared: await prepareNodeReplCell('`done: ${previous}`', {
          previousBindings: [{ name: 'previous', kind: 'const' }],
          cellId: 'cell-omit-semicolon-template',
        }),
      },
      carried: {
        firstCommitKey: 'handler',
        prepared: await prepareNodeReplCell('handler = () => 1', {
          previousBindings: [{ name: 'handler', kind: 'let' }],
          cellId: 'cell-omit-semicolon-carried',
        }),
      },
      guard: {
        firstCommitKey: 'previous',
        prepared: await prepareNodeReplCell('await load()', {
          previousBindings: [{ name: 'previous', kind: 'const' }],
          cellId: 'cell-omit-semicolon-guard',
        }),
      },
      multi: {
        firstCommitKey: 'a',
        prepared: await prepareNodeReplCell('const a = 1\nconst b = 2', {
          previousBindings: [],
          cellId: 'cell-omit-semicolon-multi',
        }),
      },
    };

    for (const [
      name,
      {
        prepared: { source },
      },
    ] of Object.entries(cases)) {
      expect(() => compileInChild(source, `cell:${name}`)).not.toThrow();
    }

    // Compiling alone cannot catch a legal glued identifier tail or a missing commit,
    // so pin the leading terminator to the first binding of each commit. The expression
    // fixture carries two bindings to ensure an interior assignment separator cannot
    // satisfy this assertion.
    const bodyLine = (source: string): string => source.split('\n')[1] ?? '';
    for (const [
      name,
      {
        firstCommitKey,
        prepared: { source },
      },
    ] of Object.entries(cases)) {
      expect(bodyLine(source), `${name}: terminator before the commit`).toMatch(
        new RegExp(
          `;__qwen_repl_\\w+__snapshot\\[${JSON.stringify(firstCommitKey)}\\] = \\{binding:`,
        ),
      );
    }

    // The declaration marker and carried-reference rewrite share a commit offset, so
    // the commit must still sort after each of them.
    expect(bodyLine(cases.declaration.prepared.source)).toMatch(
      /undefined\);__qwen_repl_\w+__snapshot\["next"\] = \{binding:/,
    );
    expect(bodyLine(cases.carried.prepared.source)).toContain(
      '})["handler"];__qwen_repl_',
    );
    // `multi` reaches the first commit at an intermediate statement boundary.
    expect(bodyLine(cases.multi.prepared.source)).toMatch(
      /undefined\);__qwen_repl_\w+__snapshot\["a"\] = \{binding:/,
    );

    // LINE_OFFSET invariant: the prelude occupies exactly one physical line, so the
    // user's first line stays physical line 2 and stack traces keep lining up with the
    // code the model wrote. Terminating the commit must not add a line.
    expect(bodyLine(cases.expression.prepared.source)).toContain('next');
    expect(bodyLine(cases.declaration.prepared.source)).toContain(
      'var next = 1',
    );
    // The carried-reference rewrite keeps the user's code on physical line 2 too.
    expect(bodyLine(cases.carried.prepared.source)).toContain(
      '({["handler"]:() => 1})["handler"];',
    );
  });

  it('rejects ambiguous tagged-template statement boundaries', async () => {
    const options = {
      previousBindings: [{ name: 'previous', kind: 'const' }] as const,
      cellId: 'tagged-template-newline',
    };

    for (const code of [
      'const t = html\n`<p>`',
      'const t = html /* comment */\n`<p>`',
      'const t = html // comment\n`<p>`',
      'var t = html /* comment */\n`<p>`',
      'const a = 1, t = html /* comment */\n`<p>`',
      'export const t = html /* comment */\n`<p>`',
      'make()\n`<p>`',
      'tag /* comment */\n`<p>`',
      'if (true) tag\n`<p>`',
    ]) {
      await expect(prepareNodeReplCell(code, options)).rejects.toThrow(
        /tagged template/,
      );
    }

    // A carried `var` loop body is rewritten and re-parsed as a block, so the
    // ambiguity must be recorded from the original source-item boundary.
    const carriedVarOptions = {
      previousBindings: [{ name: 'k', kind: 'var' }] as const,
      cellId: 'tagged-template-carried-var',
    };
    await expect(
      prepareNodeReplCell('for (var k in obj) tag\n`<p>`', carriedVarOptions),
    ).rejects.toThrow(/tagged template/);
    const { source: carriedVarControl } = await prepareNodeReplCell(
      'for (var k in obj) tag;\n`<p>`',
      carriedVarOptions,
    );
    expect(() =>
      compileInChild(carriedVarControl, 'template-control:carried-var'),
    ).not.toThrow();
    const { source: carriedVarSameLine } = await prepareNodeReplCell(
      'for (var k in obj) tag`<p>`',
      carriedVarOptions,
    );
    expect(() =>
      compileInChild(
        carriedVarSameLine,
        'template-control:carried-var-same-line',
      ),
    ).not.toThrow();
    // With no bindings there is no injected commit or semicolon, so this native
    // tagged template must remain allowed.
    const { source: noCommitTaggedTemplate } = await prepareNodeReplCell(
      'tag\n`<p>`',
      { previousBindings: [], cellId: 'tagged-template-no-commit' },
    );
    expect(() =>
      compileInChild(noCommitTaggedTemplate, 'template-control:no-commit'),
    ).not.toThrow();

    for (const [index, code] of [
      'const t = html; /* separate statements */\n`<p>`',
      'const t = html; // separate statements\n`<p>`',
      'const t = html`<p>`',
      'function f() {}\n`<p>`',
      'class C {}\n`<p>`',
      'if (true) {}\n`<p>`',
    ].entries()) {
      const { source } = await prepareNodeReplCell(code, options);
      expect(() =>
        compileInChild(source, `template-control:${index}`),
      ).not.toThrow();
    }
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
    expect(prepared.source).toContain('get value(){return a;}');
    expect(prepared.source).toMatch(
      /\["a"\] = \{binding:.*value:.*\["a"\]\.value\}/,
    );

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
    const firstCommit = prepared.source.indexOf('["变量"] = {binding:');
    const thrown = prepared.source.indexOf('throw new Error');
    const ghostCommit = prepared.source.indexOf('["ghost"] = {binding:');
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
      'await  nodeRepl.signal.guardAwait(load())',
    );
    expect(prepared.source).toContain(
      'return await  nodeRepl.signal.guardAwait(loadAgain())',
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
