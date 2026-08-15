/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ESLint } from 'eslint';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

const eslint = new ESLint({ cwd: repoRoot });

const lintCliFile = (filePath, code) =>
  eslint.lintText(code, { filePath: path.join(repoRoot, filePath) });

const expectServeBoundaryError = async (filePath, code) => {
  const [result] = await lintCliFile(filePath, code);
  expect(result.messages.map((message) => message.message)).toEqual(
    expect.arrayContaining([expect.stringContaining('serve')]),
  );
};

describe('eslint cli serve boundary rules', () => {
  it('rejects static and dynamic serve imports from runtime', async () => {
    await expectServeBoundaryError(
      'packages/cli/src/runtime/boundary-fixture.ts',
      "import '../serve/index.js';",
    );

    await expectServeBoundaryError(
      'packages/cli/src/runtime/boundary-fixture.ts',
      "export async function load() { await import('../serve/index.js'); }",
    );
  });

  it('rejects acp dynamic serve imports through template and traversal paths', async () => {
    await expectServeBoundaryError(
      'packages/cli/src/acp-integration/boundary-fixture.ts',
      'export async function load() { await import(`../serve/acp-http/dispatch.js`); }',
    );

    await expectServeBoundaryError(
      'packages/cli/src/acp-integration/boundary-fixture.ts',
      "export async function load() { await import('../runtime/../serve/index.js'); }",
    );

    await expectServeBoundaryError(
      'packages/cli/src/acp-integration/boundary-fixture.ts',
      "export async function load() { await import('./../serve/index.js'); }",
    );

    await expectServeBoundaryError(
      'packages/cli/src/acp-integration/boundary-fixture.ts',
      "import '../serve/index.js';",
    );
  });

  it('rejects static and dynamic serve imports from utils', async () => {
    await expectServeBoundaryError(
      'packages/cli/src/utils/boundary-fixture.ts',
      "import '../serve/index.js';",
    );

    await expectServeBoundaryError(
      'packages/cli/src/utils/boundary-fixture.ts',
      "export async function load() { await import('../serve/index.js'); }",
    );
  });

  // R5-4: pins the bare-directory specifier (`../serve` resolves to the
  // serve/ barrel) for both static and dynamic forms in utils/ — reverting
  // the bare-entry hunk must turn this red.
  it('rejects the bare serve barrel specifier', async () => {
    await expectServeBoundaryError(
      'packages/cli/src/utils/boundary-fixture.ts',
      "import '../serve';",
    );

    await expectServeBoundaryError(
      'packages/cli/src/runtime/boundary-fixture.ts',
      "export async function load() { await import('../serve'); }",
    );
  });

  // R4-1: the per-spelling regex entrances demonstrated in round 4 —
  // duplicated separators, traversal through intermediate segments,
  // concatenated sources, `new URL(...)` sources, and type-level imports.
  it('rejects non-canonical and computed dynamic serve imports', async () => {
    const runtime = 'packages/cli/src/runtime/boundary-fixture.ts';

    await expectServeBoundaryError(
      runtime,
      "export async function load() { await import('..//serve/index.js'); }",
    );

    await expectServeBoundaryError(
      runtime,
      "export async function load() { await import('../foo/../../../serve/index.js'); }",
    );

    await expectServeBoundaryError(
      runtime,
      "export async function load() { await import('../serve/' + 'index.js'); }",
    );

    await expectServeBoundaryError(
      runtime,
      'export async function load() { await import(new URL("../serve/index.js", import.meta.url)); }',
    );

    await expectServeBoundaryError(
      runtime,
      'export type Leak = import("../serve/live/types.js").Leak;',
    );
  });

  // R5-5: the override blocks restate restrictedStringThrow; flat config's
  // last-wins semantics mean dropping the restatement would silently legalize
  // string throws in exactly these trees. This probe pins it.
  it('still rejects string throws inside the guarded overrides', async () => {
    const [result] = await lintCliFile(
      'packages/cli/src/acp-integration/boundary-fixture.ts',
      "export function boom() { throw 'boom'; }",
    );
    expect(result.messages.map((message) => message.message)).toEqual(
      expect.arrayContaining([expect.stringContaining('throw')]),
    );
  });

  // R5-7: third-party packages whose name contains `serve` must not be
  // caught by the boundary (the old `**/serve*` globs matched them).
  it('allows third-party serve-named packages', async () => {
    const code = [
      "import handler from 'serve';",
      "import scoped from '@scope/serve';",
      "import sub from '@scope/serve/handler.js';",
      '',
    ].join('\n');
    const [result] = await lintCliFile(
      'packages/cli/src/acp-integration/boundary-fixture.ts',
      code,
    );
    const boundaryHits = result.messages.filter((message) =>
      message.message.includes('serve/ internals'),
    );
    expect(boundaryHits).toEqual([]);
  });
});
