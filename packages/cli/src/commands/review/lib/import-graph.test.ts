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
  seamLines,
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

  it('prefers the LITERAL file over its extension remap when both exist', () => {
    // A mixed JS/TS directory where both siblings changed. Every other test
    // here uses a single-element membership, so nothing distinguished
    // precedence — and the remap ran first, resolving `./util.js` to
    // `util.ts`: a file the caller does not import. That does not cost one
    // extra widened file, it DISPLACES the true edge, so the seam brief names
    // a pairing that does not exist while caller × util.js is named nowhere
    // and retires unreviewed.
    const mixed = new Set([
      'packages/cli/src/util.js',
      'packages/cli/src/util.ts',
    ]);
    expect(resolveSpecifier('packages/cli/src/z.ts', './util.js', mixed)).toBe(
      'packages/cli/src/util.js',
    );
    // …and the remap still resolves when the literal is NOT in the
    // membership, which is the ordinary TS-project case it exists for.
    expect(
      resolveSpecifier(
        'packages/cli/src/z.ts',
        './util.js',
        new Set(['packages/cli/src/util.ts']),
      ),
    ).toBe('packages/cli/src/util.ts');
  });

  it('accepts a package subpath whose directory merely BEGINS with dots', () => {
    // The twin of `repoJoin`'s segment-exact check, which the relative branch
    // already had. `..config/mod.js` normalises to itself and is a legal
    // directory name; read as an escape, the edge is dropped and the seam
    // check is silently disabled for that path.
    const dotted = new Set(['packages/core/..config/mod.ts']);
    expect(
      resolveSpecifier(
        'packages/cli/src/z.ts',
        '@qwen/core/..config/mod.js',
        dotted,
        pkgs,
      ),
    ).toBe('packages/core/..config/mod.ts');
    // A genuine escape is still refused.
    expect(
      resolveSpecifier(
        'packages/cli/src/z.ts',
        '@qwen/core/../outside.js',
        new Set(['packages/outside.ts', 'outside.ts']),
        pkgs,
      ),
    ).toBeNull();
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

  it('resolves .cjs to .cts — every EXT_MAP row has a resolution pin', () => {
    expect(resolveSpecifier('a.ts', './f.cjs', new Set(['f.cts']))).toBe(
      'f.cts',
    );
  });

  it('dist deep-imports resolve under BOTH emit layouts', () => {
    const pkgs = [{ name: '@qwen/core', dir: 'packages/core' }];
    // dist/src/… layout (this repo): strip dist, keep the rest.
    expect(
      resolveSpecifier(
        'a.ts',
        '@qwen/core/dist/src/utils/x.js',
        new Set(['packages/core/src/utils/x.ts']),
        pkgs,
      ),
    ).toBe('packages/core/src/utils/x.ts');
    // flat dist/… layout: strip dist, add src.
    expect(
      resolveSpecifier(
        'a.ts',
        '@qwen/core/dist/utils/x.js',
        new Set(['packages/core/src/utils/x.ts']),
        pkgs,
      ),
    ).toBe('packages/core/src/utils/x.ts');
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

  it('maps an emitted .js to a .jsx source, and normalises package subpaths', () => {
    expect(resolveSpecifier('a.ts', './W.js', new Set(['W.jsx']))).toBe(
      'W.jsx',
    );
    const pkgs = [{ name: '@q/core', dir: 'packages/core' }];
    expect(
      resolveSpecifier(
        'a.ts',
        '@q/core/src/util/../x.js',
        new Set(['packages/core/src/x.ts']),
        pkgs,
      ),
    ).toBe('packages/core/src/x.ts');
    // …and a subpath escaping the package resolves to nothing.
    expect(
      resolveSpecifier(
        'a.ts',
        '@q/core/../outside.js',
        new Set(['outside.ts']),
        pkgs,
      ),
    ).toBeNull();
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

  it('resolves a specifier that already names its source extension', () => {
    // The literal-form candidate: `./a.ts` from a repo that imports source
    // extensions directly (deno-style, or a `.json`/`.css` asset import).
    expect(
      resolveSpecifier('a.ts', './data.json', new Set(['data.json'])),
    ).toBe('data.json');
    expect(resolveSpecifier('a.ts', './b.ts', new Set(['b.ts']))).toBe('b.ts');
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

describe('seamLines', () => {
  const changed = new Set(['src/changed.ts']);

  it('marks the import statement and every use of its bindings', () => {
    const source = [
      "import { moved, other as alias } from './changed.js';", // 1
      "import { untouched } from './stable.js';", // 2
      'const a = moved();', // 3
      'const b = untouched();', // 4
      'function f() {', // 5
      '  return alias + a;', // 6
      '}', // 7
    ].join('\n');
    expect(seamLines('src/imp.ts', source, changed)).toEqual([1, 3, 6]);
  });

  it('follows a namespace import through its alias', () => {
    const source = [
      "import * as ns from './changed.js';", // 1
      'const x = 1;', // 2
      'ns.moved(x);', // 3
    ].join('\n');
    expect(seamLines('src/imp.ts', source, changed)).toEqual([1, 3]);
  });

  it('reads a multiline clause back to its keyword', () => {
    const source = [
      'import {', // 1
      '  moved,', // 2
      "} from './changed.js';", // 3
      'moved();', // 4
    ].join('\n');
    // The statement line is the `from` line; the clause scan recovers the
    // binding across the wrap.
    const lines = seamLines('src/imp.ts', source, changed);
    expect(lines).toContain(3);
    expect(lines).toContain(4);
    expect(lines).toContain(2); // `moved,` itself mentions the binding
  });

  it('binds a require destructuring on the same line', () => {
    const source = [
      "const { moved: local } = require('./changed.js');", // 1
      'local();', // 2
      "const whole = require('./stable.js');", // 3
      'whole();', // 4
    ].join('\n');
    expect(seamLines('src/imp.ts', source, changed)).toEqual([1, 2]);
  });

  it('bounds $-carrying identifiers correctly in both directions', () => {
    // `$` is legal in IDENT_RE and is a regex anchor, and `\b` cannot bound
    // a name that starts or ends with it — the unescaped join both missed
    // real `store$.x` usage lines and false-marked lines whose LAST word was
    // the `$`-less prefix.
    const source = [
      "import { store$ } from './changed.js';", // 1
      'store$.subscribe(fn);', // 2
      'const other = store', // 3 — a different identifier, must NOT mark
      'let $ = 1;', // 4 — a bare `$` is a different identifier too
    ].join('\n');
    expect(seamLines('src/imp.ts', source, changed)).toEqual([1, 2]);

    const leading = [
      "import { $store } from './changed.js';", // 1
      '$store.dispatch();', // 2
      '$$store.dispatch();', // 3 — preceded by `$`: a different identifier
      'const restore = 1;', // 4 — `store` inside another word, must NOT mark
    ].join('\n');
    expect(seamLines('src/imp.ts', leading, changed)).toEqual([1, 2]);
  });

  it('bounds the clause at the keyword, not inside a binding that contains one', () => {
    // A binding named `exporter`/`importData`/`reimport` used to displace
    // the clause bound inside its own name: the substring search for the
    // statement keyword landed in the binding, the clause parsed zero
    // bindings, and every usage line dropped from the seam.
    for (const name of ['exporter', 'importData', 'reimport']) {
      const source = [
        `import { ${name} } from './changed.js';`, // 1
        `${name}(x);`, // 2
      ].join('\n');
      expect(seamLines('src/imp.ts', source, changed)).toEqual([1, 2]);
    }
  });

  it('a trailing comment inside a multiline clause does not drop the usage line (#10136)', () => {
    // The keyword-bound scan used to take the LAST `import` before the
    // `from` — including the one inside the trailing comment — so the
    // clause parsed to the comment's word instead of `moved`, and the
    // usage line dropped from the seam. The scan runs on a comment-stripped
    // view, so the bound lands on the statement keyword.
    const source = [
      'import { moved, // TODO: import more', // 1
      "} from './changed.js';", // 2
      'moved();', // 3
    ].join('\n');
    expect(seamLines('src/imp.ts', source, changed)).toEqual([1, 2, 3]);

    const block = [
      "import { moved, /* note: import more */ } from './changed.js';", // 1
      'moved();', // 2
    ].join('\n');
    expect(seamLines('src/imp.ts', block, changed)).toEqual([1, 2]);
  });

  it('a clause the scan cannot read fails closed to the whole file (#10136)', () => {
    // A specifier quoted inside a string scans as an import; the keyword
    // bound lands on the statement keyword BEFORE the string, so the clause
    // carries the string's quote — a shape no legal clause has. The read
    // refuses to guess bindings from it and marks every line, which
    // `widenScope` republishes in full.
    const source = [
      'export const note = "} from \'./changed.js\'";', // 1
      'const unrelated = 1;', // 2
    ].join('\n');
    expect(seamLines('src/imp.ts', source, changed)).toEqual([1, 2]);
  });

  it('an awaited dynamic import fails closed to the whole file (#10136)', () => {
    // `const api = await import(…)` carries an expression between the `=`
    // and the call, a declaration shape the line-shape read cannot collect
    // bindings from. Rather than silently dropping the binding's usage
    // lines, the scan marks every line and `widenScope` republishes the
    // file in full.
    const source = [
      "const api = await import('./changed.js');", // 1
      'api.call();', // 2
      'const unrelated = 1;', // 3
    ].join('\n');
    expect(seamLines('src/imp.ts', source, changed)).toEqual([1, 2, 3]);
  });

  it('a wrapped dynamic-import declaration fails closed to the whole file (#10136)', () => {
    // The declaration split across a newline: the binding sits on the line
    // BEFORE the call, where the line-shape read of the call's own line
    // cannot see it. Its usage lines used to drop with no doubt; the scan
    // fails closed instead.
    const source = [
      'const api =', // 1
      "  await import('./changed.js');", // 2
      'api.call();', // 3
      'const unrelated = 1;', // 4
    ].join('\n');
    expect(seamLines('src/imp.ts', source, changed)).toEqual([1, 2, 3, 4]);
  });

  it('a declaration-less dynamic import fails closed to the whole file (#10136)', () => {
    // The call's value escapes into expressions the line-shape read cannot
    // follow — a `.then` callback, a promise binding whose `mod` is a seam
    // read the scan never sees. Both shapes fail closed.
    const thenForm = [
      "import('./changed.js').then((mod) => {", // 1
      '  mod.moved();', // 2
      '});', // 3
    ].join('\n');
    expect(seamLines('src/imp.ts', thenForm, changed)).toEqual([1, 2, 3]);

    const promiseForm = [
      "const p = import('./changed.js');", // 1
      'p.then((mod) => {', // 2
      '  mod.moved();', // 3
      '});', // 4
    ].join('\n');
    expect(seamLines('src/imp.ts', promiseForm, changed)).toEqual([1, 2, 3, 4]);
  });

  it('a keywordless require declaration fails closed to the whole file (#10136)', () => {
    // `import x = require(…)` and property assignments carry bindings no
    // `const|let|var` read collects; both used to mark the statement line
    // alone and drop every usage line.
    const importEquals = [
      "import moved = require('./changed.js');", // 1
      'moved();', // 2
      'const unrelated = 1;', // 3
    ].join('\n');
    expect(seamLines('src/imp.ts', importEquals, changed)).toEqual([1, 2, 3]);

    const propertyAssign = [
      "this.api = require('./changed.js');", // 1
      'api.call();', // 2
    ].join('\n');
    expect(seamLines('src/imp.ts', propertyAssign, changed)).toEqual([1, 2]);
  });

  it('a destructuring the line-shape read cannot collect fails closed (#10136)', () => {
    // Nested, array, and rest shapes each escape the enumerative brace
    // read; rather than shed their usage lines they fail closed.
    const nested = [
      "const { utils: { format } } = require('./changed.js');", // 1
      'format(x);', // 2
    ].join('\n');
    expect(seamLines('src/imp.ts', nested, changed)).toEqual([1, 2]);

    const arrayShape = [
      "const [moved] = require('./changed.js');", // 1
      'moved();', // 2
    ].join('\n');
    expect(seamLines('src/imp.ts', arrayShape, changed)).toEqual([1, 2]);

    const restShape = [
      "const { moved, ...rest } = require('./changed.js');", // 1
      'rest.moved();', // 2
      'const unrelated = 1;', // 3
    ].join('\n');
    expect(seamLines('src/imp.ts', restShape, changed)).toEqual([1, 2, 3]);
  });

  it('a destructuring default binds the imported name, not the default (#10136)', () => {
    const source = [
      "const { moved = fallback } = require('./changed.js');", // 1
      'moved();', // 2
    ].join('\n');
    expect(seamLines('src/imp.ts', source, changed)).toEqual([1, 2]);
  });

  it('a brace entry that parses to no identifier fails closed (#10136)', () => {
    // A clause entry the word read cannot prove a binding used to skip
    // silently — an unenumerated escape; the clause read fails CLOSED
    // instead.
    const source = [
      "import { moved = 1 } from './changed.js';", // 1
      'moved();', // 2
    ].join('\n');
    expect(seamLines('src/imp.ts', source, changed)).toEqual([1, 2]);
  });

  it('a keyword-bound clause over the 2000-char cap fails closed (#10136)', () => {
    // A 300-name barrel re-export: keyword-to-`from` distance beyond the
    // cap the clause read budgets. The capped read used to mark the
    // statement line alone and drop every usage line; the bound fails
    // CLOSED instead.
    const names = Array.from({ length: 300 }, (_, i) => `name${i}`);
    const source = [
      `export { ${names.join(', ')} } from './changed.js';`, // 1
      'name0();', // 2
      'const unrelated = 1;', // 3
    ].join('\n');
    expect(seamLines('src/imp.ts', source, changed)).toEqual([1, 2, 3]);
  });

  it('comment-like markers inside strings do not blank the seam (#10136)', () => {
    // `//` inside a string literal used to blank to the end of the line —
    // erasing a real require on it — and a `/*` in one string beside a
    // `*/` in a later one blanked every line between. The strip is
    // string-aware: comment bytes blank, string contents stay.
    const url = [
      "const u = 'https://x'; const { moved } = require('./changed.js');", // 1
      'moved();', // 2
    ].join('\n');
    expect(seamLines('src/imp.ts', url, changed)).toEqual([1, 2]);

    const blockPair = [
      "const a = '/*';", // 1
      "const { moved } = require('./changed.js');", // 2
      "const b = '*/';", // 3
      'moved();', // 4
    ].join('\n');
    expect(seamLines('src/imp.ts', blockPair, changed)).toEqual([2, 4]);
  });

  it('marks nothing for a file whose imports all resolve elsewhere', () => {
    const source = ["import { a } from './stable.js';", 'a();'].join('\n');
    expect(seamLines('src/imp.ts', source, changed)).toEqual([]);
  });
});
