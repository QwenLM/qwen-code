/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `computeIncrementalScope` is pure but for two injected readers, which is
// what makes the whole scope decision testable without a repository — the
// property its docstring claims and nothing exercised directly until now.

import { describe, it, expect } from 'vitest';
import { computeIncrementalScope } from './incremental-scope.js';

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

describe('computeIncrementalScope — interaction ordering', () => {
  it('puts SECTIONLESS interaction files first, ahead of the brief cap', () => {
    // Two kinds of interaction file, and only one of them has a second
    // surface. An importer that carries a section of the PR's diff is also
    // named — uncapped — in the chunk brief holding that section. A RESTORED
    // file pulled in by the second pass carries none: its own content is base
    // content, no chunk holds it, and the capped whole-diff list is the only
    // place its seam is briefed at all.
    //
    // Insertion order appended the restored ones LAST, so on any round past
    // `SCOPE_LIST_CAP` they were the first elided into `(+N more)` — the seam
    // unbriefed while `scope.interaction` recorded it as covered. The cap has
    // to bite the redundantly-named entries first.
    const changed = 'src/changed.ts';
    const restoredPath = 'src/restored.ts';
    const importers = Array.from({ length: 3 }, (_, i) => `src/imp${i}.ts`);

    const fullDiff = Buffer.from(
      [section(changed), ...importers.map(section)].join(''),
      'utf8',
    );
    const sources: Record<string, string> = {
      // The restored file imports the still-changing one: a live seam, and
      // it has no section of its own anywhere in the PR's diff.
      [restoredPath]: `import './changed.js';\n`,
    };
    for (const p of importers) sources[p] = `import './changed.js';\n`;

    const ruling = computeIncrementalScope({
      anchor: 'a'.repeat(40),
      fullDiff,
      deltaFiles: [changed, restoredPath],
      restored: (path) => path === restoredPath,
      readWorktree: (rel) => sources[rel] ?? null,
    });

    expect(ruling.kind).toBe('scoped');
    if (ruling.kind !== 'scoped') return;
    const paths = ruling.scope.interaction.map((e) => e.path);
    // The sectionless one leads, whatever the insertion order was.
    expect(paths[0]).toBe(restoredPath);
    // …and the sectioned importers follow, each of which a chunk brief also
    // names in full.
    expect(paths.slice(1).sort()).toEqual([...importers].sort());
    // The seam itself survives — an entry with no edge is not an interaction.
    expect(ruling.scope.interaction[0].importsChanged).toEqual([changed]);
    expect(ruling.scope.restoredFileCount).toBe(1);
    // The restored file owes no review of its own.
    expect(ruling.scope.deltaFiles).toEqual([changed]);
  });
});

describe('computeIncrementalScope — a revert against a still-live contract', () => {
  it('scopes the callee a restored importer strands, instead of stopping', () => {
    // The shape the second widening pass exists for, and the one it could not
    // see. Round 1 changes `i.ts` (`foo(x)` → `foo(x, y)`) together with its
    // caller `r.ts` and clears both at the anchor; the fix round reverts ONLY
    // `r.ts`. So the delta is `{r.ts}` and it is restored — `deltaLive` is
    // empty — while `i.ts` carries the PR's only section, changed before the
    // anchor and unchanged since.
    //
    // Two layers stopped the round dead. Keyed on `deltaLive`, the pass
    // resolved `r.ts`'s import against an EMPTY membership and found no edge;
    // and even with the edge, `scoped` took only the importer side, so the
    // section that actually moves was never kept and `kept.length === 0`
    // ruled `nothing-new` anyway. `upToDate` does not advance the anchor, so
    // every re-run rules the same: `r.ts@base × i.ts@head` — the base-era
    // call against the new contract — reviewed by no round, and absent from
    // every later delta by construction.
    const i = 'src/i.ts';
    const r = 'src/r.ts';
    // `r.ts` is byte-identical to the merge base, so the PR's own diff
    // carries no section for it. `i.ts` is the whole of the PR's diff.
    const ruling = computeIncrementalScope({
      anchor: 'a'.repeat(40),
      fullDiff: Buffer.from(section(i), 'utf8'),
      deltaFiles: [r],
      restored: (path) => path === r,
      readWorktree: (rel) => (rel === r ? `import './i.js';\n` : null),
    });

    expect(ruling.kind).toBe('scoped');
    if (ruling.kind !== 'scoped') return;
    // The seam is briefed…
    expect(ruling.scope.interaction).toEqual([
      { path: r, importsChanged: [i] },
    ]);
    // …and the moving side is actually published, which is the half the
    // importer-only `scoped` set dropped.
    expect(ruling.diff.toString('utf8')).toContain(`b/${i}`);
    // The restored file owes no review of its own.
    expect(ruling.scope.deltaFiles).toEqual([]);
    expect(ruling.scope.restoredFileCount).toBe(1);
    // `i.ts` was scoped IN as the seam's target, so it is not a file the
    // widening considered and passed over.
    expect(ruling.scope.contextFileCount).toBe(0);
  });
});
