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
} from './test-efficacy.js';

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

  it('does not revert non-executable source (a .md/.json fixture)', () => {
    // classifyPath labels a fixture under a src tree `source`. Reverting it is
    // meaningless (no behaviour) and destructive — this PR ships a .md fixture
    // that pr-context.test.ts loads; deleting it makes that test fail to load
    // and the probe inconclusive because of the probe itself.
    const plan = planTestEfficacy(
      [
        { path: 'packages/cli/src/x.ts', kind: 'source' },
        { path: 'packages/cli/src/__fixtures__/body.md', kind: 'source' },
        { path: 'packages/cli/src/data.json', kind: 'source' },
        { path: 'packages/cli/src/x.test.ts', kind: 'test' },
      ],
      GLOBS,
    );
    expect(plan.revert).toEqual(['packages/cli/src/x.ts']);
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
