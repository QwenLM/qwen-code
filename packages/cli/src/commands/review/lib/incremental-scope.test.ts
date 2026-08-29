/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The widening is pure but for one injected reader, which is what makes it
// testable without a repository. The selection it widens comes from the real
// `selectNarrowing`, so these exercise the pair as the command wires it.

import { describe, it, expect } from 'vitest';
import { widenScope } from './incremental-scope.js';
import { assembleSections, selectNarrowing } from './narrow-diff.js';
import { buildDiffPlan, parseDiff } from './diff-plan.js';

/** A one-hunk section for `path`, as `parseDiff` reads it. */
function section(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,1 +1,2 @@',
    ' keep',
    '+added',
    '',
  ].join('\n');
}

function selectionOf(fullPaths: string[], deltaPaths: string[]) {
  const sel = selectNarrowing(
    Buffer.from(fullPaths.map(section).join(''), 'utf8'),
    Buffer.from(deltaPaths.map(section).join(''), 'utf8'),
  );
  if (sel === null) throw new Error('the narrowing refused this fixture');
  return sel;
}

describe('widenScope', () => {
  it('pulls in a still-clean importer, and publishes its section', () => {
    // `imp.ts` is untouched since the anchor, so no delta capture can show it
    // — but the round before cleared it against `changed.ts`'s OLD shape, and
    // (importer@head × callee@head) is a pairing no round has seen.
    const selection = selectionOf(
      ['src/changed.ts', 'src/imp.ts', 'src/other.ts'],
      ['src/changed.ts'],
    );
    const sources: Record<string, string> = {
      'src/imp.ts': `import './changed.js';\n`,
      'src/other.ts': `import './unrelated.js';\n`,
    };

    const { paths, scope } = widenScope({
      anchor: 'a'.repeat(40),
      selection,
      readWorktree: (rel) => sources[rel] ?? null,
    });

    expect([...paths].sort()).toEqual(['src/changed.ts', 'src/imp.ts']);
    expect(scope.deltaFiles).toEqual(['src/changed.ts']);
    expect(scope.interaction).toEqual([
      { path: 'src/imp.ts', importsChanged: ['src/changed.ts'] },
    ]);
    // `other.ts` was weighed and passed over — it imports nothing that moved.
    expect(scope.contextFileCount).toBe(1);

    // The published bytes are the PR's own sections, both of them.
    const diff = assembleSections(selection, paths);
    expect(diff?.toString('utf8')).toContain('b/src/changed.ts');
    expect(diff?.toString('utf8')).toContain('b/src/imp.ts');
  });

  it('returns exactly the narrowing when nothing imports what moved', () => {
    // The floor: with no edge to follow the widened round must be the
    // unwidened one, not a second path that could disagree with it.
    const selection = selectionOf(
      ['src/changed.ts', 'src/other.ts'],
      ['src/changed.ts'],
    );
    const { paths, scope } = widenScope({
      anchor: 'a'.repeat(40),
      selection,
      readWorktree: () => `import './unrelated.js';\n`,
    });

    expect([...paths]).toEqual(['src/changed.ts']);
    expect(scope.interaction).toEqual([]);
    expect(scope.contextFileCount).toBe(1);
    expect(assembleSections(selection, paths)?.toString('utf8')).toBe(
      assembleSections(selection, selection.touched)?.toString('utf8'),
    );
  });

  it('does not follow a test file into scope', () => {
    // Re-running tests is `build-test`'s job; a test importing what moved is
    // not a seam a reading agent owes a second look.
    const selection = selectionOf(
      ['src/changed.ts', 'src/changed.test.ts'],
      ['src/changed.ts'],
    );
    const { paths, scope } = widenScope({
      anchor: 'a'.repeat(40),
      selection,
      readWorktree: () => `import './changed.js';\n`,
    });

    expect([...paths]).toEqual(['src/changed.ts']);
    expect(scope.interaction).toEqual([]);
  });
});

/** The importer's two-hunk section: hunk 1 sits on the seam, hunk 2 does not. */
const IMP_SECTION = [
  'diff --git a/src/imp.ts b/src/imp.ts',
  '--- a/src/imp.ts',
  '+++ b/src/imp.ts',
  '@@ -1,3 +1,3 @@',
  " import { moved } from './changed.js';",
  '-const a = old();',
  '+const a = moved();',
  ' //',
  '@@ -10,3 +10,3 @@',
  ' function unrelated() {',
  '-  return 0;',
  '+  return 1;',
  ' }',
  '',
].join('\n');

/** The importer's worktree content — its new side, seam on lines 1-2. */
const IMP_SOURCE = [
  "import { moved } from './changed.js';",
  'const a = moved();',
  '//',
  '',
  '',
  '',
  '',
  '',
  '',
  'function unrelated() {',
  '  return 1;',
  '}',
  '',
].join('\n');

function seamSelection() {
  const sel = selectNarrowing(
    Buffer.from(section('src/changed.ts') + IMP_SECTION, 'utf8'),
    Buffer.from(section('src/changed.ts'), 'utf8'),
  );
  if (sel === null) throw new Error('the narrowing refused this fixture');
  return sel;
}

describe('widenScope seam bound (#10104)', () => {
  it('keeps only the hunks that display a seam line, and says so', () => {
    const selection = seamSelection();
    const widened = widenScope({
      anchor: 'a'.repeat(40),
      selection,
      readWorktree: (rel) => (rel === 'src/imp.ts' ? IMP_SOURCE : null),
      seamBound: true,
    });

    expect(widened.scope.interaction).toEqual([
      {
        path: 'src/imp.ts',
        importsChanged: ['src/changed.ts'],
        seam: { kept: 1, total: 2 },
      },
    ]);
    expect([...(widened.hunkKeep?.get('src/imp.ts') ?? [])]).toEqual([0]);

    const diff = assembleSections(
      selection,
      widened.paths,
      widened.hunkKeep,
    )?.toString('utf8');
    expect(diff).toContain('+const a = moved();');
    expect(diff).not.toContain('+  return 1;');
    // The reassembled text is still a well-formed diff the planner tiles.
    const parsed = parseDiff(diff ?? '');
    const imp = parsed.files.find((f) => f.path === 'src/imp.ts');
    expect(imp?.hunks).toHaveLength(1);
    expect(() => buildDiffPlan(diff ?? '', 400)).not.toThrow();
  });

  it('keeps the file as a header-only section when no hunk sits near a seam', () => {
    // The seam lives outside the file's own diff entirely: the import and
    // its uses sit on lines no hunk displays. The file must still publish —
    // header only — so a chunk owns it and its brief asks the seam question.
    const source = [
      '//', // 1
      '//', // 2
      '//', // 3
      '',
      '',
      '',
      '',
      '',
      '',
      'function unrelated() {', // 10
      '  return 1;', // 11
      '}', // 12
      '',
      "import { moved } from './changed.js';", // 14
      'const a = moved();', // 15
      '',
    ].join('\n');
    const selection = seamSelection();
    const widened = widenScope({
      anchor: 'a'.repeat(40),
      selection,
      readWorktree: (rel) => (rel === 'src/imp.ts' ? source : null),
      seamBound: true,
    });

    expect(widened.scope.interaction[0].seam).toEqual({ kept: 0, total: 2 });
    expect(widened.hunkKeep?.get('src/imp.ts')?.size).toBe(0);
    const diff = assembleSections(
      selection,
      widened.paths,
      widened.hunkKeep,
    )?.toString('utf8');
    expect(diff).toContain('diff --git a/src/imp.ts b/src/imp.ts');
    expect(diff).not.toContain('@@ -1,3 +1,3 @@');
    const parsed = parseDiff(diff ?? '');
    const imp = parsed.files.find((f) => f.path === 'src/imp.ts');
    expect(imp).toBeDefined();
    expect(imp?.hunks).toHaveLength(0);
    // The planner still tiles the header-only section into a chunk.
    const plan = buildDiffPlan(diff ?? '', 400);
    expect(
      plan.chunks.some((c) => c.files.some((f) => f.path === 'src/imp.ts')),
    ).toBe(true);
  });

  it('republishes in full when the seam scan cannot read the source', () => {
    // The edge was found on the first read; the seam read failing is a doubt
    // state, and every doubt state republishes what the unbounded widening
    // would have.
    const reads = new Map<string, number>();
    const selection = seamSelection();
    const widened = widenScope({
      anchor: 'a'.repeat(40),
      selection,
      readWorktree: (rel) => {
        if (rel !== 'src/imp.ts') return null;
        const n = (reads.get(rel) ?? 0) + 1;
        reads.set(rel, n);
        return n === 1 ? IMP_SOURCE : null;
      },
      seamBound: true,
    });
    expect(widened.scope.interaction[0].seam).toBeUndefined();
    expect(widened.hunkKeep).toBeUndefined();
    expect(
      assembleSections(selection, widened.paths, widened.hunkKeep)?.toString(
        'utf8',
      ),
    ).toBe(assembleSections(selection, widened.paths)?.toString('utf8'));
  });

  it('the doubt shape keeps a clamped pure-deletion hunk (#10136)', () => {
    // The doubt return marks lines 1..total, but `parseDiff` clamps a
    // `@@ -1,N +0,0 @@` hunk to new-side [0,0] — no marked line is ever 0,
    // so hunk matching in the doubt state shed exactly the hunk the doubt
    // promises to keep. The doubt shape is detected before matching: the
    // file republishes in full, with NO seam record, exactly like the
    // unreadable-source doubt state.
    const impSection = [
      'diff --git a/src/imp.ts b/src/imp.ts',
      '--- a/src/imp.ts',
      '+++ b/src/imp.ts',
      '@@ -1,2 +0,0 @@',
      '-deleted line one',
      '-deleted line two',
      '@@ -10,3 +8,3 @@',
      ' function unrelated() {',
      '-  return 0;',
      '+  return 1;',
      ' }',
      '',
    ].join('\n');
    const selection = selectNarrowing(
      Buffer.from(section('src/changed.ts') + impSection, 'utf8'),
      Buffer.from(section('src/changed.ts'), 'utf8'),
    );
    if (selection === null)
      throw new Error('the narrowing refused this fixture');
    // The worktree source trips the oracle's doubt: a dynamic import the
    // line-shape read cannot collect bindings from.
    const source = [
      "const api = await import('./changed.js');",
      'api.call();',
    ].join('\n');
    const widened = widenScope({
      anchor: 'a'.repeat(40),
      selection,
      readWorktree: (rel) => (rel === 'src/imp.ts' ? source : null),
      seamBound: true,
    });
    expect(widened.scope.interaction[0].seam).toBeUndefined();
    expect(widened.hunkKeep).toBeUndefined();
    const diff = assembleSections(
      selection,
      widened.paths,
      widened.hunkKeep,
    )?.toString('utf8');
    expect(diff).toContain('@@ -1,2 +0,0 @@');
    expect(diff).toContain('-deleted line one');
    expect(diff).toContain('+  return 1;');
  });

  it('records nothing and drops nothing when the bound is off', () => {
    const selection = seamSelection();
    const widened = widenScope({
      anchor: 'a'.repeat(40),
      selection,
      readWorktree: (rel) => (rel === 'src/imp.ts' ? IMP_SOURCE : null),
    });
    expect(widened.scope.interaction[0]).toEqual({
      path: 'src/imp.ts',
      importsChanged: ['src/changed.ts'],
    });
    expect(widened.hunkKeep).toBeUndefined();
  });
});
