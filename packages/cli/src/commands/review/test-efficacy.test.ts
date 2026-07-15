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
  safeRmWithin,
  probeCreateFailureDetail,
  probeCleanupFailureDetail,
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
