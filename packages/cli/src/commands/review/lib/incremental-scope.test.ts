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
