/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  isWorkspaceMember,
  planTestEfficacy,
  classifyProbeRun,
  classifyMutantRun,
  safeRmWithin,
  selectMutants,
  parseAddedLines,
  hasCollocatedNewTest,
  fitsAnotherMutantRun,
  probeCreateFailureDetail,
  probeCleanupFailureDetail,
  MAX_MUTANTS,
} from './test-efficacy.js';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The real root `package.json` workspace list.
const GLOBS = [
  'packages/*',
  'packages/channels/base',
  'packages/channels/telegram',
  '!packages/desktop',
];

describe('isWorkspaceMember', () => {
  it('places the integration-tests directory outside every workspace', () => {
    // The whole of the PR #6486 unreachability finding, decided without running
    // anything: `npm test` is `npm run test --workspaces`, and this path is in
    // no workspace, so nothing ever collects it.
    expect(
      isWorkspaceMember(
        'integration-tests/interactive/model-toggle-hotkey.test.ts',
        GLOBS,
      ),
    ).toBe(false);
  });

  it('places a package test inside one', () => {
    expect(
      isWorkspaceMember('packages/cli/src/config/keyBindings.test.ts', GLOBS),
    ).toBe(true);
    expect(
      isWorkspaceMember('packages/channels/base/src/x.test.ts', GLOBS),
    ).toBe(true);
  });

  it('honours a negated glob', () => {
    expect(isWorkspaceMember('packages/desktop/src/a.test.ts', GLOBS)).toBe(
      false,
    );
  });

  it('honours workspace-glob ORDER — a positive after a negation re-includes', () => {
    // npm evaluates the list in order. Filtering all negations first let a
    // negation win wherever it sat, which would file a false `unreachable`.
    const globs = ['packages/*', '!packages/desktop', 'packages/desktop'];
    expect(isWorkspaceMember('packages/desktop/src/a.test.ts', globs)).toBe(
      true,
    );
    const reordered = ['packages/*', 'packages/desktop', '!packages/desktop'];
    expect(isWorkspaceMember('packages/desktop/src/a.test.ts', reordered)).toBe(
      false,
    );
  });

  it('does not match a sibling directory by prefix', () => {
    expect(isWorkspaceMember('packages-old/cli/a.test.ts', GLOBS)).toBe(false);
    expect(isWorkspaceMember('scripts/a.test.ts', GLOBS)).toBe(false);
  });
});

describe('planTestEfficacy', () => {
  // PR #6486's real file list: one unreachable integration test, two reachable
  // unit tests, and the production files they are supposed to be gating.
  const files6486 = [
    { path: 'packages/cli/src/ui/AppContainer.tsx', kind: 'source' },
    { path: 'packages/cli/src/config/keyBindings.ts', kind: 'source' },
    { path: 'packages/cli/src/config/keyBindings.test.ts', kind: 'test' },
    { path: 'packages/cli/src/ui/keyMatchers.test.ts', kind: 'test' },
    {
      path: 'integration-tests/interactive/model-toggle-hotkey.test.ts',
      kind: 'test',
    },
  ];

  it('reports the unreachable test and probes only the ones that can run', () => {
    const plan = planTestEfficacy(files6486, GLOBS);
    expect(plan.unreachable).toEqual([
      'integration-tests/interactive/model-toggle-hotkey.test.ts',
    ]);
    expect(plan.probes).toEqual([
      'packages/cli/src/config/keyBindings.test.ts',
      'packages/cli/src/ui/keyMatchers.test.ts',
    ]);
    expect(plan.revert).toEqual([
      'packages/cli/src/ui/AppContainer.tsx',
      'packages/cli/src/config/keyBindings.ts',
    ]);
  });

  it('excludes fixture-directory data but keeps runtime-loaded source', () => {
    // The discriminator is the directory, not the extension. A `.md` fixture
    // under `__fixtures__/` is test-support data — reverting it breaks the test
    // that loads it. But an executable skill prompt (`SKILL.md`) and a config
    // JSON a test validates against are production source that a test can
    // genuinely gate, so they stay revertable.
    const plan = planTestEfficacy(
      [
        { path: 'packages/cli/src/x.ts', kind: 'source' },
        { path: 'packages/cli/src/__fixtures__/body.md', kind: 'source' },
        {
          path: 'packages/core/src/skills/bundled/review/SKILL.md',
          kind: 'source',
        },
        { path: 'packages/cli/src/config/schema.json', kind: 'source' },
        { path: 'packages/cli/src/x.test.ts', kind: 'test' },
      ],
      GLOBS,
    );
    expect(plan.revert).toEqual([
      'packages/cli/src/x.ts',
      'packages/core/src/skills/bundled/review/SKILL.md',
      'packages/cli/src/config/schema.json',
    ]);
  });

  it('probes nothing on a source-only diff (no tests to run)', () => {
    // Mirror of the test-only case: source changed but no test file to probe
    // means nothing to gate. `probes` must be empty even though `revert` is not.
    const plan = planTestEfficacy(
      [{ path: 'packages/cli/src/a.ts', kind: 'source' }],
      GLOBS,
    );
    expect(plan.revert).toEqual(['packages/cli/src/a.ts']);
    expect(plan.probes).toEqual([]);
  });

  it('probes nothing on a test-only diff', () => {
    // A new test for OLD code is supposed to pass with nothing reverted. Probing
    // it would report every such PR as "inert" — a false blocker on exactly the
    // PRs we want people to write.
    const plan = planTestEfficacy(
      [{ path: 'packages/cli/src/a.test.ts', kind: 'test' }],
      GLOBS,
    );
    expect(plan.probes).toEqual([]);
    expect(plan.revert).toEqual([]);
  });
});

describe('probeCreateFailureDetail', () => {
  // The branch this string is built on fires only when `git worktree add` fails,
  // which no real-git test can force portably (the one lever — an unwritable
  // `.git/worktrees` — is bypassed by root and differs under CI's unprivileged
  // user). The composition is the part with logic in it, so it is pinned here.
  it('names the add failure, and folds in the sweep stderr that explains it', () => {
    const got = probeCreateFailureDetail(
      new Error("fatal: '/w/wt-probe' already exists"),
      "fatal: '/w/wt-probe' is not a working tree\n",
    );
    expect(got).toContain('probe worktree could not be created');
    expect(got).toContain("fatal: '/w/wt-probe' already exists");
    // The sweep is usually the explanation for the add failure — keep it.
    expect(got).toContain(
      "(stale-tree sweep also reported: fatal: '/w/wt-probe' is not a working tree)",
    );
  });

  it('omits the sweep clause when the sweep said nothing', () => {
    // The normal case: no stale tree, so the sweep is silent. A dangling empty
    // "(stale-tree sweep also reported: )" would be noise in the report.
    const got = probeCreateFailureDetail(new Error('disk full'), '   \n');
    expect(got).toBe('probe worktree could not be created: disk full');
  });

  it('survives a non-Error throw', () => {
    expect(probeCreateFailureDetail('boom', '')).toBe(
      'probe worktree could not be created: boom',
    );
  });
});

describe('probeCleanupFailureDetail', () => {
  // Sibling of probeCreateFailureDetail, and pure for the same reason: the path
  // fires only when the tree outlives BOTH `worktree remove` and `rmSync`, which
  // no portable test can force. The reason is the whole value of the message —
  // it dropped out of an earlier cut of this code and a reviewer caught it.
  it('keeps the exception reason — the rmSync error that explains the survival', () => {
    const got = probeCleanupFailureDetail(
      '/w/wt-probe',
      new Error("EBUSY: resource busy, rmdir '/w/wt-probe'"),
      "fatal: '/w/wt-probe' is not a working tree\n",
    );
    expect(got).toContain('could not remove probe worktree /w/wt-probe');
    expect(got).toContain('EBUSY: resource busy');
  });

  it("falls back to git's refusal when rmSync itself did not throw", () => {
    const got = probeCleanupFailureDetail(
      '/w/wt-probe',
      undefined,
      "fatal: '/w/wt-probe' contains modified files\n",
    );
    expect(got).toBe(
      "could not remove probe worktree /w/wt-probe: fatal: '/w/wt-probe' contains modified files",
    );
  });

  it('says only what it knows when neither had anything to say', () => {
    // No dangling ": " — the bare path is the honest message here.
    expect(probeCleanupFailureDetail('/w/wt-probe', undefined, '  \n')).toBe(
      'could not remove probe worktree /w/wt-probe',
    );
  });
});

describe('safeRmWithin', () => {
  // A reviewer reproduced a P0: the revert set is PR-controlled, and `rmSync`
  // follows symlinks in the path prefix, so a PR that turns `dir` into a symlink
  // to an outside directory and has the probe delete `dir/victim` deleted the
  // OUTSIDE file. These pin the guard that closed it.
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'saferm-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'saferm-outside-'));
    writeFileSync(join(outside, 'victim'), 'must survive');
    return { root, outside };
  };

  it('removes a file reachable through real directories', () => {
    const { root } = setup();
    mkdirSync(join(root, 'realdir'));
    writeFileSync(join(root, 'realdir', 'f'), 'x');
    safeRmWithin(root, 'realdir/f');
    expect(existsSync(join(root, 'realdir', 'f'))).toBe(false);
  });

  it('refuses to delete through a symlinked ancestor, sparing the outside file', () => {
    const { root, outside } = setup();
    // `dir` is a symlink to an outside directory; deleting `dir/victim` must not
    // follow it. This is the exact P0 shape.
    symlinkSync(outside, join(root, 'dir'));
    expect(() => safeRmWithin(root, 'dir/victim')).toThrow(/through a symlink/);
    expect(readFileSync(join(outside, 'victim'), 'utf8')).toBe('must survive');
  });

  it('unlinks a symlink that is itself the target, not what it points at', () => {
    const { root, outside } = setup();
    // Reverting an ADDED symlink means removing the link — never its target.
    symlinkSync(outside, join(root, 'addedlink'));
    safeRmWithin(root, 'addedlink');
    expect(existsSync(join(root, 'addedlink'))).toBe(false);
    expect(existsSync(join(outside, 'victim'))).toBe(true);
  });

  it('is a no-op on a missing path (force rm never threw there either)', () => {
    const { root } = setup();
    expect(() => safeRmWithin(root, 'nope/gone')).not.toThrow();
  });
});

describe('classifyProbeRun', () => {
  const json = (o: unknown) => JSON.stringify(o);
  const only = <T>(got: T[]): T => got[0];

  it('calls a test that still passes without the change INERT', () => {
    // The finding. The source is reverted and the test is green anyway, so it
    // is green whether or not the feature exists.
    const got = classifyProbeRun(
      0,
      json({
        testResults: [
          {
            name: '/w/packages/lib/src/inert.test.ts',
            assertionResults: [{ status: 'passed' }, { status: 'passed' }],
          },
        ],
      }),
      ['packages/lib/src/inert.test.ts'],
    );
    expect(only(got).verdict).toBe('inert');
    expect(only(got).detail).toContain('does not gate');
  });

  it('calls a real assertion failure GATED', () => {
    const got = classifyProbeRun(
      1,
      json({
        testResults: [
          {
            name: '/w/a.test.ts',
            assertionResults: [{ status: 'failed' }, { status: 'passed' }],
          },
        ],
      }),
      ['a.test.ts'],
    );
    expect(only(got).verdict).toBe('gated');
  });

  it('does not let a gating test cover for an inert one in the same run', () => {
    // The bug the LIVE run found and the unit tests did not. One `vitest run`
    // covers every probe; a run-level verdict scored BOTH files `gated` because
    // the gating test failed — so every inert test with a working sibling was
    // invisible, which is the exact defect this command exists to find.
    const got = classifyProbeRun(
      1,
      json({
        testResults: [
          {
            name: '/w/packages/lib/src/inert.test.ts',
            assertionResults: [{ status: 'passed' }],
          },
          {
            name: '/w/packages/lib/src/gating.test.ts',
            assertionResults: [{ status: 'failed' }],
          },
        ],
      }),
      ['packages/lib/src/inert.test.ts', 'packages/lib/src/gating.test.ts'],
    );
    expect(got.map((r) => [r.file, r.verdict])).toEqual([
      ['packages/lib/src/inert.test.ts', 'inert'],
      ['packages/lib/src/gating.test.ts', 'gated'],
    ]);
  });

  it('does NOT call a compile error GATED', () => {
    // The trap this command would otherwise walk into. Reverting the source
    // routinely breaks the test's own imports — it references a symbol the diff
    // introduced. The runner exits non-zero and collects nothing. That is not
    // the test catching a regression; mistaking it for one would hand back
    // exactly the false assurance we are trying to remove.
    const got = classifyProbeRun(1, json({ testResults: [] }), ['a.test.ts']);
    expect(only(got).verdict).toBe('inconclusive');
    expect(only(got).detail).toContain('not evidence either way');
  });

  it('is inconclusive on unparseable output, and says why', () => {
    const got = only(
      classifyProbeRun(
        1,
        'ELIFECYCLE npm ERR!',
        ['a.test.ts'],
        'ENOENT: vitest',
      ),
    );
    expect(got.verdict).toBe('inconclusive');
    // The runner's own error is the only thing that explains this outcome;
    // dropping stderr leaves an `inconclusive` nobody can act on.
    expect(got.detail).toContain('ENOENT: vitest');
  });

  it('does not take another file’s verdict by suffix collision', () => {
    // `endsWith(file)` alone matches `/w/vendor/other-src/a.test.ts` for the
    // probe `src/a.test.ts` — and would then report that file's verdict for
    // ours, silently. Match on a path-separator boundary.
    const got = only(
      classifyProbeRun(
        1,
        json({
          testResults: [
            {
              name: '/w/vendor/other-src/a.test.ts',
              assertionResults: [{ status: 'failed' }],
            },
          ],
        }),
        ['src/a.test.ts'],
      ),
    );
    // Our file was never collected — that is `inconclusive`, not the neighbour's
    // `gated`.
    expect(got.verdict).toBe('inconclusive');
  });

  it('does not call an all-skipped file INERT', () => {
    // Nothing failed and nothing passed — every test was skipped. Reporting
    // "all 0 test(s) still PASSED" about tests that never executed is the same
    // false assurance in a different costume.
    const got = only(
      classifyProbeRun(
        0,
        json({
          testResults: [
            {
              name: '/w/a.test.ts',
              assertionResults: [{ status: 'skipped' }, { status: 'skipped' }],
            },
          ],
        }),
        ['a.test.ts'],
      ),
    );
    expect(got.verdict).toBe('inconclusive');
    expect(got.detail).toContain('none executed');
  });
});

describe('parseAddedLines', () => {
  it('numbers added lines on the NEW side, per post-change path', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -10,0 +11,2 @@ ctx',
      '+first added',
      '+second added',
      '@@ -20 +22,0 @@ ctx',
      '-removed only',
      'diff --git a/src/gone.ts b/src/gone.ts',
      'deleted file mode 100644',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-x',
      '-y',
      'diff --git a/src/b.ts b/src/b.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/b.ts',
      '@@ -0,0 +1 @@',
      '+only line',
      '',
    ].join('\n');
    const got = parseAddedLines(diff);
    // The `index`/`new file mode` header lines sit between hunks; counting
    // them as context would shift every number below by the header count.
    expect(got.get('src/a.ts')).toEqual([11, 12]);
    expect(got.get('src/b.ts')).toEqual([1]);
    // A deletion has no new side and must contribute nothing.
    expect(got.has('src/gone.ts')).toBe(false);
  });

  it('counts context lines, so a default -U3 diff still numbers correctly', () => {
    const diff = [
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -4,3 +4,4 @@',
      ' ctx one',
      '+added',
      ' ctx two',
      ' ctx three',
      '',
    ].join('\n');
    expect(parseAddedLines(diff).get('src/a.ts')).toEqual([5]);
  });

  it('does not count a "\\ No newline" marker as a context line', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -5,0 +6,2 @@',
      '+added line',
      '\\ No newline at end of file',
      '+second added',
    ].join('\n');
    const got = parseAddedLines(diff);
    expect(got.get('src/a.ts')).toEqual([6, 7]);
  });

  it('does not read an added `++ x` line as a file header', () => {
    // `git diff --unified=0` prefixes each added line with `+`, so a spaced
    // pre-increment (`++ count;`) renders as `+++ count;`. Matching `+++ `
    // unconditionally misreads it as a header, drops the line, and attributes
    // every later added line in the file to a phantom path. The next file's
    // real header must still be recognised once its `diff --git` leaves the
    // hunk.
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,0 +2,2 @@ ctx',
      '+++ count;',
      '+tail.clear();',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -0,0 +1 @@',
      '+only line',
      '',
    ].join('\n');
    const got = parseAddedLines(diff);
    expect(got.get('src/a.ts')).toEqual([2, 3]);
    expect(got.get('src/b.ts')).toEqual([1]);
    expect(got.has('count;')).toBe(false);
  });
});

describe('selectMutants', () => {
  const src = (lines: string[]) => lines.join('\n');
  const all = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

  it('selects the dogfood shape: one safety statement inside a guarded branch', () => {
    // The finding the revert probe is structurally blind to: the sole
    // statement of a not-continued branch. Deleting it leaves `{}` — legal —
    // and the file still carries its other, tested behaviour. The comment
    // above it must not block the walk back to the `{` that proves the line
    // stands alone.
    const content = src([
      'export function onPrompt(continued: boolean) {',
      '  if (!continued) {',
      "    // an abandoned task's todos must not bleed into a new prompt",
      '    reminders.clear();',
      '  }',
      '}',
      '',
    ]);
    const { selected: got } = selectMutants([
      {
        file: 'src/todo.ts',
        content,
        addedLines: [2, 3, 4, 5],
        hasNewTests: false,
      },
    ]);
    expect(got).toEqual([
      { file: 'src/todo.ts', line: 4, statement: 'reminders.clear();' },
    ]);
  });

  it('matches the whole safety-verb set', () => {
    const content = src([
      'cache.delete(key);',
      'state.reset();',
      'ctrl.abort();',
      "emitter.removeListener('tick', onTick);",
      'timer.unref();',
      'this.pending = [];',
      'this.timers = new Map();',
      'this.subs = new Map<string, Sub>();',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: all(8), hasNewTests: false },
    ]);
    expect(got.map((c) => c.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('matches Set, WeakMap, and WeakSet reassignments', () => {
    const content = src([
      'this.set = new Set();',
      'this.wm = new WeakMap();',
      'this.ws = new WeakSet();',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: all(3), hasNewTests: false },
    ]);
    expect(got.map((c) => c.line)).toEqual([1, 2, 3]);
  });

  it('skips a modifier-less class field that only looks like an assignment', () => {
    // `cache = new Map();` in a class body matches the safety-verb set and
    // balances its delimiters, but it is a field DECLARATION: deleting it breaks
    // the compile (a wasted run) or, if unused, survives and files a false
    // finding. A statement inside a method body is enclosed by the method's
    // brace, not the class's, and must still be selected.
    const content = src([
      'class Store {',
      '  cache = new Map();',
      '  reset() {',
      '    this.cache.clear();',
      '  }',
      '}',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: all(6), hasNewTests: false },
    ]);
    expect(got).toEqual([
      { file: 'src/s.ts', line: 4, statement: 'this.cache.clear();' },
    ]);
  });

  it('skips a class field when the class header spans multiple lines', () => {
    const content = src([
      'class Store',
      '  extends Base',
      '{',
      '  cache = new Map();',
      '  reset() {',
      '    this.cache.clear();',
      '  }',
      '}',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: all(8), hasNewTests: false },
    ]);
    expect(got).toEqual([
      { file: 'src/s.ts', line: 6, statement: 'this.cache.clear();' },
    ]);
  });

  it('skips a class field when the extends clause has an inline object type', () => {
    // `extends Base<{ foo: string }>` has balanced braces on its own line.
    // The backward walk must not break there — only a net-unbalanced brace
    // (a real block boundary) stops it — or the `class` keyword on the line
    // above is never reached and the field is admitted.
    const content = src([
      'class Store',
      '  extends Base<{ foo: string }>',
      '{',
      '  cache = new Map();',
      '  reset() {',
      '    this.cache.clear();',
      '  }',
      '}',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: all(8), hasNewTests: false },
    ]);
    expect(got).toEqual([
      { file: 'src/s.ts', line: 6, statement: 'this.cache.clear();' },
    ]);
  });

  it('selects a method-body statement when the method is the first class member', () => {
    // The backward walk from the method's `{` reaches `class Store {` on the
    // very first step. The `[;{}]` stop must fire before the `class` match on
    // that same line, or the walk overshoots into the class header and rejects
    // a statement that is inside the method body, not the class body.
    const content = src([
      'class Store {',
      '  reset() {',
      '    this.cache.clear();',
      '  }',
      '}',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: all(5), hasNewTests: false },
    ]);
    expect(got).toEqual([
      { file: 'src/s.ts', line: 3, statement: 'this.cache.clear();' },
    ]);
  });

  it('skips what it cannot delete whole — declarations, headers, fragments', () => {
    // Every line here contains a safety verb; none is a deletable statement.
    // False negatives are fine, but each false positive wastes a suite run —
    // or worse, `if (stale)` above a call would silently rebind the NEXT
    // statement to the `if` when the call is deleted.
    const content = src([
      'const fresh = new Map();', // declaration
      'if (done) pending.delete(id);', // control-flow header on the line
      'register(', // opener …
      '  bar.clear(),', // … argument, not `;`-terminated
      ');', // … tail
      'chain', // receiver …
      '  .clear();', // … fluent tail, starts with `.`
      'const n = base +', // continuation …
      '  offsets.delete(k);', // … its tail
      'if (stale)', // brace-less if …
      '  cache.clear();', // … its sole statement
      'this.items = [1];', // not reassignment-to-EMPTY
      'this.map = new Map(entries);', // not reassignment-to-empty either
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: all(13), hasNewTests: false },
    ]);
    expect(got).toEqual([]);
  });

  it('rejects a multi-statement line even when a safety verb matches', () => {
    // Two statements on one line: deleting the whole line removes BOTH, and
    // the extra deletion can MASK a missing test on the safety verb.
    const content = src([
      'export function reset() {',
      "  this.cache.clear(); this.emit('reset');",
      '  live.clear();',
      '}',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: [2, 3], hasNewTests: false },
    ]);
    expect(got).toEqual([
      { file: 'src/s.ts', line: 3, statement: 'live.clear();' },
    ]);
  });

  it('skips safety-verb text inside template literals and comment blocks', () => {
    // Deleting a line of string or commented-out code changes no behaviour, so
    // its mutant would ALWAYS survive — a guaranteed false finding.
    const content = src([
      'const brief = `',
      '  sessions.clear();',
      '`;',
      '/*',
      'old.clear();',
      '*/',
      'live.clear();',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: all(7), hasNewTests: false },
    ]);
    expect(got).toEqual([
      { file: 'src/s.ts', line: 7, statement: 'live.clear();' },
    ]);
  });

  it('keeps line accounting across a string that swallows its line end', () => {
    // A `\`-continued string is legal JS whose literal contains the newline. A
    // scanner that consumes that newline drops one per-line flag and every
    // later line reads its NEIGHBOUR's literal-state — here that would admit
    // line 4, which starts inside a block comment: deleting it removes the
    // `*/` and comments out the code below, a mutant nobody asked for.
    const content = src([
      "const s = 'weird \\",
      "tail';",
      '/* block',
      'note */ cache.clear();',
      'after.clear();',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: all(5), hasNewTests: false },
    ]);
    expect(got).toEqual([
      { file: 'src/s.ts', line: 5, statement: 'after.clear();' },
    ]);
  });

  it('keeps line accounting across a backslash-continued template literal', () => {
    // The template-state escape skip must not swallow a `\`-continued line's
    // newline: doing so drops a per-line flag and shifts every later verdict
    // onto its neighbour — here that would admit line 4, which starts inside a
    // block comment, so deleting it removes the `*/` and comments out the code
    // below. Mirrors the single-quote case above for the template branch.
    const content = src([
      'const brief = `weird \\',
      'tail`;',
      '/* block',
      'note */ cache.clear();',
      'after.clear();',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: all(5), hasNewTests: false },
    ]);
    expect(got).toEqual([
      { file: 'src/s.ts', line: 5, statement: 'after.clear();' },
    ]);
  });

  it('does not let a nested template inside ${} close the outer literal', () => {
    // A backtick inside a `${…}` interpolation opens a NESTED template.
    // Reading it as the outer close marks the outer literal's remaining lines
    // as code, and the template TEXT `baz.clear();` becomes a candidate whose
    // deletion compiles and survives — a false finding filed against string
    // content. Real code after the outer literal must still be selected.
    const content = src([
      'const x = `foo ${`bar;',
      'baz.clear();',
      '`} qux`;',
      'after.clear();',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: all(4), hasNewTests: false },
    ]);
    expect(got).toEqual([
      { file: 'src/s.ts', line: 4, statement: 'after.clear();' },
    ]);
  });

  it('does not let a regex literal in an interpolation swallow later code', () => {
    // A regex literal is not a string: skipping from the `'` in `/'/g` to a
    // matching quote runs past the interpolation's `}` (no closing quote on the
    // line), so the scanner never leaves the template, its end state is not
    // `code`, and a real safety statement on the next line is silently dropped.
    // Not skipping quotes inside an interpolation keeps the brace depth honest;
    // the statement must be selected.
    const content = src([
      'const q = `${x.replace(/\'/g, "")}`;',
      'items.clear();',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: all(2), hasNewTests: false },
    ]);
    expect(got).toEqual([
      { file: 'src/s.ts', line: 2, statement: 'items.clear();' },
    ]);
  });

  it('does not let a } in nested-template text close the outer interpolation', () => {
    // A `}` in a nested template's TEXT (not its own interpolation) must not
    // decrement the outer interpDepth. Without the nested-template sub-scan,
    // the depth drops to 0 and the nested close backtick reads as the outer
    // close, admitting the outer literal's remaining text as code.
    const content = src([
      'const x = `a${x + `b } c`}d',
      'items.clear();',
      '`;',
      'after.clear();',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: all(4), hasNewTests: false },
    ]);
    expect(got).toEqual([
      { file: 'src/s.ts', line: 4, statement: 'after.clear();' },
    ]);
  });

  it('keeps outer-template text after a nested template whose text holds a }', () => {
    // The #8020 trigger. A `}` in the nested template's TEXT must not read as
    // the end of the outer interpolation: with a depth counter it drained the
    // depth to zero, the nested close backtick then read as the OUTER close,
    // and the template text `sessions.clear();` — a non-executable line —
    // became a deletion mutant whose survival was a guaranteed false finding.
    const content = src([
      'const x = `text ${ foo(`nested }`) };',
      'sessions.clear();',
      '`;',
      'after.clear();',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: all(4), hasNewTests: false },
    ]);
    expect(got).toEqual([
      { file: 'src/s.ts', line: 4, statement: 'after.clear();' },
    ]);
  });

  it('tracks a nested template inside a nested interpolation (two levels)', () => {
    // Same trigger one level deeper: the deep template's text `}` must only be
    // text. A single nesting counter cannot represent this — it mis-assigns
    // the `}` to the nested interpolation, reads the rest of the line out of
    // phase, and either admits the template text `sessions.clear();` or ends
    // the scan derailed and silently drops the REAL candidate on line 4. Only
    // a stack of template/interpolation frames gets both lines right.
    const content = src([
      'const x = `text ${ foo(`nested ${ bar(`deep }`) } tail`) };',
      'sessions.clear();',
      '`;',
      'after.clear();',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: all(4), hasNewTests: false },
    ]);
    expect(got).toEqual([
      { file: 'src/s.ts', line: 4, statement: 'after.clear();' },
    ]);
  });

  it('treats a lone ${ left unclosed at EOF as a derailed scan, not code', () => {
    // An interpolation that never closes leaves every later line's state
    // unknowable. The scan must end non-`code` so the file's candidates are
    // dropped (and disclosed), never trusted.
    const content = src(['const x = `text ${ foo(', 'sessions.clear();', '']);
    const { selected, derailed } = selectMutants([
      { file: 'src/s.ts', content, addedLines: all(2), hasNewTests: false },
    ]);
    expect(selected).toEqual([]);
    expect(derailed).toEqual(['src/s.ts']);
  });

  it('does not read a single-line nested-template interpolation as code', () => {
    // The same nesting on one line: skipping from the outer backtick to the
    // NEXT backtick exposes the inner template's content (`key.reset(`) as
    // code, so a verb that is actually string content matches and a valid
    // template assignment is selected and deleted — a wasted run and a false
    // finding.
    const content = src([
      'export function summarize(entries: Entry[]) {',
      "  summary = `Results: ${entries.map((e) => `key.reset(${e.id})`).join('; ')};`;",
      '  live.clear();',
      '}',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: [2, 3], hasNewTests: false },
    ]);
    expect(got).toEqual([
      { file: 'src/s.ts', line: 3, statement: 'live.clear();' },
    ]);
  });

  it('rejects a class field below a template whose text contains a brace', () => {
    // The class-body walk reads code lines, not raw text: a multi-line
    // template whose CONTENT holds an unmatched `{` (agent briefs embed JSON
    // examples) would otherwise read as an opening brace, stop the walk before
    // the class header, and admit the field — deleting a declaration, not a
    // cleanup. The method-body statement below it must still be selected.
    const content = src([
      'class Store {',
      '  brief = `',
      '    docs with { brace',
      '  `;',
      '  cache = new Map();',
      '  reset() {',
      '    this.cache.clear();',
      '  }',
      '}',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: all(9), hasNewTests: false },
    ]);
    expect(got).toEqual([
      { file: 'src/s.ts', line: 7, statement: 'this.cache.clear();' },
    ]);
  });

  it('sees through a trailing comment on the candidate and its predecessor', () => {
    // The end-anchored checks run on the code portion only. A trailing comment
    // must not hide the candidate's `;` (dropping a genuine reset) nor the
    // predecessor's statement end — `reminders.clear(); // why` is exactly the
    // dogfood shape this probe was built to catch.
    const content = src([
      'export function reset() {',
      '  const x = setup(); // prepare',
      '  reminders.clear(); // why',
      '}',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: [2, 3], hasNewTests: false },
    ]);
    expect(got).toEqual([
      { file: 'src/s.ts', line: 3, statement: 'reminders.clear(); // why' },
    ]);
  });

  it('does not select a safety verb that only appears inside a string', () => {
    // A verb inside a string is not a statement: deleting the line removes a
    // log call, the suite stays green, and a misleading `mutant-survived`
    // finding is filed — a false positive that also burns a suite run.
    const content = src([
      'export function report() {',
      '  logger.info("sessions.clear() done");',
      '  live.clear();',
      '}',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: [2, 3], hasNewTests: false },
    ]);
    expect(got).toEqual([
      { file: 'src/s.ts', line: 3, statement: 'live.clear();' },
    ]);
  });

  it('discards ALL candidates from a file whose scan derails, and names the file', () => {
    // A backtick inside a regex literal flips the scanner into template state
    // through to EOF. Even the valid candidate before the derailment is
    // discarded — the scan is untrustworthy past it, and over-rejecting is the
    // cheap error. The file comes back in `derailed` so the caller can
    // disclose the dropped candidates instead of reporting a silent zero. A
    // clean sibling file's candidates are unaffected.
    const content = src([
      'state.clear();',
      'const re = /`/;',
      'other.clear();',
      '',
    ]);
    const { selected, derailed } = selectMutants([
      { file: 'src/s.ts', content, addedLines: [1, 2, 3], hasNewTests: false },
      {
        file: 'src/clean.ts',
        content: src(['live.clear();', '']),
        addedLines: [1],
        hasNewTests: false,
      },
    ]);
    expect(selected).toEqual([
      { file: 'src/clean.ts', line: 1, statement: 'live.clear();' },
    ]);
    expect(derailed).toEqual(['src/s.ts']);
  });

  it('caps at MAX_MUTANTS, preferring files that also have new tests', () => {
    const line = (i: number) => `store${i}.clear();`;
    const content = src([...all(5).map(line), '']);
    const { selected: got, skippedForCap } = selectMutants([
      // Diff order says untested first; the preference must still put every
      // candidate from the tested file ahead of it, and the cap then keeps
      // the untested file's EARLIEST lines.
      {
        file: 'src/untested.ts',
        content,
        addedLines: all(5),
        hasNewTests: false,
      },
      { file: 'src/tested.ts', content, addedLines: all(5), hasNewTests: true },
    ]);
    expect(MAX_MUTANTS).toBe(8);
    expect(got).toHaveLength(8);
    expect(skippedForCap).toBe(2);
    expect(got.slice(0, 5).map((c) => c.file)).toEqual(
      Array(5).fill('src/tested.ts'),
    );
    expect(got.slice(5).map((c) => [c.file, c.line])).toEqual([
      ['src/untested.ts', 1],
      ['src/untested.ts', 2],
      ['src/untested.ts', 3],
    ]);
  });
});

describe('hasCollocatedNewTest', () => {
  it('pairs file.ts with its collocated file.test.ts / file.spec.ts', () => {
    expect(
      hasCollocatedNewTest('packages/cli/src/x.ts', [
        'packages/cli/src/x.test.ts',
      ]),
    ).toBe(true);
    expect(
      hasCollocatedNewTest('packages/cli/src/x.ts', [
        'packages/cli/src/x.spec.ts',
      ]),
    ).toBe(true);
    expect(
      hasCollocatedNewTest('packages/cli/src/Comp.tsx', [
        'packages/cli/src/Comp.test.tsx',
      ]),
    ).toBe(true);
  });

  it('does not pair across directories or by basename suffix', () => {
    expect(
      hasCollocatedNewTest('packages/cli/src/x.ts', [
        'packages/core/src/x.test.ts',
      ]),
    ).toBe(false);
    // `xy.test.ts` must not satisfy `y.ts` — stem equality, not endsWith.
    expect(
      hasCollocatedNewTest('packages/cli/src/y.ts', [
        'packages/cli/src/xy.test.ts',
      ]),
    ).toBe(false);
  });
});

describe('classifyMutantRun', () => {
  // Verdicts flow through the SAME per-file classifier the revert probe uses,
  // so these fixtures are the vitest-JSON shapes classifyProbeRun already
  // understands — what is under test is the mutant-level aggregation.
  const perFile = (exit: number, json: unknown, probes: string[]) =>
    classifyProbeRun(exit, JSON.stringify(json), probes);

  it('SURVIVED when every affected test still passes', () => {
    const got = classifyMutantRun(
      perFile(
        0,
        {
          testResults: [
            { name: '/w/a.test.ts', assertionResults: [{ status: 'passed' }] },
          ],
        },
        ['a.test.ts'],
      ),
    );
    expect(got).toBe('survived');
  });

  it('KILLED when any assertion fails — the deletion was caught', () => {
    const got = classifyMutantRun(
      perFile(
        1,
        {
          testResults: [
            { name: '/w/a.test.ts', assertionResults: [{ status: 'passed' }] },
            { name: '/w/b.test.ts', assertionResults: [{ status: 'failed' }] },
          ],
        },
        ['a.test.ts', 'b.test.ts'],
      ),
    );
    expect(got).toBe('killed');
  });

  it('INCONCLUSIVE when the mutant breaks the compile, never killed', () => {
    // The revert probe's trap, inherited: a run that collected nothing is not
    // a test catching the deletion.
    const got = classifyMutantRun(
      perFile(1, { testResults: [] }, ['a.test.ts']),
    );
    expect(got).toBe('inconclusive');
  });

  it('does not let a green sibling upgrade a non-collected file to SURVIVED', () => {
    // The file that failed to collect might be the very one that would have
    // caught the deletion — "survived" requires every file to have run.
    const got = classifyMutantRun(
      perFile(
        0,
        {
          testResults: [
            { name: '/w/a.test.ts', assertionResults: [{ status: 'passed' }] },
          ],
        },
        ['a.test.ts', 'b.test.ts'],
      ),
    );
    expect(got).toBe('inconclusive');
  });

  it('a kill outranks an inconclusive sibling — red is red', () => {
    const got = classifyMutantRun(
      perFile(
        1,
        {
          testResults: [
            { name: '/w/a.test.ts', assertionResults: [{ status: 'failed' }] },
          ],
        },
        ['a.test.ts', 'b.test.ts'],
      ),
    );
    expect(got).toBe('killed');
  });

  it('an empty run proves nothing', () => {
    expect(classifyMutantRun([])).toBe('inconclusive');
  });
});

describe('fitsAnotherMutantRun', () => {
  it('requires room for one more mutant run — the revert is reserved by the deadline', () => {
    expect(fitsAnotherMutantRun(60_000, 60_000)).toBe(true);
    expect(fitsAnotherMutantRun(59_999, 60_000)).toBe(false);
    expect(fitsAnotherMutantRun(0, 60_000)).toBe(false);
  });
});
