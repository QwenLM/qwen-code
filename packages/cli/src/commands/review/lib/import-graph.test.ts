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

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, it, expect } from 'vitest';
import {
  scanImportSpecifiers,
  resolveSpecifier,
  dependentsOfChanged,
  discoverWorkspacePackages,
  defaultTypeScriptBases,
  loadTypeScript,
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

  it('marks every line a multi-line statement spans', () => {
    const source = [
      'import {', // 1
      '  moved, // a comment inside the clause', // 2
      "} from './changed.js';", // 3
      'moved();', // 4
      'const x = 1;', // 5
    ].join('\n');
    expect(seamLines('src/imp.ts', source, changed)).toEqual([1, 2, 3, 4]);
  });

  it('a binding USE marks every line its statement spans — the multi-line call (#10136 R18-1)', () => {
    // The fixture from the finding: the import sits on line 1, the call
    // on line 3, and the call's arguments span lines 4-9. A single-line
    // mark over `moved` leaves [6,12]-shaped hunks inside the call
    // shed while the census certifies `kept: 0` — the use must mark the
    // whole statement, argument lines included.
    const source = [
      "import { moved } from './changed.js';", // 1
      'const head = 1;', // 2
      'moved(', // 3
      '  alpha,', // 4
      '  beta,', // 5
      '  {', // 6
      '    gamma: 1,', // 7
      '    delta: 2,', // 8
      '    zeta: 6,', // 9
      '  },', // 10
      ');', // 11
      'const tail = 2;', // 12
    ].join('\n');
    const got = seamLines('src/imp.ts', source, changed);
    expect(got).toEqual([1, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    // …and reverting to the identifier's own line reds exactly here: the
    // inner argument lines 6-10 must be in the set, not just the callee's.
    for (const line of [6, 7, 8, 9, 10]) {
      expect(got).toContain(line);
    }
  });

  it('binds a require destructuring, on one line or across lines', () => {
    const one = [
      "const { moved, other: alias } = require('./changed.js');", // 1
      'alias(moved);', // 2
      'const x = 1;', // 3
    ].join('\n');
    expect(seamLines('src/imp.ts', one, changed)).toEqual([1, 2]);
    const spread = [
      'const {', // 1
      '  moved,', // 2
      "} = require('./changed.js');", // 3
      'moved();', // 4
    ].join('\n');
    expect(seamLines('src/imp.ts', spread, changed)).toEqual([1, 2, 3, 4]);
  });

  it('bounds $-carrying identifiers by the grammar, in both directions', () => {
    const source = [
      "import { store$, $init } from './changed.js';", // 1
      'store$.x = 1;', // 2
      'const other = 1;', // 3
      '$init();', // 4
      'const not$init = 1;', // 5
      'const $initial = 2;', // 6
    ].join('\n');
    expect(seamLines('src/imp.ts', source, changed)).toEqual([1, 2, 4]);
  });

  it('a keyword inside a comment or a string is not a keyword (#10136)', () => {
    const source = [
      'import {', // 1
      '  moved, // export me', // 2
      "} from './changed.js'; // import { x } from './changed.js'", // 3
      'const s = \'import { y } from "./changed.js"\';', // 4
      'moved();', // 5
    ].join('\n');
    expect(seamLines('src/imp.ts', source, changed)).toEqual([1, 2, 3, 5]);
  });

  it('a specifier inside a string is one reader short of a census — doubt (#10136 R18-1)', () => {
    // The parser correctly reads the string as a string — but the
    // entrance regex (`scanImportSpecifiers`) does not, and a file
    // ENTERS interaction on that regex: a confident `[]` here sheds the
    // file on an edge the census never saw. The cross-check exists for
    // exactly this disagreement: any specifier the regex can see
    // resolving into `changed` that the parser walk never resolved is
    // the doubt state, not "no seam".
    const source = [
      'export const note = "} from \'./changed.js\'";', // 1
      'let unrelated = 1;', // 2
    ].join('\n');
    expect(seamLines('src/imp.ts', source, changed)).toBeNull();
    // …and the control: a string naming a file OUTSIDE the change set
    // carries no edge either reader can see — no seam, no doubt.
    const elsewhere = [
      'export const note = "} from \'./elsewhere.js\'";', // 1
      'let unrelated = 1;', // 2
    ].join('\n');
    expect(seamLines('src/imp.ts', elsewhere, changed)).toEqual([]);
  });

  it('a dynamic import received by a declaration binds its names', () => {
    const awaited = [
      "const api = await import('./changed.js');", // 1
      'api.call();', // 2
      'const x = 1;', // 3
    ].join('\n');
    expect(seamLines('src/imp.ts', awaited, changed)).toEqual([1, 2]);
    const chained = [
      "const mod = (await import('./changed.js'))!.value as Mod;", // 1
      'mod.run();', // 2
      'let y = 1;', // 3
    ].join('\n');
    expect(seamLines('src/imp.ts', chained, changed)).toEqual([1, 2]);
    const destructured = [
      "const { moved } = (await import('./changed.js')) ?? fallback;", // 1
      'moved();', // 2
    ].join('\n');
    expect(seamLines('src/imp.ts', destructured, changed)).toEqual([1, 2]);
    // A branch of a conditional still lands in the declaration.
    const branch = [
      "const v = cond ? 1 : require('./changed.js').moved;", // 1
      'let x = v;', // 2
      'let y = 1;', // 3
    ].join('\n');
    expect(seamLines('src/imp.ts', branch, changed)).toEqual([1, 2]);
  });

  it('a require or dynamic import whose value escapes into an expression fails closed (#10136)', () => {
    for (const source of [
      "foo(require('./changed.js'));\nlet x = 1;",
      "export = require('./changed.js');\nlet x = 1;",
      // The un-awaited promise hands the module to a callback defined
      // anywhere — `handler`'s body is where the uses live.
      "import('./changed.js').then(handler);\nlet x = 1;",
      "import('./changed.js').then((m) => m.call());\nlet x = 1;",
      "const p = import('./changed.js').catch(log);\nlet x = 1;",
      // An argument on the way to a declaration is still an escape: the
      // value passed through `wrap` before anything received it.
      "const mod = wrap(await import('./changed.js')).value;\nlet x = 1;",
      "function f() { return require('./changed.js'); }\nlet x = 1;",
      "const list = [require('./changed.js')];\nlet x = 1;",
      "const o = { m: require('./changed.js') };\nlet x = 1;",
      "for (const m of require('./changed.js')) {}\nlet x = 1;",
      "obj['m'] = require('./changed.js');\nlet x = 1;",
      // A still-wrapped promise STORED by a binding (#10136 R9-1 round
      // 16): the callback body that eventually uses the module is
      // written anywhere — a use the name read cannot account for, at
      // each binding terminal shape.
      "const p = import('./changed.js');\np.then(handler);",
      "let p;\np = import('./changed.js');\np.then(handler);",
      "class A {\n  p = import('./changed.js');\n  run() {\n    this.p.then((m) => {\n      m.call();\n    });\n  }\n}",
      // …and the assignment inside an awaited expression binds the
      // promise for `n`, not the module: awaiting AROUND the assignment
      // does not unwrap what the assignment stored.
      "const m = await (n = import('./changed.js'));\nlet x = 1;",
    ]) {
      expect(seamLines('src/imp.ts', source, changed)).toBeNull();
    }
    // The non-binding terminals stay as they are: a promise that binds
    // nothing still just marks its own statement.
    expect(
      seamLines('src/imp.ts', "void import('./changed.js');", changed),
    ).toEqual([1]);
  });

  it('a statement that receives nothing marks its own lines and binds nothing', () => {
    for (const first of [
      "import './changed.js';",
      "require('./changed.js');",
      "await import('./changed.js');",
      "void import('./changed.js');",
      "require('./changed.js').init();",
      "(await import('./changed.js')).init();",
    ]) {
      expect(
        seamLines('src/imp.ts', `${first}\nconst moved = 1;`, changed),
      ).toEqual([1]);
    }
  });

  it('every receiver along an assignment chain binds (#10136 R9-1 round 17)', () => {
    const cases: Array<[string[], number[]]> = [
      [
        [
          'let cache;', // 1
          "const m = cache ?? (cache = require('./changed.js'));", // 2
          'm.run();', // 3
          'cache.run();', // 4
          'let x = 1;', // 5
        ],
        [1, 2, 3, 4],
      ],
      [
        [
          'let a, b;', // 1
          "a = b = require('./changed.js');", // 2
          'a.run();', // 3
          'b.run();', // 4
          'let x = 1;', // 5
        ],
        [1, 2, 3, 4],
      ],
      [
        [
          'let n;', // 1
          "const m = cond ? (n = require('./changed.js')) : null;", // 2
          'm.run(); n.run();', // 3
          'let x = 1;', // 4
        ],
        [1, 2, 3],
      ],
      [
        [
          "exports.moved = require('./changed.js');", // 1
          'exports.moved.run();', // 2
          'let x = 1;', // 3
        ],
        [1, 2],
      ],
      [
        [
          'class A {', // 1
          "  moved = require('./changed.js');", // 2
          '  run() {', // 3
          '    this.moved.go();', // 4
          '  }', // 5
          '}', // 6
        ],
        [2, 4],
      ],
      [
        [
          'let moved;', // 1
          "moved ??= require('./changed.js');", // 2
          'moved.run();', // 3
          'let x = 1;', // 4
        ],
        [1, 2, 3],
      ],
      [
        [
          "const { moved = require('./changed.js') } = opts;", // 1
          'moved.run();', // 2
          'let x = 1;', // 3
        ],
        [1, 2],
      ],
    ];
    for (const [lines, expected] of cases) {
      expect(seamLines('src/imp.ts', lines.join('\n'), changed)).toEqual(
        expected,
      );
    }
  });

  it("a JavaScript caller's JSDoc is walked — its types live there (#10136 R9-1 round 17)", () => {
    const typed = [
      "/** @type {import('./changed.js').Foo} */", // 1 — the tag, not `let v`
      'let v;', // 2
      "/** @typedef {import('./changed.js').Bar} Local */", // 3
      '/** @param {Local} p */', // 4 — the alias USE (#10136 R17-3)
      'function f(p) {}', // 5
      'let x = 1;', // 6
    ].join('\n');
    // Line 4 too: the typedef binds a local ALIAS of the imported type,
    // so a file that types everything through the alias no longer marks
    // nothing past the typedef line.
    expect(seamLines('src/imp.js', typed, changed)).toEqual([1, 3, 4]);
    const imported = [
      "/** @import { Foo } from './changed.js' */", // 1
      '', // 2
      '/** @type {Foo} */', // 3
      'export let v;', // 4
      'let x = 1;', // 5
    ].join('\n');
    expect(seamLines('src/imp.js', imported, changed)).toEqual([1, 3]);
    const used = [
      "const changed = require('./changed.js');", // 1
      '/** @type {changed.Foo} */', // 2
      'let v;', // 3
      '/** @param {typeof changed} c */', // 4
      'function g(c) {}', // 5
    ].join('\n');
    expect(seamLines('src/imp.js', used, changed)).toEqual([1, 2, 4]);
  });

  it('JSDoc carried by an import or export statement is walked too (round 3)', () => {
    const jsChanged = new Set(['src/changed.js']);
    const aboveImport = [
      "/** @import { Foo } from './changed.js' */", // 1
      "import { bar } from './bar.js';", // 2
      '', // 3
      '/** @param {Foo} f */', // 4
      'export function use(f) {}', // 5
    ].join('\n');
    expect(seamLines('src/imp.js', aboveImport, jsChanged)).toEqual([1, 4]);
    const aboveReexport = [
      "/** @typedef {import('./changed.js').Options} Options */", // 1
      "export * from './other.js';", // 2
    ].join('\n');
    expect(seamLines('src/imp.js', aboveReexport, jsChanged)).toEqual([1]);
    const aboveLocalExport = [
      'const x = 1;', // 1
      "/** @typedef {import('./changed.js').T} T */", // 2
      'export { x };', // 3
    ].join('\n');
    expect(seamLines('src/imp.js', aboveLocalExport, jsChanged)).toEqual([2]);
    const aboveResolving = [
      "/** @import { Foo } from './changed.js' */", // 1
      "import { bar } from './changed.js';", // 2
      '/** @type {Foo} */', // 3
      'let v = bar;', // 4
    ].join('\n');
    expect(seamLines('src/imp.js', aboveResolving, jsChanged)).toEqual([
      1, 2, 3, 4,
    ]);
    // A parser too old to read `@import` (TS < 5.5) hands the tag over
    // unread: doubt, not "no match".
    const older = new Proxy(ts, {
      get: (target, prop) =>
        prop === 'isJSDocImportTag'
          ? undefined
          : (target as unknown as Record<string | symbol, unknown>)[prop],
    }) as unknown as typeof ts;
    expect(
      seamLines('src/imp.js', aboveImport, jsChanged, [], older),
    ).toBeNull();
  });

  it('a private field receives a require, and its uses are read by name (round 3)', () => {
    const source = [
      'class C {', // 1
      '  #m;', // 2
      '  constructor() {', // 3
      "    this.#m = require('./changed.js');", // 4
      '  }', // 5
      '  run() {', // 6
      '    this.#m.run();', // 7
      '    return this.#m;', // 8
      '  }', // 9
      '  static is(o) {', // 10
      '    return #m in o;', // 11
      '  }', // 12
      '}', // 13
    ].join('\n');
    expect(
      seamLines('src/imp.js', source, new Set(['src/changed.js'])),
    ).toEqual([2, 4, 7, 8, 11]);
    const field = [
      'class D {', // 1
      "  #moved = require('./changed.js');", // 2
      '  go() {', // 3
      '    this.#moved.go();', // 4
      '  }', // 5
      '}', // 6
    ].join('\n');
    expect(seamLines('src/imp.ts', field, changed)).toEqual([2, 4]);
  });

  it('an object or array assignment pattern receives a require element by element (round 3)', () => {
    const source = [
      'let moved, other, rest, first;', // 1
      "({ moved, other: other, ...rest } = require('./changed.js'));", // 2
      "[first = 1, , ...rest] = require('./changed.js');", // 3
      'moved(); other(); rest.x; first;', // 4
      'let x = 1;', // 5
    ].join('\n');
    expect(seamLines('src/imp.ts', source, changed)).toEqual([1, 2, 3, 4]);
    const awaited = [
      'let moved;', // 1
      "({ moved } = await import('./changed.js'));", // 2
      'moved();', // 3
      'export {};', // 4
    ].join('\n');
    expect(seamLines('src/imp.ts', awaited, changed)).toEqual([1, 2, 3]);
    // A target the name read cannot follow: doubt.
    expect(
      seamLines(
        'src/imp.ts',
        "({ moved: obj['k'] } = require('./changed.js'));\nlet x = 1;",
        changed,
      ),
    ).toBeNull();
  });

  it('a template or parenthesised specifier is a literal, a computed one is doubt', () => {
    for (const source of [
      'const { moved } = require(`./changed.js`);\nmoved();\nlet x = 1;',
      "const { moved } = require(('./changed.js'));\nmoved();\nlet x = 1;",
      'const { moved } = await import(`./changed.js`);\nmoved();\nlet x = 1;',
    ]) {
      expect(seamLines('src/imp.ts', source, changed)).toEqual([1, 2]);
    }
    expect(
      seamLines(
        'src/imp.ts',
        'let x: import(`./changed.js`).Foo;\nlet y = 1;',
        changed,
      ),
    ).toEqual([1]);
    // A type import nested inside another's type arguments is reached.
    expect(
      seamLines(
        'src/imp.ts',
        "let x: import('./stable.js').Foo<import('./changed.js').Bar>;\nlet y = 1;",
        changed,
      ),
    ).toEqual([1]);
  });

  it("a type position's import('…') marks its member, not the class around it", () => {
    const source = [
      'class Big {', // 1
      '  a() {}', // 2
      "  b(): import('./changed.js').Foo {", // 3
      '    return make();', // 4
      '  }', // 5
      '  c() {}', // 6
      '}', // 7
      'interface I {', // 8
      "  d: import('./changed.js').Bar;", // 9
      '  e: number;', // 10
      '}', // 11
    ].join('\n');
    expect(seamLines('src/imp.ts', source, changed)).toEqual([3, 4, 5, 9]);
  });

  it('a parser build missing an entry point makes the read doubt, never throw (#10136)', () => {
    // A `satisfies` on the receiver path: the full parser passes through
    // it and binds `m`; a build without `isSatisfiesExpression` (TS 4.8
    // and older) cannot follow the path and doubts — never throws.
    const source = [
      "const m = require('./changed.js') satisfies X;", // 1
      'm.run();', // 2
      'let y = 1;', // 3
    ].join('\n');
    expect(seamLines('src/imp.ts', source, changed)).toEqual([1, 2]);
    const older = new Proxy(ts, {
      get: (target, prop) =>
        prop === 'isSatisfiesExpression'
          ? undefined
          : (target as unknown as Record<string | symbol, unknown>)[prop],
    }) as unknown as typeof ts;
    expect(seamLines('src/imp.ts', source, changed, [], older)).toBeNull();
    // A build whose walk throws mid-way: the doubt state, not a crash.
    const throwing = new Proxy(ts, {
      get: (target, prop) =>
        prop === 'isCallExpression'
          ? () => {
              throw new Error('boom');
            }
          : (target as unknown as Record<string | symbol, unknown>)[prop],
    }) as unknown as typeof ts;
    expect(
      seamLines('src/imp.ts', 'let x = 1;\nlet y = 2;', changed, [], throwing),
    ).toBeNull();
  });

  it('an assignment to an identifier receives a require', () => {
    const source = [
      'let moved;', // 1
      "moved = require('./changed.js');", // 2
      'moved.run();', // 3
      'let x = 1;', // 4
    ].join('\n');
    expect(seamLines('src/imp.ts', source, changed)).toEqual([1, 2, 3]);
  });

  it('a computed specifier is a read the oracle cannot prove', () => {
    for (const source of [
      'const m = require(name);\nlet x = 1;',
      'const m = await import(`./${name}.js`);\nlet x = 1;',
    ]) {
      expect(seamLines('src/imp.ts', source, changed)).toBeNull();
    }
  });

  it('require by an alias, a comma sequence, or the property form is still require (#10136 R18-1)', () => {
    // Each of these returned a confident `[]` where the plain-`require`
    // control correctly marked — the class the round-18 probe filed.
    const control = seamLines(
      'src/imp.ts',
      "const m = require('./changed.js');\nm.run();",
      changed,
    );
    expect(control).toEqual([1, 2]);
    // A `createRequire` factory's product.
    expect(
      seamLines(
        'src/imp.js',
        [
          'const req = createRequire(import.meta.url);', // 1
          "const m = req('./changed.js');", // 2
          'm.run();', // 3
        ].join('\n'),
        changed,
      ),
    ).toEqual([2, 3]);
    // The `(0, require)(…)` comma sequence.
    expect(
      seamLines(
        'src/imp.js',
        "const m = (0, require)('./changed.js');\nm.run();",
        changed,
      ),
    ).toEqual([1, 2]);
    // The property form — `module.require(…)` is the same function.
    expect(
      seamLines(
        'src/imp.js',
        "const m = module.require('./changed.js');\nm.run();",
        changed,
      ),
    ).toEqual([1, 2]);
    // An alias call with a COMPUTED specifier is the same doubt the
    // plain form's computed specifier is.
    expect(
      seamLines(
        'src/imp.js',
        'const req = createRequire(import.meta.url);\nconst m = req(name);',
        changed,
      ),
    ).toBeNull();
    // …and a factory whose own introduction escapes the receiver walk.
    expect(
      seamLines(
        'src/imp.js',
        "register(createRequire(import.meta.url));\nconst m = req('./changed.js');",
        changed,
      ),
    ).toBeNull();
  });

  it('a property-named binding reads back through its bracket spelling (#10136 R18-1)', () => {
    // `exports.moved = require(…)` establishes the binding by property
    // name; `exports['moved']` is the same property read back through
    // the legal bracket spelling — the establishing side of that exact
    // spelling is already a doubt state (`obj['m'] = require(…)`), so
    // the read-back side must not mark nothing.
    const source = [
      "exports.moved = require('./changed.js');", // 1
      "exports['moved'].run();", // 2
      'let x = 1;', // 3
    ].join('\n');
    expect(seamLines('src/imp.js', source, changed)).toEqual([1, 2]);
    // …and a bracket read of a name the seam did NOT bind stays silent.
    const unbound = [
      "exports.moved = require('./changed.js');", // 1
      "exports['other'].run();", // 2
    ].join('\n');
    expect(seamLines('src/imp.js', unbound, changed)).toEqual([1]);
  });

  it('a JSDoc type spelling the parser erases is a doubt, not a confident miss (#10136 R18-1, R17-2)', () => {
    // Each of these TypeScript's JSDoc parser erases into a childless
    // node — the specifier never becomes an `ImportType`, no diagnostic
    // fires, and the read used to return `[]` while every sibling
    // spelling correctly marked. Doubt over the tag's own raw text.
    for (const tag of [
      "@callback {import('./changed.js').Foo} MyFn",
      "@overload {import('./changed.js').Foo}",
      "@func {import('./changed.js').Foo}",
      "@function {import('./changed.js').Foo}",
      "@see {@link import('./changed.js')}",
      // The legal JSDoc `require('…')` type spelling (R17-2) — erased
      // where `@type {import('…')}` is read.
      "@type {require('./changed.js')}",
    ]) {
      const source = [`/** ${tag} */`, 'let v = 1;'].join('\n');
      expect(seamLines('src/imp.js', source, changed)).toBeNull();
    }
    // …and the control rows the table already reads correctly: readable
    // spellings mark, an erased spelling naming a file OUTSIDE the
    // change set is no seam and no doubt.
    expect(
      seamLines(
        'src/imp.js',
        ["/** @type {import('./changed.js').Foo} */", 'let v = 1;'].join('\n'),
        changed,
      ),
    ).toEqual([1]);
    expect(
      seamLines(
        'src/imp.js',
        ["/** @see {@link import('./elsewhere.js')} */", 'let v = 1;'].join(
          '\n',
        ),
        changed,
      ),
    ).toEqual([]);
  });

  it('a syntax error is a tree the oracle cannot certify', () => {
    // The error sits BEFORE a real seam the recovered tree would still
    // read correctly: trusting the tree would certify `[2, 3]`, and the
    // doubt is what covers line 1 too.
    const source = [
      'let a = ;', // 1
      "const { moved } = require('./changed.js');", // 2
      'moved();', // 3
    ].join('\n');
    expect(seamLines('src/imp.ts', source, changed)).toBeNull();
  });

  it('with no parser resolvable every read is the doubt state', () => {
    const source = ["import { moved } from './changed.js';", 'moved();'].join(
      '\n',
    );
    expect(seamLines('src/imp.ts', source, changed, [], null)).toBeNull();
    expect(seamLines('src/imp.ts', 'let x = 1;', changed, [], null)).toBeNull();
  });

  it('comment-like markers inside strings, templates and regexes do not blank the seam (#10136)', () => {
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
    const regex = [
      "const URL_RE = /https?:\\/\\//; const { moved } = require('./changed.js');", // 1
      'moved();', // 2
    ].join('\n');
    expect(seamLines('src/imp.ts', regex, changed)).toEqual([1, 2]);
    const nested = [
      'const a = `${`/*`}`;', // 1
      "const { moved } = require('./changed.js');", // 2
      'const b = `*/`;', // 3
      'moved();', // 4
    ].join('\n');
    expect(seamLines('src/imp.ts', nested, changed)).toEqual([2, 4]);
  });

  // The lexical shapes six review rounds of a hand-rolled lexer guessed
  // wrong (#10136 R9-1). Each reads exactly what the grammar says.
  it('regex-versus-division shapes read as the grammar reads them (R9-1)', () => {
    const source = [
      "import { moved } from './changed.js';", // 1
      "const per = count! / lines; const sep = '/'; const glob = '**/*.ts';", // 2
      'moved(per);', // 3
      "const half = opts.in / 2; const a = 'x/y'; const b = 'p/*q';", // 4
      'const c = arr.with(0, 1) / 2; const d = (y as Array<number>) / 2;', // 5
      'function f(): void {', // 6
      '}', // 7
      '/[//]/.test(s); moved();', // 8
      'switch (s) {', // 9
      '  case 1: {', // 10
      '  }', // 11
      '  /[/*]/.test(line);', // 12
      '}', // 13
      'const q = a / /[/*]/.test(x); moved(q);', // 14
      'export default /re/;', // 15
      'let z = moved;', // 16
    ].join('\n');
    expect(seamLines('src/imp.ts', source, changed)).toEqual([1, 3, 8, 14, 16]);
  });

  it('every line terminator and continuation reads as the grammar reads it (R9-1)', () => {
    // LF alone counts as a line: a CR/LS/PS after `//` ends the comment
    // but not the line; a CRLF does both.
    for (const [terminator, expected] of [
      ['\r', [1, 2]],
      [' ', [1, 2]],
      [' ', [1, 2]],
      ['\r\n', [2, 3]],
    ] as const) {
      const source =
        `// c${terminator}const { moved } = require('./changed.js');\n` +
        'moved();';
      expect(seamLines('src/imp.ts', source, changed)).toEqual([...expected]);
    }
    // A backslash-CRLF continuation stays inside its string, and a raw
    // LS inside a string is a string character (ES2019).
    const continued =
      "const s = 'a\\\r\n/*';\n" + // 1-2
      "const { moved } = require('./changed.js');\n" + // 3
      "const t = '*/';\n" + // 4
      'moved(x);'; // 5
    expect(seamLines('src/imp.ts', continued, changed)).toEqual([3, 5]);
    const ls = [
      "const s = 'a /*';", // 1
      "const { moved } = require('./changed.js');", // 2
      "const t = '*/';", // 3
      'moved(x);', // 4
    ].join('\n');
    expect(seamLines('src/imp.ts', ls, changed)).toEqual([2, 4]);
  });

  it('every clause shape binds what the grammar binds (R9-1)', () => {
    const source = [
      "import { moved as type, other as default_, type Kind as K, export as ex } from './changed.js';", // 1
      'type();', // 2
      'default_();', // 3
      'let k: K;', // 4
      'ex();', // 5
      'moved(); other();', // 6 — the IMPORTED names are not bindings here
    ].join('\n');
    expect(seamLines('src/imp.ts', source, changed)).toEqual([1, 2, 3, 4, 5]);
    expect(
      seamLines(
        'src/imp.ts',
        "import { type } from './changed.js';\ntype();\nlet x = 1;",
        changed,
      ),
    ).toEqual([1, 2]);
    expect(
      seamLines(
        'src/imp.ts',
        "import type from './changed.js';\ntype();\nlet x = 1;",
        changed,
      ),
    ).toEqual([1, 2]);
    expect(
      seamLines(
        'src/imp.ts',
        "import type, { moved } from './changed.js';\ntype();\nmoved();\nlet x = 1;",
        changed,
      ),
    ).toEqual([1, 2, 3]);
    expect(
      seamLines(
        'src/imp.ts',
        "import type { Moved } from './changed.js';\nlet x: Moved;\ntype Other = 1;",
        changed,
      ),
    ).toEqual([1, 2]);
    expect(
      seamLines(
        'src/imp.ts',
        "import moved = require('./changed.js');\nmoved();\nlet x = 1;",
        changed,
      ),
    ).toEqual([1, 2]);
    expect(
      seamLines(
        'src/imp.ts',
        "export { moved as default } from './changed.js';\nconst moved = 1;",
        changed,
      ),
    ).toEqual([1]);
    expect(
      seamLines(
        'src/imp.ts',
        "export * as ns from './changed.js';\nconst ns = 1;",
        changed,
      ),
    ).toEqual([1]);
  });

  it("a type position's import('…') is a seam, used inline", () => {
    const source = [
      "let x: import('./changed.js').Foo;", // 1
      'type T = {', // 2
      "  moved: typeof import('./changed.js');", // 3 — the member, not the type
      '};', // 4
      "let y: import('./stable.js').Bar;", // 5
    ].join('\n');
    expect(seamLines('src/imp.ts', source, changed)).toEqual([1, 3]);
  });

  it('non-ASCII identifiers are identifiers (R9-1)', () => {
    expect(
      seamLines(
        'src/imp.ts',
        "import 数 from './changed.js';\n数();\nlet x = 1;",
        changed,
      ),
    ).toEqual([1, 2]);
    expect(
      seamLines(
        'src/imp.ts',
        "const 数import = 1; export { moved } from './changed.js';\nlet x = 数import;",
        changed,
      ),
    ).toEqual([1]);
    expect(
      seamLines(
        'src/imp.ts',
        "import { moved } from './changed.js';\nconst 变量 = { 键: moved };\nlet x = 1;",
        changed,
      ),
    ).toEqual([1, 2]);
  });

  it('JSX is a language the parser reads — a seam inside markup is a seam', () => {
    const source = [
      "import { Moved } from './changed.js';", // 1
      'export const el = (', // 2
      '  <p>// not a comment {"/*"}', // 3
      '    <Moved />', // 4
      '  </p>', // 5
      ');', // 6
      'let x = 1;', // 7
    ].join('\n');
    // The use marks its whole statement (#10136 R18-1): the declaration
    // spans lines 2-6, and a hunk carrying any of those lines is one the
    // seam must keep — a single-line mark at 4 sheds the closing tags a
    // fix commit edits beside the element.
    expect(seamLines('src/imp.tsx', source, changed)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });

  it('a shebang line is a comment', () => {
    const source = [
      "#!/usr/bin/env node // import { x } from './changed.js'", // 1
      "const moved = require('./changed.js');", // 2
      'moved.run();', // 3
    ].join('\n');
    expect(seamLines('src/imp.js', source, changed)).toEqual([2, 3]);
  });

  it('a default import binds its name', () => {
    const source = [
      "import moved, { other } from './changed.js';", // 1
      'moved();', // 2
      'other();', // 3
      'const x = 1;', // 4
    ].join('\n');
    expect(seamLines('src/imp.ts', source, changed)).toEqual([1, 2, 3]);
  });

  it('resolves a workspace-package specifier through the packages argument', () => {
    const packages = [{ name: '@w/pkg', dir: 'packages/pkg' }];
    const pkgChanged = new Set(['packages/pkg/src/changed.ts']);
    const source = [
      "import { moved } from '@w/pkg/src/changed.js';", // 1
      'moved();', // 2
      'const x = 1;', // 3
    ].join('\n');
    expect(seamLines('src/imp.ts', source, pkgChanged)).toEqual([]);
    expect(seamLines('src/imp.ts', source, pkgChanged, packages)).toEqual([
      1, 2,
    ]);
  });

  it('marks nothing for a file whose imports all resolve elsewhere', () => {
    const source = ["import { a } from './stable.js';", 'a();'].join('\n');
    expect(seamLines('src/imp.ts', source, changed)).toEqual([]);
  });
});

describe('the seam oracle and its parser (#10136)', () => {
  it('resolves TypeScript at run time, and it is the parser the tests run under', () => {
    const loaded = loadTypeScript();
    expect(loaded).not.toBeNull();
    expect(loaded?.version).toBe(ts.version);
  });

  it('looks in the working directory first, then in its own tree', () => {
    // A globally installed CLI has no `typescript` beside `dist/`; the
    // repository the review runs in is the one base that can serve it.
    const bases = defaultTypeScriptBases();
    expect(bases).toHaveLength(2);
    expect(bases[0]).toBe(join(process.cwd(), 'package.json'));
    expect(bases[1]).toMatch(/^file:.*import-graph\.(ts|js)$/);
  });

  it('refuses a resolvable but unusable parser and falls through to the next base', () => {
    // A `typescript` that resolves from the working directory but cannot
    // do the oracle's work — the entry points missing, or a probe parse
    // that throws or yields no diagnostics field — must be rejected at
    // load time, visibly, not accepted and left to doubt every file.
    const stub = (body: string): string => {
      const dir = mkdtempSync(join(tmpdir(), 'seam-ts-'));
      const pkg = join(dir, 'node_modules', 'typescript');
      mkdirSync(pkg, { recursive: true });
      writeFileSync(
        join(pkg, 'package.json'),
        JSON.stringify({
          name: 'typescript',
          version: '0.0.0-stub',
          main: 'index.js',
        }),
      );
      writeFileSync(join(pkg, 'index.js'), body);
      writeFileSync(join(dir, 'package.json'), '{}');
      return join(dir, 'package.json');
    };
    const real = fileURLToPath(import.meta.url);
    const partial = stub('module.exports = { version: "0.0.0-stub" };');
    const throwing = stub(
      'const ts = require(' +
        JSON.stringify(
          join(
            dirname(real),
            '..',
            '..',
            '..',
            '..',
            'node_modules',
            'typescript',
          ),
        ) +
        '); module.exports = { ...ts, version: "0.0.0-throws", createSourceFile() { throw new Error("boom"); } };',
    );
    const blind = stub(
      'const ts = require(' +
        JSON.stringify(
          join(
            dirname(real),
            '..',
            '..',
            '..',
            '..',
            'node_modules',
            'typescript',
          ),
        ) +
        '); module.exports = { ...ts, version: "0.0.0-blind", createSourceFile: (...a) => { const sf = ts.createSourceFile(...a); delete sf.parseDiagnostics; return sf; } };',
    );
    try {
      for (const bad of [partial, throwing, blind]) {
        expect(loadTypeScript([bad])).toBeNull();
        // …and the next base is used instead.
        expect(loadTypeScript([bad, real])?.version).toBe(ts.version);
      }
      expect(
        loadTypeScript([join(tmpdir(), 'nowhere', 'package.json')]),
      ).toBeNull();
    } finally {
      for (const p of [partial, throwing, blind]) {
        rmSync(dirname(p), { recursive: true, force: true });
      }
    }
  });

  // Every source file of the CLI package is read against the corpus itself
  // as the change set: every one of its relative imports that lands in the
  // corpus is a seam, and the parser's own count of those declarations —
  // computed here, independently — must be inside what `seamLines` marks.
  // The only doubts the corpus may carry are the ones the contract names;
  // each is checked against the source that caused it.
  it('reads every source file of the CLI package against the corpus, marking every resolvable import', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const root = join(here, '..', '..', '..');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
          files.push(full);
        }
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(1500);
    // The resolver the corpus feeds is posix-hardcoded (`repoJoin` →
    // nodePath.posix), so a win32-spelled relative path would resolve
    // nothing into the corpus; normalise the same way paths.ts:499-502 does.
    const rels = files.map((f) =>
      f
        .slice(root.length + 1)
        .split(sep)
        .join('/'),
    );
    const corpus = new Set(rels);
    const doubted: string[] = [];
    const unexplained: string[] = [];
    const missing: string[] = [];
    let importLines = 0;
    let markedLines = 0;
    // The doubt causes the contract names (#10136 R18-1): a computed
    // specifier or an escaping value at a `require(…)`/`import(…)` call,
    // an erased JSDoc subtree carrying one, and the one-reader
    // cross-check — a specifier the entrance regex sees resolving into
    // the corpus that the parser walk never resolved (a comment or
    // string mention). A doubt in a file carrying NONE of these is one
    // the contract does not name.
    const dynamicLoad = /\b(?:require|import)\s*\(|createRequire\s*\(/;
    for (const [i, file] of files.entries()) {
      const text = readFileSync(file, 'utf8');
      const rel = rels[i];
      const got = seamLines(rel, text, corpus);
      // The parser's own reading of which import/export-from declarations
      // land in the corpus — the lines the result must contain.
      const sf = ts.createSourceFile(
        rel,
        text,
        ts.ScriptTarget.Latest,
        true,
        rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const expected: number[] = [];
      const lfLine = (pos: number): number =>
        text.slice(0, pos).split('\n').length;
      ts.forEachChild(sf, (node) => {
        const spec = ts.isImportDeclaration(node)
          ? node.moduleSpecifier
          : ts.isExportDeclaration(node)
            ? node.moduleSpecifier
            : undefined;
        if (
          spec !== undefined &&
          ts.isStringLiteral(spec) &&
          resolveSpecifier(rel, spec.text, corpus) !== null
        ) {
          expected.push(lfLine(node.getStart(sf)));
        }
      });
      // …and every type-position `import('…')` anywhere in the tree.
      const typeImports = (node: ts.Node): void => {
        if (
          ts.isImportTypeNode(node) &&
          ts.isLiteralTypeNode(node.argument) &&
          ts.isStringLiteral(node.argument.literal) &&
          resolveSpecifier(rel, node.argument.literal.text, corpus) !== null
        ) {
          expected.push(lfLine(node.getStart(sf)));
        }
        ts.forEachChild(node, typeImports);
      };
      typeImports(sf);
      if (got === null) {
        doubted.push(rel);
        const regexSeesCorpus = scanImportSpecifiers(text).some(
          (s) => resolveSpecifier(rel, s, corpus) !== null,
        );
        if (!dynamicLoad.test(text) && !regexSeesCorpus) {
          unexplained.push(rel);
        }
        continue;
      }
      importLines += expected.length;
      markedLines += got.length;
      const marked = new Set(got);
      for (const line of expected) {
        if (!marked.has(line)) missing.push(`${rel}:${line}`);
      }
    }
    expect(missing).toEqual([]);
    expect(unexplained).toEqual([]);
    // The corpus imports itself thousands of times over, and every such
    // statement was marked together with the lines that use its bindings
    // — the census that a disabled resolver, span or mention scan cannot
    // produce.
    expect(importLines).toBeGreaterThan(2000);
    expect(markedLines).toBeGreaterThan(importLines * 3);
    // Disclosed, not capped: the corpus carries a handful of lazy
    // `import(variable)` loaders and escaping `import(…)` values (a
    // `Promise.all([import(…)])`), each republished in full on a fix-audit
    // round, and a change in that number is a fact to look at.
    expect(doubted.length).toBeLessThan(files.length / 100);
    expect(doubted.length).toBeGreaterThan(0);
  }, 180_000);
});
