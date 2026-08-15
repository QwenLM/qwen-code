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

  // Round 6: the depth-enumeration loop must stay pinned beyond depth 1 —
  // real acp-integration files reach serve via `../../serve/...` (depth 2),
  // so a fixture at that depth turns a regressed loop bound red.
  it('rejects static serve imports from a depth-2 guarded file', async () => {
    await expectServeBoundaryError(
      'packages/cli/src/acp-integration/session/boundary-fixture.ts',
      "import '../../serve/index.js';",
    );
  });

  // Round 6: type-level imports wrap the specifier in a TSLiteralType; the
  // selector must read argument.literal.value. Legitimate type imports of
  // third-party modules must stay clean.
  it('flags serve type imports but allows legitimate typeof imports', async () => {
    await expectServeBoundaryError(
      'packages/cli/src/runtime/boundary-fixture.ts',
      'export type Leak = import("../serve/live/types.js").Leak;',
    );

    const [result] = await lintCliFile(
      'packages/cli/src/runtime/boundary-fixture.ts',
      "export type UndiciModule = typeof import('undici');",
    );
    expect(result.messages).toEqual([]);
  });

  // Round 6: template literals containing expressions are computed sources
  // and are rejected fail-closed (the pure-literal template form is caught
  // by the quasis pattern selectors instead).
  it('rejects computed template-literal dynamic imports fail-closed', async () => {
    const [result] = await lintCliFile(
      'packages/cli/src/runtime/boundary-fixture.ts',
      'export async function load(base: string) { await import(`${base}/serve/x.js`); }',
    );
    expect(result.messages.map((message) => message.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('computed import sources cannot be checked'),
      ]),
    );
  });

  // Round 6 (remaining entrances): percent-encoded segments, static
  // traversal twins, and the leading-literal-segment dynamic spelling.
  it('rejects percent-encoded and static-traversal boundary entrances', async () => {
    const acp = 'packages/cli/src/acp-integration/boundary-fixture.ts';

    // Node percent-decodes segments when mapping to the filesystem, so
    // raw-text patterns cannot see through %73 === 's'.
    await expectServeBoundaryError(acp, "import '../%73erve/index.js';");
    await expectServeBoundaryError(
      acp,
      "export async function load() { await import('../%73erve/index.js'); }",
    );

    // Static twins of the blocked dynamic spellings.
    await expectServeBoundaryError(acp, "import './../serve/index.js';");
    await expectServeBoundaryError(
      acp,
      "import '../runtime/../serve/index.js';",
    );
    await expectServeBoundaryError(acp, "import '..//serve/index.js';");
  });

  it('rejects a leading literal segment before the traversal run', async () => {
    await expectServeBoundaryError(
      'packages/cli/src/acp-integration/boundary-fixture.ts',
      "export async function load() { await import('foo/../../../serve/index.js'); }",
    );
  });

  // vitest module-loading calls resolve (and without a factory load) the
  // real module, so the boundary applies to them too.
  it('rejects serve specifiers in vitest module-loading calls', async () => {
    const acp = 'packages/cli/src/acp-integration/boundary-fixture.ts';
    await expectServeBoundaryError(
      acp,
      "vi.mock('../../serve/live/live-task-service.js');",
    );
    await expectServeBoundaryError(
      acp,
      "export async function load() { return vi.importActual('../../serve/live/live-task-service.js'); }",
    );
    await expectServeBoundaryError(
      acp,
      "vitest.mock('../../serve/live/live-task-service.js');",
    );

    // A non-serve vi.mock stays silent on the boundary.
    const [result] = await lintCliFile(acp, "vi.mock('../utils/foo.js');");
    const boundaryHits = result.messages.filter((message) =>
      message.message.includes('serve'),
    );
    expect(boundaryHits).toEqual([]);
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
