/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The widening heuristic's contract is directional: a false positive costs one
// extra review, a false negative keeps the pre-widening floor. These tests pin
// the resolution rules (ESM-TS `.js` → `.ts`, index forms, workspace names)
// and the fail-quiet misses, because a resolver that silently resolved OUTSIDE
// the membership set would widen the scope with files nobody planned.

import { describe, it, expect } from 'vitest';
import {
  scanImportSpecifiers,
  resolveSpecifier,
  dependentsOfChanged,
  discoverWorkspacePackages,
} from './import-graph.js';

describe('scanImportSpecifiers', () => {
  it('finds all four import shapes, deduplicated, order preserved', () => {
    const src = `
      import { a } from './a.js';
      import defaultB from "../b.js";
      export { c } from './c.js';
      export * from './d.js';
      import './side-effect.js';
      const e = await import('./e.js');
      const f = require('./f.cjs');
      import { a2 } from './a.js';
    `;
    expect(scanImportSpecifiers(src)).toEqual([
      './a.js',
      '../b.js',
      './c.js',
      './d.js',
      './side-effect.js',
      './e.js',
      './f.cjs',
    ]);
  });

  it('ignores template-literal and multi-line specifiers', () => {
    expect(scanImportSpecifiers('await import(`./x${v}.js`)')).toEqual([]);
    expect(scanImportSpecifiers("from '\n./broken.js'")).toEqual([]);
  });

  it('accepts type-only imports — a signature change is an interaction too', () => {
    expect(
      scanImportSpecifiers("import type { T } from './types.js';"),
    ).toEqual(['./types.js']);
  });
});

describe('resolveSpecifier', () => {
  const files = new Set([
    'packages/cli/src/a.ts',
    'packages/cli/src/b.tsx',
    'packages/cli/src/dir/index.ts',
    'packages/core/src/index.ts',
    'packages/core/src/util/x.ts',
  ]);
  const pkgs = [
    { name: '@qwen/core', dir: 'packages/core' },
    { name: '@qwen/cli', dir: 'packages/cli' },
  ];

  it('maps the emitted-extension specifier back to its source', () => {
    expect(resolveSpecifier('packages/cli/src/z.ts', './a.js', files)).toBe(
      'packages/cli/src/a.ts',
    );
    expect(resolveSpecifier('packages/cli/src/z.ts', './b.jsx', files)).toBe(
      'packages/cli/src/b.tsx',
    );
  });

  it('walks extensions and index forms for extensionless specifiers', () => {
    expect(resolveSpecifier('packages/cli/src/z.ts', './a', files)).toBe(
      'packages/cli/src/a.ts',
    );
    expect(resolveSpecifier('packages/cli/src/z.ts', './dir', files)).toBe(
      'packages/cli/src/dir/index.ts',
    );
  });

  it('resolves workspace-package specifiers, entry and subpath alike', () => {
    expect(
      resolveSpecifier('packages/cli/src/z.ts', '@qwen/core', files, pkgs),
    ).toBe('packages/core/src/index.ts');
    expect(
      resolveSpecifier(
        'packages/cli/src/z.ts',
        '@qwen/core/src/util/x.js',
        files,
        pkgs,
      ),
    ).toBe('packages/core/src/util/x.ts');
    // A dist deep-import names build output; the src fallback finds the source.
    expect(
      resolveSpecifier(
        'packages/cli/src/z.ts',
        '@qwen/core/util/x.js',
        files,
        pkgs,
      ),
    ).toBe('packages/core/src/util/x.ts');
  });

  it('maps an emitted .js specifier to a .tsx source — the UI layer convention', () => {
    const uiFiles = new Set(['packages/cli/src/ui/App.tsx']);
    expect(
      resolveSpecifier(
        'packages/cli/src/ui/AppContainer.tsx',
        './App.js',
        uiFiles,
      ),
    ).toBe('packages/cli/src/ui/App.tsx');
  });

  it('resolves .mjs to .mts and root-package (dir: "") specifiers', () => {
    const rootFiles = new Set(['src/index.ts', 'src/util/x.ts', 'mod.mts']);
    const rootPkg = [{ name: 'root', dir: '' }];
    expect(resolveSpecifier('a.ts', './mod.mjs', rootFiles)).toBe('mod.mts');
    expect(resolveSpecifier('a.ts', 'root', rootFiles, rootPkg)).toBe(
      'src/index.ts',
    );
    expect(
      resolveSpecifier('a.ts', 'root/src/util/x.js', rootFiles, rootPkg),
    ).toBe('src/util/x.ts');
  });

  it('strips the dist/ segment on emitted-tree deep imports', () => {
    const distFiles = new Set(['packages/core/src/utils/foo.ts']);
    const distPkgs = [{ name: '@qwen/core', dir: 'packages/core' }];
    expect(
      resolveSpecifier(
        'a.ts',
        '@qwen/core/dist/utils/foo.js',
        distFiles,
        distPkgs,
      ),
    ).toBe('packages/core/src/utils/foo.ts');
  });

  it('a directory that merely BEGINS with dots is not a root escape', () => {
    const dotFiles = new Set(['..config/mod.ts']);
    expect(resolveSpecifier('a.ts', './..config/mod.js', dotFiles)).toBe(
      '..config/mod.ts',
    );
    // Separating case for the guard itself: membership CONTAINS the escaping
    // path, so only repoJoin's refusal produces the null.
    expect(
      resolveSpecifier('a.ts', '../../x', new Set(['../../x.ts'])),
    ).toBeNull();
  });

  it('returns null outside membership, above the root, and for unknown packages', () => {
    expect(
      resolveSpecifier('packages/cli/src/z.ts', './missing', files),
    ).toBeNull();
    expect(resolveSpecifier('a.ts', '../../escape', files)).toBeNull();
    expect(resolveSpecifier('a.ts', 'left-pad', files, pkgs)).toBeNull();
  });
});

describe('dependentsOfChanged', () => {
  const sources = new Map<string, string>([
    ['src/caller.ts', "import { f } from './changed.js';"],
    ['src/bystander.ts', "import { g } from './other.js';"],
    ['src/changed.ts', "import { h } from './caller.js';"],
  ]);
  const read = (p: string) => sources.get(p) ?? null;

  it('returns only candidates that import a changed file, with the edges named', () => {
    const changed = new Set(['src/changed.ts']);
    const out = dependentsOfChanged(
      changed,
      ['src/caller.ts', 'src/bystander.ts', 'src/changed.ts'],
      read,
    );
    expect([...out.entries()]).toEqual([['src/caller.ts', ['src/changed.ts']]]);
  });

  it('skips candidates already in the changed set — they are in scope on their own account', () => {
    const changed = new Set(['src/changed.ts', 'src/caller.ts']);
    const out = dependentsOfChanged(changed, ['src/caller.ts'], read);
    expect(out.size).toBe(0);
  });

  it('consults the packages argument for cross-package edges', () => {
    const out = dependentsOfChanged(
      new Set(['packages/core/src/index.ts']),
      ['packages/cli/src/z.ts'],
      () => "import { x } from '@qwen/core';",
      [{ name: '@qwen/core', dir: 'packages/core' }],
    );
    expect([...out.entries()]).toEqual([
      ['packages/cli/src/z.ts', ['packages/core/src/index.ts']],
    ]);
  });

  it('an unreadable candidate contributes no edge and no crash', () => {
    const out = dependentsOfChanged(
      new Set(['src/changed.ts']),
      ['src/gone.ts'],
      () => null,
    );
    expect(out.size).toBe(0);
  });
});

describe('discoverWorkspacePackages', () => {
  const manifests = new Map<string, string>([
    ['package.json', JSON.stringify({ name: 'root' })],
    ['packages/core/package.json', JSON.stringify({ name: '@qwen/core' })],
    ['packages/cli/package.json', JSON.stringify({ name: '@qwen/cli' })],
  ]);
  const read = (p: string) => manifests.get(p) ?? null;

  it('maps each file to its nearest manifest, most specific dir first', () => {
    const pkgs = discoverWorkspacePackages(
      ['packages/core/src/a.ts', 'packages/cli/src/deep/b.ts', 'scripts/x.js'],
      read,
    );
    expect(pkgs).toEqual([
      { name: '@qwen/core', dir: 'packages/core' },
      { name: '@qwen/cli', dir: 'packages/cli' },
      { name: 'root', dir: '' },
    ]);
  });

  it('is fail-quiet on malformed or nameless manifests', () => {
    for (const manifest of [
      'not json',
      JSON.stringify({ name: '' }),
      JSON.stringify({}),
    ]) {
      const pkgs = discoverWorkspacePackages(['pkg/src/a.ts'], (p) =>
        p === 'pkg/package.json' ? manifest : null,
      );
      expect(pkgs).toEqual([]);
    }
  });
});
