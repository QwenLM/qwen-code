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
