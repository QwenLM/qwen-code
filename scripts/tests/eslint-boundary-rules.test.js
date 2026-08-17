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

/** Assert the boundary rule fired for `code`. Filters on the rule id,
 *  not a 'serve' substring: every one of the rule's three messageIds
 *  contains 'serve', and so do unrelated diagnostics — the substring
 *  could not tell the rule firing from any other noise (#8084 review). */
const expectServeBoundaryError = async (filePath, code) => {
  const [result] = await lintCliFile(filePath, code);
  expect(result.messages.some((message) => message.ruleId === RULE_ID)).toBe(
    true,
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
    await expectNoBoundaryHits(acp, "vi.mock('../utils/foo.js');");
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
    await expectNoBoundaryHits(
      ACP_FIXTURE,
      "import { spawn } from 'node:child_process';\nexport function run() { return spawn(process.execPath, ['--version']); }",
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
    // repoRoot is backslash-separated on Windows; interpolating it into a
    // single-quoted JS literal raw would let NonEscapeCharacter cooking
    // destroy the specifier (and fileURLToPath would throw Invalid URL),
    // turning this pin deterministically red on the Windows merge gate
    // (R12-10). Normalize to forward slashes, which both the rule and
    // file URLs accept on every platform.
    const serveEntry = path
      .join(repoRoot, 'packages/cli/src/serve/index.ts')
      .split(path.sep)
      .join('/');
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

  // ── Round-12 review pins ─────────────────────────────────────────────

  // Symlink canonicalization must be symmetric: the baseUrl arm realpath's
  // the candidate AND the comparison side is canonicalized, so a
  // committable symlink inside the baseUrl tree pointing into serve/ is
  // caught (tsc/esbuild follow it), while a link pointing outside stays
  // allowed.
  it('catches baseUrl symlinks that point into serve', async () => {
    const cliDir = path.join(repoRoot, 'packages/cli');
    const intoServe = path.join(cliDir, 'serve-alias-fixture');
    const outOfServe = path.join(cliDir, 'utils-alias-fixture');
    // Pre-clean leftovers from an interrupted run: an EEXIST here would
    // otherwise be misread as "no unprivileged symlink support" and
    // silently skip the pin forever (R12-15).
    rmSync(intoServe, { force: true });
    rmSync(outOfServe, { force: true });
    let created = false;
    try {
      symlinkSync(path.join(cliDir, 'src/serve'), intoServe);
      symlinkSync(path.join(cliDir, 'src/utils'), outOfServe);
      created = true;
    } catch {
      // Platforms without unprivileged symlink support: nothing to pin.
      // Clean up whatever the first call created before failing.
      rmSync(intoServe, { force: true });
      rmSync(outOfServe, { force: true });
    }
    if (!created) return;
    try {
      await expectServeBoundaryError(
        ACP_FIXTURE,
        "import 'serve-alias-fixture/index.ts';",
      );
      await expectNoBoundaryHits(
        ACP_FIXTURE,
        "import 'utils-alias-fixture/foo.ts';",
      );
    } finally {
      rmSync(intoServe, { force: true });
      rmSync(outOfServe, { force: true });
    }
  });

  // Callee identity is shape-tolerant: nested member objects, computed
  // template-literal properties, and renamed bindings must not evade the
  // loader/fork/eval/getBuiltinModule arms.
  it('catches shape-variant callee spellings', async () => {
    for (const code of [
      // nested member objects evade Identifier-only object checks
      "globalThis.vi.mock('../serve/live/live-task-service.js');",
      "x.cp.fork('../serve/index.js');",
      // expression-free template-literal properties
      "vi[`mock`]('../serve/live/live-task-service.js');",
      "cp[`fork`]('../serve/index.js');",
      'globalThis[`eval`]("import(\'../serve/index.js\')");',
      "process[`getBuiltinModule`]('module');",
      "Reflect[`apply`](process.getBuiltinModule, null, ['module']);",
    ]) {
      await expectServeBoundaryError(ACP_FIXTURE, code);
    }
  });

  it('catches renamed loader bindings and Reflect indirection', async () => {
    for (const code of [
      "import { Worker as W } from 'node:worker_threads';\nnew W('../serve/worker.js');",
      "import { fork as f } from 'node:child_process';\nf('../serve/index.js');",
      "Reflect.construct(Worker, ['../serve/worker.js']);",
      "Reflect.apply(require, null, ['../serve/index.js']);",
      "Reflect.apply(fork, null, ['../serve/index.js']);",
    ]) {
      await expectServeBoundaryError(ACP_FIXTURE, code);
    }
  });

  it('catches call/apply/bind indirection on guarded loaders', async () => {
    for (const code of [
      "(0, require)('../serve/index.js');",
      "require.call(null, '../serve/index.js');",
      "require.apply(null, ['../serve/index.js']);",
      "fork.bind(null)('../serve/index.js');",
      "process.getBuiltinModule.call(process, 'node:module');",
      "process.getBuiltinModule.apply(process, ['node:module']);",
    ]) {
      await expectServeBoundaryError(ACP_FIXTURE, code);
    }
  });

  // The string-code execution class: call-without-new, member spellings,
  // .constructor chains, the node:vm surface, and Worker's eval option —
  // all compile/run arbitrary string code that can import() anything.
  it('fails closed on the string-code execution class', async () => {
    for (const code of [
      'const f = Function("return import(\'../serve/index.js\')");',
      'new globalThis.Function("return import(\'../serve/index.js\')")();',
      "globalThis.Function('x')();",
      "Function('x').bind(null)();",
      'eval.call(null, "import(\'../serve/index.js\')");',
      'eval.apply(null, ["import(\'../serve/index.js\')"]);',
      '({}).constructor.constructor("return import(\'../serve/index.js\')")()();',
      '(function(){}).constructor("return import(\'../serve/index.js\')");',
      '[].constructor.constructor("return import(\'../serve/index.js\')")()();',
      "import vm from 'node:vm';\nvm.runInThisContext('x');",
      "import vm from 'node:vm';\nvm.runInNewContext('x');",
      "import vm from 'node:vm';\nvm.compileFunction('x');",
      "import { runInContext } from 'node:vm';\nrunInContext('x', {});",
      "import vm from 'node:vm';\nnew vm.Script('x');",
      "new Worker('x', { eval: true });",
      "new Worker('x', options);",
    ]) {
      await expectServeBoundaryError(ACP_FIXTURE, code);
    }
    // eval: false is statically verifiable — the specifier path applies.
    await expectServeBoundaryError(
      ACP_FIXTURE,
      "new Worker('../serve/worker.js', { eval: false });",
    );
    await expectNoBoundaryHits(
      ACP_FIXTURE,
      "new Worker('../utils/worker.js', { eval: false });",
    );
    // messageId-specific: the eval:true form reports failClosed (arg0 is
    // code, never a specifier), whatever the first argument looks like.
    const [evalTrue] = await lintCliFile(
      ACP_FIXTURE,
      'new Worker("import(\'../serve/worker.js\')", { eval: true });',
    );
    expect(
      evalTrue.messages.some(
        (message) =>
          message.ruleId === RULE_ID && message.messageId === 'failClosed',
      ),
    ).toBe(true);
  });

  // The URL arm resolves only the import.meta.url base; any other
  // import.meta member is statically unresolvable — fail closed, never
  // assume the module base.
  it('fails closed on non-url import.meta bases', async () => {
    await expectServeBoundaryError(
      ACP_FIXTURE,
      "const u = new URL('../serve/index.js', import.meta.resolve);",
    );
    await expectServeBoundaryError(
      ACP_FIXTURE,
      "const w = new Worker(new URL('../serve/worker.js', import.meta.resolve));",
    );
    // messageId-specific: an unresolvable base reports failClosed, not
    // serveBoundary — the specifier never resolves.
    for (const code of [
      "const u = new URL('../serve/index.js', import.meta.env);",
      "const w = new Worker(new URL('./worker.js', import.meta.env));",
    ]) {
      const [result] = await lintCliFile(ACP_FIXTURE, code);
      expect(
        result.messages.some(
          (message) =>
            message.ruleId === RULE_ID && message.messageId === 'failClosed',
        ),
      ).toBe(true);
    }
  });

  // stripUrlSuffixes must also protect the bare-directory and baseUrl
  // spellings, not just full-file specifiers.
  it('strips query/fragment suffixes from bare serve spellings', async () => {
    await expectServeBoundaryError(RUNTIME_FIXTURE, "import '../serve?foo';");
    await expectServeBoundaryError(
      ACP_FIXTURE,
      "import 'src/serve/index.js?v=1';",
    );
  });

  // The outside-serve (allow) verdict needs pins for the export and
  // import-equals arms too — otherwise mutating them to unconditional
  // fail-closed stays green.
  it('allows exports and import-equals that resolve outside serve', async () => {
    for (const code of [
      "export * from '../utils/foo.js';",
      "export { x } from '../utils/foo.js';",
      "import x = require('../utils/foo.js');",
    ]) {
      await expectNoBoundaryHits(ACP_FIXTURE, code);
    }
  });

  // ── Round-12 review pins (batch 2) ───────────────────────────────────

  // R12-1: the Worker eval-option analysis must match runtime
  // object-literal semantics — last key wins, absent eval defaults to
  // false (specifier path), and a spread after the last literal eval is
  // unverifiable.
  it('analyses Worker eval options with runtime literal semantics', async () => {
    // No eval property: eval defaults to false — arg0 is a specifier, so
    // a clean target passes (over-blocking regression pin).
    await expectNoBoundaryHits(
      ACP_FIXTURE,
      "new Worker('../utils/worker.js', { name: 'bg' });",
    );
    await expectNoBoundaryHits(
      ACP_FIXTURE,
      "new Worker('../utils/worker.js', {});",
    );
    // A spread AFTER an eval:false literal can override eval at runtime.
    await expectServeBoundaryError(
      ACP_FIXTURE,
      "const overrides = { eval: true };\nnew Worker('x', { eval: false, ...overrides });",
    );
    // Duplicate keys: the runtime gives the LAST one.
    await expectServeBoundaryError(
      ACP_FIXTURE,
      "new Worker('x', { eval: false, eval: true });",
    );
    // A trailing literal false wins over an earlier spread.
    await expectNoBoundaryHits(
      ACP_FIXTURE,
      "const overrides = {};\nnew Worker('../utils/worker.js', { ...overrides, eval: false });",
    );
  });

  // R12-2: sequence unwrapping is a uniform invariant — recursive on the
  // callee AND applied to object expressions.
  it('unwraps nested sequences and sequence-wrapped objects', async () => {
    for (const code of [
      "(0, require).call(null, '../serve/index.js');",
      "(0, (0, require))('../serve/index.js');",
      "new (0, (0, Worker))('../serve/worker.js');",
      "(0, process).getBuiltinModule('node:module');",
      "Reflect.apply((0, process).getBuiltinModule, null, ['module']);",
    ]) {
      await expectServeBoundaryError(ACP_FIXTURE, code);
    }
  });

  // R12-3: call/apply/bind indirection is complete — Function/constructor
  // forward code, chained indirection fails closed, vm exec names and the
  // rule's own alias sets resolve.
  it('covers call/apply/bind indirection on every guarded family', async () => {
    for (const code of [
      'Function.call(null, "return import(\'../serve/index.js\')");',
      'Function.apply(null, ["return import(\'../serve/index.js\')"]);',
      'Function.bind(null, "return import(\'../serve/index.js\')")();',
      'eval.call.call(null, null, "import(\'../serve/index.js\')");',
      "vi.mock.call.call(vi, null, '../serve/live/live-task-service.js');",
      "process.getBuiltinModule.call.call(process, null, 'node:module');",
      "import vm from 'node:vm';\nvm.runInContext.call(vm, 'x', {});",
      "import { runInContext as ric } from 'node:vm';\nric.call(null, 'x', {});",
      "import { fork as f } from 'node:child_process';\nf.call(null, '../serve/index.js');",
    ]) {
      await expectServeBoundaryError(ACP_FIXTURE, code);
    }
  });

  // R12-4: Reflect target lists mirror the direct-call arms — Function,
  // the vm exec/Script surface, and the vitest loaders.
  it('covers Reflect.apply/construct on every guarded family', async () => {
    for (const code of [
      'Reflect.apply(Function, null, ["return import(\'../serve/index.js\')"]);',
      'Reflect.construct(Function, ["return import(\'../serve/index.js\')"]);',
      'Reflect.apply(globalThis.Function, null, ["x"]);',
      "import vm from 'node:vm';\nReflect.apply(vm.runInContext, vm, ['x', {}]);",
      "import { compileFunction } from 'node:vm';\nReflect.apply(compileFunction, null, ['x']);",
      "import vm from 'node:vm';\nReflect.construct(vm.Script, ['x']);",
      "import { vi } from 'vitest';\nReflect.apply(vi.mock, vi, ['../serve/live/live-task-service.js']);",
      "import { importActual } from 'vitest';\nReflect.apply(importActual, null, ['../serve/live/live-task-service.js']);",
    ]) {
      await expectServeBoundaryError(ACP_FIXTURE, code);
    }
  });

  // R12-5: ESM imports are hoisted — a renamed import used BEFORE its
  // declaration must resolve through the alias sets (pre-pass, not
  // visitor source order). All five families.
  it('resolves renamed imports used before their declaration', async () => {
    for (const code of [
      "export const w = new W('../serve/worker.js');\nimport { Worker as W } from 'node:worker_threads';",
      "export const p = f('../serve/index.js');\nimport { fork as f } from 'node:child_process';",
      "export const s = new S('x');\nimport { Script as S } from 'node:vm';",
      "export const r = ric('x', {});\nimport { runInContext as ric } from 'node:vm';",
      "export const c = v2.runInContext('x', {});\nimport v2 from 'node:vm';",
    ]) {
      await expectServeBoundaryError(ACP_FIXTURE, code);
    }
  });

  // R12-6: renamed destructured vitest imports are still destructured
  // spellings — the bare arm resolves them through vitestLoaderAliases.
  it('catches renamed destructured vitest loader imports', async () => {
    for (const [name, alias] of [
      ['importActual', 'ia'],
      ['mock', 'm'],
      ['doMock', 'dm'],
      ['importMock', 'im'],
    ]) {
      await expectServeBoundaryError(
        ACP_FIXTURE,
        `import { ${name} as ${alias} } from 'vitest';\n${alias}('../serve/live/live-task-service.js');`,
      );
    }
  });

  // R12-7: a named guarded global with an opaque computed key is one
  // variable rename from a guarded entrance — fail closed.
  it('fails closed on opaque computed keys of guarded globals', async () => {
    const [gbm] = await lintCliFile(
      ACP_FIXTURE,
      "const gbm = 'getBuiltinModule';\nprocess[gbm]('node:module');",
    );
    expect(
      gbm.messages.some(
        (message) =>
          message.ruleId === RULE_ID && message.messageId === 'moduleBuiltin',
      ),
    ).toBe(true);
    const [evalCase] = await lintCliFile(
      ACP_FIXTURE,
      "const e = 'eval';\nglobalThis[e](\"import('../serve/index.js')\");",
    );
    expect(
      evalCase.messages.some((message) => message.ruleId === RULE_ID),
    ).toBe(true);
  });

  // R12-8: .constructor fails closed on variable bodies and expression
  // templates; statically non-string literals still pass through.
  it('fails closed on dynamic constructor code bodies', async () => {
    await expectServeBoundaryError(
      ACP_FIXTURE,
      'const body = "return import(\'../serve/index.js\')";\n({}).constructor.constructor(body)()();',
    );
    await expectServeBoundaryError(
      ACP_FIXTURE,
      "const x = 'x';\n(function(){}).constructor(`return '${'x'}' + x`)();",
    );
    await expectNoBoundaryHits(ACP_FIXTURE, '({}).constructor(42);');
  });

  // R12-9: inline lazy vm imports are vm objects without any aliasing —
  // the canonical ESM spelling must not evade the vm arms.
  it('catches inline lazy-import vm spellings', async () => {
    for (const code of [
      "(await import('node:vm')).runInContext('x', {});",
      "(await import('node:vm')).compileFunction('x');",
      "new (await import('node:vm')).Script('x');",
      "(await import('vm')).runInContext('x', {});",
    ]) {
      await expectServeBoundaryError(ACP_FIXTURE, code);
    }
  });

  // R12-11: statically non-specifier arguments are non-imports — no
  // unactionable fail-closed advice for env objects and the like.
  it('does not fail-close statically non-specifier arguments', async () => {
    for (const code of [
      'recorder.mock({ silent: true });',
      'recorder.mock(42);',
      "cluster.fork({ NODE_ENV: 'prod' });",
    ]) {
      await expectNoBoundaryHits(ACP_FIXTURE, code);
    }
  });

  // R12-12: the URL arm owns new URL(spec, import.meta.url) on EVERY
  // entrance — no fail-closed over-block on the clean form, exactly one
  // serveBoundary on the serve form.
  it('lets the URL arm own new URL(spec, import.meta.url) everywhere', async () => {
    await expectNoBoundaryHits(
      ACP_FIXTURE,
      "export async function load() { return import(new URL('./plugin.js', import.meta.url)); }",
    );
    const [serve] = await lintCliFile(
      ACP_FIXTURE,
      "export async function load() { return import(new URL('../serve/index.js', import.meta.url)); }",
    );
    const hits = serve.messages.filter((message) => message.ruleId === RULE_ID);
    expect(hits).toHaveLength(1);
    expect(hits[0].messageId).toBe('serveBoundary');
    await expectNoBoundaryHits(
      ACP_FIXTURE,
      "const m = require(new URL('./plugin.js', import.meta.url));",
    );
  });

  // R12-13: the module builtin reports the dedicated moduleBuiltin
  // message on every entrance, not the unactionable failClosed advice.
  it('reports module-builtin imports with the dedicated message', async () => {
    for (const code of [
      "export async function load() { return import('module'); }",
      "const m = require('module');",
      "import x = require('module');",
      "export { createRequire } from 'node:module';",
    ]) {
      const [result] = await lintCliFile(ACP_FIXTURE, code);
      expect(
        result.messages.some(
          (message) =>
            message.ruleId === RULE_ID && message.messageId === 'moduleBuiltin',
        ),
      ).toBe(true);
    }
  });

  // R12-14 mutation survivors: the renamed-Script Identifier disjunct and
  // the unprefixed builtin-import alias registration direction.
  it('pins the renamed-Script arm and unprefixed alias registration', async () => {
    await expectServeBoundaryError(
      ACP_FIXTURE,
      "import { Script as S } from 'node:vm';\nnew S('x');",
    );
    await expectServeBoundaryError(
      ACP_FIXTURE,
      "import { fork as f } from 'child_process';\nf('../serve/index.js');",
    );
    await expectServeBoundaryError(
      ACP_FIXTURE,
      "import { Worker as W } from 'worker_threads';\nnew W('../serve/worker.js');",
    );
  });
});
