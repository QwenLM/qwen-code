/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ESLint } from 'eslint';
import { rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

const eslint = new ESLint({ cwd: repoRoot });

const RULE_ID = 'qwen-boundary/no-serve-boundary-cross';
const ACP_FIXTURE = 'packages/cli/src/acp-integration/boundary-fixture.ts';
const RUNTIME_FIXTURE = 'packages/cli/src/runtime/boundary-fixture.ts';

const lintCliFile = (filePath, code) =>
  eslint.lintText(code, { filePath: path.join(repoRoot, filePath) });

const expectServeBoundaryError = async (filePath, code) => {
  const [result] = await lintCliFile(filePath, code);
  expect(result.messages.map((message) => message.message)).toEqual(
    expect.arrayContaining([expect.stringContaining('serve')]),
  );
};

/** Assert the boundary rule produced NO diagnostics for `code`. Filters on
 *  the rule id (stricter than a 'serve' substring: also catches failClosed
 *  over-blocking from this rule). */
const expectNoBoundaryHits = async (filePath, code) => {
  const [result] = await lintCliFile(filePath, code);
  const boundaryHits = result.messages.filter(
    (message) => message.ruleId === RULE_ID,
  );
  expect(boundaryHits).toEqual([]);
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
      "export async function load() { await import('../foo/../serve/index.js'); }",
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

  // R5-5: the general packages/**/src/** block supplies
  // restrictedStringThrow; the guarded-tree override blocks only ADD the
  // boundary rule. This probe pins that the general block's rule still
  // applies inside the guarded trees despite those overrides.
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
  // and are rejected fail-closed (pure-literal template forms are resolved
  // like string literals instead).
  it('rejects computed template-literal dynamic imports fail-closed', async () => {
    const [result] = await lintCliFile(
      'packages/cli/src/runtime/boundary-fixture.ts',
      'export async function load(base: string) { await import(`${base}/serve/x.js`); }',
    );
    expect(result.messages.map((message) => message.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('cannot be resolved statically'),
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
      "export async function load() { await import('foo/../../serve/index.js'); }",
    );
  });

  // vitest module-loading calls resolve (and without a factory load) the
  // real module, so the boundary applies to them too.
  it('rejects serve specifiers in vitest module-loading calls', async () => {
    const acp = 'packages/cli/src/acp-integration/boundary-fixture.ts';
    await expectServeBoundaryError(
      acp,
      "vi.mock('../serve/live/live-task-service.js');",
    );
    await expectServeBoundaryError(
      acp,
      "export async function load() { return vi.importActual('../serve/live/live-task-service.js'); }",
    );
    await expectServeBoundaryError(
      acp,
      "vitest.mock('../serve/live/live-task-service.js');",
    );

    // A non-serve vi.mock stays silent on the boundary.
    const [result] = await lintCliFile(acp, "vi.mock('../utils/foo.js');");
    const boundaryHits = result.messages.filter((message) =>
      message.message.includes('serve'),
    );
    expect(boundaryHits).toEqual([]);
  });

  // Round-7 entrances (#8084): each spelling below resolves to serve/
  // while evading the relative patterns; every one is pinned here.
  it('rejects case-variant serve spellings', async () => {
    const acp = 'packages/cli/src/acp-integration/boundary-fixture.ts';
    await expectServeBoundaryError(acp, "import '../Serve/index.js';");
    await expectServeBoundaryError(
      acp,
      "export async function load() { return import('../Serve/live/live-task-service.js'); }",
    );
    await expectServeBoundaryError(
      acp,
      "vi.mock('../SERVE/live/live-task-service.js');",
    );
  });

  it('rejects ?query and #fragment suffixes on serve specifiers', async () => {
    const acp = 'packages/cli/src/acp-integration/boundary-fixture.ts';
    await expectServeBoundaryError(acp, "import '../serve/index.js?x';");
    await expectServeBoundaryError(
      acp,
      "export async function load() { return import('../serve/index.js?x'); }",
    );
    await expectServeBoundaryError(
      acp,
      "vi.mock('../serve/live/live-task-service.js?x');",
    );
    await expectServeBoundaryError(acp, "import '../serve/index.js#f';");
  });

  it('rejects percent-encoded pure-template vitest calls', async () => {
    const acp = 'packages/cli/src/acp-integration/boundary-fixture.ts';
    await expectServeBoundaryError(
      acp,
      'vi.mock(`../%73erve/live/live-task-service.js`);',
    );
  });

  it('rejects root-absolute and file: literal specifiers fail-closed', async () => {
    const acp = 'packages/cli/src/acp-integration/boundary-fixture.ts';
    await expectServeBoundaryError(
      acp,
      "import '/srv/qwen/packages/cli/src/serve/index.js';",
    );
    await expectServeBoundaryError(
      acp,
      "import 'file:///srv/qwen/packages/cli/src/serve/index.js';",
    );
    await expectServeBoundaryError(
      acp,
      "export async function load() { return import('/srv/qwen/packages/cli/src/serve/index.js'); }",
    );
  });

  it('flags createRequire source modules in guarded trees', async () => {
    const acp = 'packages/cli/src/acp-integration/boundary-fixture.ts';
    await expectServeBoundaryError(
      acp,
      "import { createRequire } from 'node:module';",
    );
    await expectServeBoundaryError(acp, "import moduleBuiltin from 'module';");
    await expectServeBoundaryError(
      acp,
      "export { createRequire } from 'node:module';",
    );
    await expectServeBoundaryError(
      acp,
      "export async function load() { return import('node:module'); }",
    );
  });

  // Round-8 entrances (#8084): each spelling below reached serve/ while
  // evading the old text-matching matrix entirely; the resolution-based
  // rule collapses them into the same "lands in serve/" check.
  it('rejects data: URL imports fail-closed', async () => {
    const acp = 'packages/cli/src/acp-integration/boundary-fixture.ts';
    await expectServeBoundaryError(
      acp,
      'export async function load() { await import("data:text/javascript,export*from\\"file:///repo/packages/cli/src/serve/index.js\\""); }',
    );
  });

  it('rejects baseUrl bare specifiers that resolve into serve', async () => {
    // packages/cli tsconfig baseUrl "." makes `src/serve/...` a valid
    // bare-specifier import — text patterns never saw a `../` run here.
    const acp = 'packages/cli/src/acp-integration/boundary-fixture.ts';
    await expectServeBoundaryError(acp, "import 'src/serve/index.js';");
    await expectServeBoundaryError(
      acp,
      "export async function load() { return import('src/serve/live/live-task-service.js'); }",
    );
  });

  it('rejects traversal-bearing bare specifiers fail-closed', async () => {
    await expectServeBoundaryError(
      'packages/cli/src/acp-integration/boundary-fixture.ts',
      "import 'foo/../../src/serve/index.js';",
    );
  });

  it('rejects process.getBuiltinModule in guarded trees fail-closed', async () => {
    const acp = 'packages/cli/src/acp-integration/boundary-fixture.ts';
    await expectServeBoundaryError(
      acp,
      "const mod = process.getBuiltinModule('node:module');",
    );
    await expectServeBoundaryError(
      acp,
      "const mod = process['getBuiltinModule']('node:module');",
    );
    await expectServeBoundaryError(
      acp,
      "const mod = globalThis.process.getBuiltinModule('node:module');",
    );
  });

  // Codex self-review: URL schemes are case-insensitive — `FILE:`/`DATA:`
  // must fail closed just like their lowercase forms.
  it('rejects case-variant file:/data: URL schemes fail-closed', async () => {
    const acp = 'packages/cli/src/acp-integration/boundary-fixture.ts';
    await expectServeBoundaryError(
      acp,
      "import 'FILE:///repo/packages/cli/src/serve/index.js';",
    );
    await expectServeBoundaryError(
      acp,
      "export async function load() { await import('DATA:text/javascript,export default 1'); }",
    );
  });

  // The URL parser strips surrounding whitespace, so ` DATA:...` loads the
  // same way — scheme detection must trim before matching.
  it('rejects whitespace-padded URL scheme spellings fail-closed', async () => {
    await expectServeBoundaryError(
      'packages/cli/src/acp-integration/boundary-fixture.ts',
      "export async function load() { await import(' DATA:text/javascript,export default 1'); }",
    );
  });

  it('rejects control-character and symlinked serve paths', async () => {
    const utils = 'packages/cli/src/utils/boundary-fixture.ts';
    await expectServeBoundaryError(
      utils,
      "export async function load() { await import('../ser\\tve/index.js'); }",
    );

    const link = path.join(repoRoot, 'packages/cli/src/utils/serve-link.js');
    rmSync(link, { force: true });
    try {
      symlinkSync('../serve/index.ts', link);
      await expectServeBoundaryError(
        utils,
        "export async function load() { await import('./serve-link.js'); }",
      );
    } finally {
      rmSync(link, { force: true });
    }
  });

  // Codex self-review: vitest loaders reached through an alias evade the
  // `vi.`/`vitest.` identifier match; the member/bare-name matchers must
  // still catch them when the specifier resolves into serve/.
  it('rejects aliased vitest module-loading calls into serve', async () => {
    const acp = 'packages/cli/src/acp-integration/boundary-fixture.ts';
    await expectServeBoundaryError(
      acp,
      "import { vi as v } from 'vitest';\nv.mock('../serve/live/live-task-service.js');",
    );
    await expectServeBoundaryError(
      acp,
      "import { importActual } from 'vitest';\nexport async function load() { return importActual('../serve/live/live-task-service.js'); }",
    );
    // R8-2: doMock/importMock were matched by the guard but had zero
    // fixture coverage — narrowing the alternation stayed green.
    await expectServeBoundaryError(
      acp,
      "import { vi } from 'vitest';\nvi.doMock('../serve/live/live-task-service.js');",
    );
    await expectServeBoundaryError(
      acp,
      "import { vi } from 'vitest';\nvi.importMock('../serve/live/live-task-service.js');",
    );
  });

  // Codex self-review: child_process.spawn's first argument is an
  // executable resolved via PATH/cwd, not a module — it must NOT be
  // treated as an import source (would false-positive legitimate code).
  it('does not treat child_process.spawn arguments as import sources', async () => {
    const [result] = await lintCliFile(
      'packages/cli/src/acp-integration/boundary-fixture.ts',
      "import { spawn } from 'node:child_process';\nexport function run() { return spawn(process.execPath, ['--version']); }",
    );
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
    // R10-3: filter on the rule itself, not the serveBoundary text — a
    // regression routing serve-named bare specifiers to failClosed must
    // also turn this pin red ('serve/ internals' is absent from the
    // failClosed message).
    await expectNoBoundaryHits(ACP_FIXTURE, code);
  });

  // R9-5: the re-export / Worker / fork / require visitors had no fixture
  // pins — deleting any of them left the suite green. The bare `fork`
  // spelling also covers R9-4 (the destructured child_process import
  // evaded the member-only guard).
  it('pins re-export, Worker, fork and require entrances', async () => {
    const runtime = 'packages/cli/src/runtime/boundary-fixture.ts';
    await expectServeBoundaryError(
      runtime,
      "export * from '../serve/index.js';",
    );
    await expectServeBoundaryError(
      runtime,
      "export { x } from '../serve/index.js';",
    );
    await expectServeBoundaryError(
      runtime,
      "new Worker('../serve/worker.js');",
    );
    await expectServeBoundaryError(runtime, "require('../serve/index.js');");
    await expectServeBoundaryError(
      runtime,
      "import { fork } from 'node:child_process';\nfork('../serve/index.js');",
    );
  });

  // R9-2: the new-URL-with-import.meta check sat in the CallExpression
  // visitor (NewExpression nodes never dispatch there), so a standalone
  // `new URL('../serve/...', import.meta.url)` reported nothing.
  it('rejects standalone new URL(spec, import.meta.url) into serve', async () => {
    await expectServeBoundaryError(
      'packages/cli/src/runtime/boundary-fixture.ts',
      "const u = new URL('../serve/worker.js', import.meta.url);",
    );
  });

  // R9-7: no pin exercised the false branch of static-template
  // concatenation — a pure template literal resolving OUTSIDE serve must
  // stay allowed (breaking the concatenation fail-closes legitimate code).
  it('allows pure template-literal imports that resolve outside serve', async () => {
    await expectNoBoundaryHits(
      ACP_FIXTURE,
      'export async function load() { await import(`../utils/boundary-fixture.ts`); }',
    );
  });

  // R13-2: resolution-based detections must report via the serveBoundary
  // messageId — if inside-detection degrades into blanket fail-closed
  // rejection the substring-based positive helper stays green, so pin the
  // messageId directly.
  it('reports resolution detections via the serveBoundary messageId', async () => {
    for (const code of [
      "import '../serve/index.js';",
      "export async function load() { return import('src/serve/index.js'); }",
    ]) {
      const [result] = await lintCliFile(ACP_FIXTURE, code);
      expect(
        result.messages.some(
          (message) => message.messageId === 'serveBoundary',
        ),
      ).toBe(true);
    }
  });

  // ── Round-11 review pins ─────────────────────────────────────────────

  // R12-2 (round-9 ledger): the '#' fail-closed check used to sit AFTER
  // stripUrlSuffixes, which splits on '#' — '#name' collapsed to '' and
  // classified outside, so package-imports specifiers sailed through. The
  // check now precedes suffix stripping; pin both entrances.
  it('fails closed on package-imports (#) specifiers', async () => {
    await expectServeBoundaryError(ACP_FIXTURE, "import '#s';");
    await expectServeBoundaryError(
      ACP_FIXTURE,
      "export async function load() { return import('#serve-internals'); }",
    );
  });

  // C0 controls at the specifier edges are stripped before Node's scheme
  // detection — '\x01data:…' still loads a data: URL. Scheme detection
  // must see the same edge-stripped form.
  it('fails closed on C0-control-prefixed URL schemes', async () => {
    await expectServeBoundaryError(
      ACP_FIXTURE,
      "export async function load() { await import('\\u0001data:text/javascript,export default 1'); }",
    );
    await expectServeBoundaryError(
      ACP_FIXTURE,
      "import '\\u0001file:///repo/packages/cli/src/serve/index.js';",
    );
  });

  // String-code execution entrances embed import('…') the rule cannot
  // resolve — fail closed like computed sources (eval/new Function have
  // no shared no-eval guard in the config).
  it('fails closed on string-code execution entrances', async () => {
    for (const code of [
      'eval("import(\'../serve/index.js\')");',
      '(0, eval)("import(\'../serve/index.js\')");',
      'globalThis.eval("import(\'../serve/index.js\')");',
      'const load = new Function("return import(\'../serve/index.js\')");',
    ]) {
      await expectServeBoundaryError(ACP_FIXTURE, code);
    }
  });

  // file: URLs are "special", so Node's URL-based resolution normalizes
  // backslashes to '/' — a specifier VALUE containing '\' resolves like
  // the slash form even on posix.
  it('rejects backslash-separated serve specifiers', async () => {
    await expectServeBoundaryError(
      RUNTIME_FIXTURE,
      "import '..\\\\serve\\\\index.js';",
    );
  });

  // Every getBuiltinModule arm: global.process, destructured bare
  // identifier, Reflect.apply — plus the computed object-side and
  // property-side spellings.
  it('pins every getBuiltinModule spelling', async () => {
    await expectServeBoundaryError(
      ACP_FIXTURE,
      "const mod = global.process.getBuiltinModule('node:module');",
    );
    await expectServeBoundaryError(
      ACP_FIXTURE,
      "const { getBuiltinModule } = process;\nconst mod = getBuiltinModule('node:module');",
    );
    await expectServeBoundaryError(
      ACP_FIXTURE,
      "const mod = Reflect.apply(process.getBuiltinModule, null, ['node:module']);",
    );
    await expectServeBoundaryError(
      ACP_FIXTURE,
      "const mod = globalThis['process'].getBuiltinModule('module');",
    );
    await expectServeBoundaryError(
      ACP_FIXTURE,
      "const mod = Reflect.apply(process['getBuiltinModule'], null, ['module']);",
    );
  });

  // The root-absolute and file: branches must reach isInServeDir —
  // 'inside' verdicts (serveBoundary), not just the fail-closed path.
  it('reports absolute-path and file: imports into serve via serveBoundary', async () => {
    const serveEntry = `${repoRoot}/packages/cli/src/serve/index.ts`;
    for (const code of [
      `import '${serveEntry}';`,
      `import 'file://${serveEntry}';`,
    ]) {
      const [result] = await lintCliFile(ACP_FIXTURE, code);
      expect(
        result.messages.some(
          (message) => message.messageId === 'serveBoundary',
        ),
      ).toBe(true);
    }
  });

  // The child_process.fork MEMBER arm and the template cooked-value
  // choice each had zero pins (mutants survived).
  it('pins the fork member arm and template cooked values', async () => {
    await expectServeBoundaryError(
      RUNTIME_FIXTURE,
      "import * as child_process from 'node:child_process';\nchild_process.fork('../serve/index.js');",
    );
    await expectServeBoundaryError(
      RUNTIME_FIXTURE,
      'export async function load() { await import(`../\\x73erve/index.js`); }',
    );
  });

  // fork/Worker arms are object-agnostic: namespace and default-import
  // spellings must not evade the guard.
  it('rejects namespace and default-import fork/Worker spellings into serve', async () => {
    await expectServeBoundaryError(
      RUNTIME_FIXTURE,
      "import cp from 'node:child_process';\ncp.fork('../serve/index.js');",
    );
    await expectServeBoundaryError(
      RUNTIME_FIXTURE,
      "import wt from 'node:worker_threads';\nnew wt.Worker('../serve/worker.js');",
    );
  });

  // Bare destructured vitest loader names (member forms were pinned in
  // R8-2; bare mock/doMock/importMock had no pin).
  it('pins bare destructured vitest loader spellings', async () => {
    for (const name of ['mock', 'doMock', 'importMock']) {
      await expectServeBoundaryError(
        ACP_FIXTURE,
        `import { ${name} } from 'vitest';\n${name}('../serve/live/live-task-service.js');`,
      );
    }
  });

  // The bare-'module' disjunct had no dynamic-entrance coverage (static
  // import is intercepted earlier by the ImportDeclaration regex arm).
  it('fails closed on dynamic bare-module specifiers', async () => {
    await expectServeBoundaryError(
      ACP_FIXTURE,
      "export async function load() { return import('module'); }",
    );
    await expectServeBoundaryError(ACP_FIXTURE, "require('module');");
    await expectServeBoundaryError(
      ACP_FIXTURE,
      "export { createRequire } from 'module';",
    );
  });

  // new Worker(new URL(spec, import.meta.url)) belongs to the URL arm:
  // boundary-clean targets produce ZERO diagnostics (no fail-closed on a
  // fully static construct), serve targets exactly ONE serveBoundary.
  it('lets the URL arm own new Worker(new URL(spec, import.meta.url))', async () => {
    await expectNoBoundaryHits(
      RUNTIME_FIXTURE,
      "const w = new Worker(new URL('./worker.js', import.meta.url));",
    );
    const [result] = await lintCliFile(
      RUNTIME_FIXTURE,
      "const w = new Worker(new URL('../serve/worker.js', import.meta.url));",
    );
    const hits = result.messages.filter(
      (message) => message.ruleId === RULE_ID,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].messageId).toBe('serveBoundary');
  });

  // The outside-serve (allow) verdict of the checkSource arms had zero
  // negative pins — mutating any arm to unconditional fail-closed stayed
  // green.
  it('allows URL/Worker/fork/require targets that resolve outside serve', async () => {
    for (const code of [
      "const u = new URL('../utils/foo.js', import.meta.url);",
      "new Worker('../utils/worker.js');",
      "require('../utils/foo.js');",
      "import cp from 'node:child_process';\ncp.fork('../utils/foo.js');",
    ]) {
      await expectNoBoundaryHits(RUNTIME_FIXTURE, code);
    }
  });

  // import x = require('../serve/…') — tsc under NodeNext emits a working
  // createRequire shim, so the spelling loads at runtime.
  it('rejects import-equals-require into serve', async () => {
    await expectServeBoundaryError(
      ACP_FIXTURE,
      "import x = require('../serve/index.js');",
    );
  });
});
