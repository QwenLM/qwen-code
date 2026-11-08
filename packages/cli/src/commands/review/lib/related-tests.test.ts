/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  filesNaming,
  relatedTests,
  vitestRunConfig,
  wholeSuiteReason,
} from './related-tests.js';

/** `packages/<name>` owns what lies under it. */
const packageOf = (file: string): string | null =>
  /^packages\/[^/]+/.exec(file)?.[0] ?? null;

describe('vitestRunConfig', () => {
  it('reads a plain vitest run, and the config it names', () => {
    expect(vitestRunConfig('vitest run')).toBe('');
    expect(vitestRunConfig('vitest')).toBe('');
    expect(vitestRunConfig('  vitest   --run ')).toBe('');
    expect(vitestRunConfig('vitest run --config vitest.config.ts')).toBe(
      'vitest.config.ts',
    );
    expect(vitestRunConfig('vitest run --config=cfg/unit.mts')).toBe(
      'cfg/unit.mts',
    );
    expect(vitestRunConfig('vitest run --config ../shared/v.config.ts')).toBe(
      '../shared/v.config.ts',
    );
  });

  it('keeps every other script whole', () => {
    const scripts = [
      undefined,
      '',
      'jest',
      'vitest run --coverage',
      'vitest run src/a',
      'cross-env NODE_OPTIONS=--x vitest run',
      'vitest run && node check.js',
      'vitest run --config -x',
      'vitest run --config /tmp/x.mjs',
      'vitest run --config "a b.ts"',
      'tsx --test src/*.test.ts',
    ];
    expect(scripts.filter((s) => vitestRunConfig(s) !== undefined)).toEqual([]);
  });
});

describe('wholeSuiteReason', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'related-reason-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const touch = (...files: string[]): void => {
    for (const f of files) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      writeFileSync(join(root, f), '');
    }
  };
  const reasonOf = (files: string[], renamedFrom: string[] = []) =>
    wholeSuiteReason(root, files, renamedFrom, packageOf);

  it('leaves a diff of present files to the graph', () => {
    const files = [
      'packages/a/src/x.ts',
      'docs/guide.md',
      'packages/a/src/x.test.ts',
      // A test OF a setup is in the graph like any other test.
      'packages/a/src/globalSetup.test.ts',
      // Ordinary modules whose names hold a setup word.
      'packages/a/src/setupGithubCommand.ts',
      'packages/a/client/live/useLiveVoiceSetup.ts',
      'packages/a/src/commands/setup.ts',
      'packages/a/src/patches/is-in-ci.ts',
      // A manifest no workspace owns as its own: a fixture's, an example's.
      'packages/a/examples/mcp-server/package.json',
      'packages/a/src/ui/__snapshots__/Footer.test.tsx.snap',
    ];
    touch(...files);
    expect(files.map((f) => reasonOf([f]))).toEqual(files.map(() => undefined));
  });

  it('runs every suite whole for what reaches tests without an import', () => {
    const files = [
      'package.json',
      'packages/a/package.json',
      'pnpm-lock.yaml',
      'package-lock.json',
      'yarn.lock',
      'bun.lock',
      'bun.lockb',
      'pnpm-workspace.yaml',
      '.npmrc',
      '.yarnrc.yml',
      '.pnpmfile.cjs',
      'packages/a/tsconfig.build.json',
      'packages/a/vitest.config.ts',
      'packages/a/vite.lib.config.ts',
      'vitest.workspace.ts',
      'packages/a/test-setup.ts',
      'packages/a/client/test/setup.ts',
      'integration-tests/globalSetup.ts',
      'scripts/vitest-global-setup.js',
      'patches/dep@1.0.0.patch',
      'patches/ink+7.0.3.patch',
      'packages/a/src/__mocks__/dep.ts',
    ];
    touch(...files);
    expect(files.map((f) => reasonOf([f]))).toEqual(
      files.map((f) => `it changes ${f}`),
    );
  });

  it('owns a nested workspace by the deepest listed member', () => {
    const declared = ['packages/channels', 'packages/channels/dingtalk'];
    const deepest = (file: string): string | null =>
      declared
        .filter((d) => file === d || file.startsWith(`${d}/`))
        .sort((a, b) => b.length - a.length)[0] ?? null;
    touch('packages/channels/dingtalk/package.json');
    touch('packages/channels/other/package.json');
    expect(
      wholeSuiteReason(
        root,
        ['packages/channels/dingtalk/package.json'],
        [],
        deepest,
      ),
    ).toBe('it changes packages/channels/dingtalk/package.json');
    // A sibling's manifest belongs to the declared parent, not to its own
    // directory: the first-segment stub would call both of them the nesting
    // workspace's own.
    expect(
      wholeSuiteReason(
        root,
        ['packages/channels/other/package.json'],
        [],
        deepest,
      ),
    ).toBeUndefined();
  });

  it('runs every suite whole for a deletion, a rename, or a diff too wide', () => {
    expect(reasonOf(['packages/a/src/gone.ts'])).toBe(
      'it deletes packages/a/src/gone.ts',
    );
    touch('packages/a/src/new.ts');
    expect(reasonOf(['packages/a/src/new.ts'], ['packages/a/src/old.ts'])).toBe(
      'it renames packages/a/src/old.ts',
    );
    const many = Array.from({ length: 201 }, (_, i) => `f${i}.ts`);
    touch(...many);
    expect(reasonOf(many)).toBe('it changes 201 files');
  });
});

describe('filesNaming', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'related-names-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const write = (file: string, text: string): void => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };

  it('finds a script that names the file, and only as the whole name', () => {
    write('a/quoted.ts', "const f = 'guide.md';");
    write('a/path.test.ts', 'read(join(ROOT, "docs/guide.md"))');
    write('a/template.ts', 'x = `${dir}/guide.md`;');
    // As a regex spells it, too.
    write('a/escaped.ts', 'const RE = /^docs\\/guide\\.md$/;');
    write('a/anchored.ts', 'const RE = /^guide\\.md$/;');
    write('a/longer.ts', "'my-guide.md' + 'guide.mdx' + 'guide.md.bak'");
    write('a/longer-escaped.ts', 'const RE = /guide\\.mdx$/;');
    write('a/prose.md', 'guide.md');
    expect(filesNaming(root, ['guide.md'])?.get('guide.md')?.sort()).toEqual([
      'a/anchored.ts',
      'a/escaped.ts',
      'a/path.test.ts',
      'a/quoted.ts',
      'a/template.ts',
    ]);
  });

  it('reads neither dependencies, build output, dot-dirs, nor links out of the tree', () => {
    write('node_modules/x/i.js', "'guide.md'");
    write('pkg/dist/i.js', "'guide.md'");
    write('pkg/coverage/i.js', "'guide.md'");
    write('.qwen/tmp/other/i.ts', "'guide.md'");
    const outside = mkdtempSync(join(tmpdir(), 'related-outside-'));
    try {
      writeFileSync(join(outside, 'i.ts'), "'guide.md'");
      symlinkSync(outside, join(root, 'linked'));
      symlinkSync(join(outside, 'i.ts'), join(root, 'file-link.ts'));
      expect(filesNaming(root, ['guide.md'])?.get('guide.md')).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('gives up on more names than one scan of the tree should pay for', () => {
    write('a/x.ts', "'n0.md'");
    const names = Array.from({ length: 65 }, (_, i) => `n${i}.md`);
    expect(filesNaming(root, names)).toBeUndefined();
    expect(filesNaming(root, names.slice(0, 64))?.get('n0.md')).toEqual([
      'a/x.ts',
    ]);
  });
});

describe('relatedTests', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'related-select-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const write = (file: string, text = ''): void => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  const reach: Record<string, string[]> = {
    'packages/cli': ['packages/cli', 'packages/core'],
    'packages/core': ['packages/core'],
    'packages/web': ['packages/web'],
  };
  const select = (changed: string[], dir: string, renamedFrom: string[] = []) =>
    relatedTests({
      root,
      changed,
      renamedFrom,
      ownerOf: packageOf,
      reachOf: (d) => reach[d] ?? [d],
    }).select(dir);
  const manifest = (dir: string, body: object): void =>
    write(`${dir}/package.json`, JSON.stringify(body));

  beforeEach(() => {
    // The vitest `npm exec` runs: the root's.
    write('node_modules/vitest/vitest.mjs');
    mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
    symlinkSync('../vitest/vitest.mjs', join(root, 'node_modules/.bin/vitest'));
    for (const d of ['packages/cli', 'packages/core', 'packages/web']) {
      manifest(d, { scripts: { test: 'vitest run' } });
    }
    write('packages/core/src/a.ts');
    write('docs/guide.md');
    // What names the doc: a test in the suite, a module it can import, and
    // the same two in a workspace it cannot reach.
    write('packages/cli/src/docs.test.ts', "'guide.md'");
    write('packages/core/src/docs.test.ts', "'guide.md'");
    write('packages/core/src/loader.ts', "'guide.md'");
    write('packages/web/src/docs.test.ts', "'guide.md'");
    write('packages/web/src/loader.ts', "'guide.md'");
    write('scripts/lib/docs.ts', "'guide.md'");
  });

  it('hands a suite the changed files and what it can reach that names one', () => {
    expect(
      select(['packages/core/src/a.ts', 'docs/guide.md'], 'packages/cli'),
    ).toEqual({
      config: '',
      paths: [
        '../../docs/guide.md',
        '../../scripts/lib/docs.ts',
        '../core/src/a.ts',
        '../core/src/loader.ts',
        'src/docs.test.ts',
      ],
    });
    // A test runs only in its own suite: core's is cli's to import from,
    // but not to run; and core cannot reach cli, its consumer.
    write('packages/cli/src/names.ts', "'guide.md'");
    expect(
      select(['packages/core/src/a.ts', 'docs/guide.md'], 'packages/core')
        ?.paths,
    ).toEqual([
      '../../docs/guide.md',
      '../../scripts/lib/docs.ts',
      'src/a.ts',
      'src/docs.test.ts',
      'src/loader.ts',
    ]);
  });

  it('looks up a source module by name too: a test can assert its text', () => {
    // build-budget.test.ts reads agent-prompt.ts; it imports nothing of it.
    write(
      'packages/core/src/a-text.test.ts',
      "readFileSync(join(here, 'a.ts'))",
    );
    expect(select(['packages/core/src/a.ts'], 'packages/core')?.paths).toEqual([
      'src/a-text.test.ts',
      'src/a.ts',
    ]);
  });

  it('looks up a script outside src by name: a test may spawn it', () => {
    write('packages/cli/src/spawn.test.ts', "exec('scripts/lib/docs.ts')");
    expect(select(['scripts/lib/docs.ts'], 'packages/cli')?.paths).toEqual([
      '../../scripts/lib/docs.ts',
      'src/spawn.test.ts',
    ]);
  });

  it("runs a snapshot's test, which vitest binds to it by name", () => {
    write('packages/core/src/ui/Footer.test.tsx');
    write('packages/core/src/ui/__snapshots__/Footer.test.tsx.snap');
    expect(
      select(
        ['packages/core/src/ui/__snapshots__/Footer.test.tsx.snap'],
        'packages/core',
      )?.paths,
    ).toEqual([
      'src/ui/Footer.test.tsx',
      'src/ui/__snapshots__/Footer.test.tsx.snap',
    ]);
  });

  it('runs the suite whole when the config declares projects inline', () => {
    // vitest >= 3.2 replaced the workspace FILE with this key; a suite that
    // collects other workspaces' tests cannot be handed this suite's seeds.
    write(
      'packages/core/vitest.config.ts',
      "export default defineConfig({ test: { projects: ['../other'] } })",
    );
    expect(select(['packages/core/src/a.ts'], 'packages/core')).toBeUndefined();
  });

  it('reads a quoted root or projects key the way vitest does', () => {
    // `'root': 'client'` is the same key as `root:`; missing it narrows the
    // suite and vitest then resolves every path under client/ twice.
    write(
      'packages/core/vitest.config.ts',
      "export default { 'root': 'client' }",
    );
    expect(select(['packages/core/src/a.ts'], 'packages/core')).toBeUndefined();
    write(
      'packages/core/vitest.config.ts',
      'export default { "projects": ["../other"] }',
    );
    expect(select(['packages/core/src/a.ts'], 'packages/core')).toBeUndefined();
  });

  it('hands a single-package suite the build output of its own package', () => {
    // Production hardcodes `ownerOf` to null in a single-root repo, and the
    // one package IS the root: its tests can import it by name, so the graph
    // holds its build output, not only the source the diff names.
    rmSync(join(root, 'packages'), { recursive: true });
    write(
      'package.json',
      JSON.stringify({
        name: 'r',
        scripts: { test: 'vitest run' },
        exports: { '.': './dist/index.js' },
      }),
    );
    write('dist/index.js');
    write('dist/value.js');
    write('src/value.ts');
    const own = relatedTests({
      root,
      changed: ['src/value.ts'],
      renamedFrom: [],
      ownerOf: () => null,
      reachOf: (d) => [d],
    });
    expect(own.select('.')?.paths).toEqual(['dist/value.js', 'src/value.ts']);
  });

  it('runs the suite whole for a path no command can carry, root included', () => {
    // Production hardcodes `ownerOf` to null for a single-root repo: every
    // path is in its reach, so an uncarriable one must not be dropped.
    write('package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));
    write('docs/a b.md');
    const single = relatedTests({
      root,
      changed: ['docs/a b.md', 'docs/guide.md'],
      renamedFrom: [],
      ownerOf: () => null,
      reachOf: (d) => [d],
    });
    expect(single.select('.')).toBeUndefined();
    expect(single.bailReason('.')).toContain('cannot be carried');
    // In a multi-root repo the same root-level path reaches only the root
    // suite; a workspace suite keeps its selection.
    expect(
      select(['packages/core/src/a.ts', 'docs/a b.md'], '.'),
    ).toBeUndefined();
    expect(
      select(['packages/core/src/a.ts', 'docs/a b.md'], 'packages/cli'),
    ).toBeDefined();
  });

  it('never carries a path a shell or vitest would read differently', () => {
    const hostile = [
      'packages/core/src/a b.ts',
      'packages/core/src/x$(id).ts',
      'packages/core/-flag.ts',
      'packages/core/src/q"uote.ts',
    ];
    for (const file of hostile) {
      write(file);
      expect(select([file], 'packages/core')).toBeUndefined();
    }
  });

  it('treats a package whose runtime entry is source as source', () => {
    // Exporting the manifest is not being built: `./package.json` decides
    // nothing about where the module's code lives.
    manifest('packages/core', {
      scripts: { test: 'vitest run' },
      exports: { '.': './src/index.ts', './package.json': './package.json' },
    });
    expect(select(['packages/core/src/a.ts'], 'packages/cli')?.paths).toEqual([
      '../core/src/a.ts',
    ]);
  });

  it('accepts a vitest linked between the workspace and the root', () => {
    write(
      'packages/group/member/package.json',
      JSON.stringify({ scripts: { test: 'vitest run' } }),
    );
    write('packages/group/member/src/m.ts');
    write('packages/group/member/src/m.test.ts');
    const bin = join(root, 'packages/group/node_modules/.bin');
    mkdirSync(bin, { recursive: true });
    const link = join(bin, 'vitest');
    symlinkSync(join(root, 'node_modules/vitest/vitest.mjs'), link);
    const own = relatedTests({
      root,
      changed: ['packages/group/member/src/m.ts'],
      renamedFrom: [],
      ownerOf: (file) => /^packages\/group\/member/.exec(file)?.[0] ?? null,
      reachOf: (d) => [d],
    });
    expect(own.select('packages/group/member')).toBeDefined();
    // A different vitest at that level is the one npm exec would not run.
    rmSync(link);
    write('vendor/vitest.mjs');
    symlinkSync(join(root, 'vendor/vitest.mjs'), link);
    expect(own.select('packages/group/member')).toBeUndefined();
  });

  it('accepts pnpm launchers that exec the same vitest', () => {
    // pnpm writes one shell launcher per install root. Each execs its own
    // relative path to the same vitest.mjs, and appends a `cmd-shim-target`
    // comment naming the module — metadata, not the command the shell runs.
    rmSync(join(root, 'node_modules/.bin/vitest'));
    write(
      'node_modules/.bin/vitest',
      '#!/bin/sh\nexec "$basedir/node" "$basedir/../vitest/vitest.mjs" "$@"\n' +
        '# cmd-shim-target=/private/tmp/install/node_modules/vitest/vitest.mjs\n',
    );
    write(
      'packages/group/member/package.json',
      JSON.stringify({ scripts: { test: 'vitest run' } }),
    );
    write('packages/group/member/src/m.ts');
    const bin = join(root, 'packages/group/node_modules/.bin');
    mkdirSync(bin, { recursive: true });
    const launcher = join(bin, 'vitest');
    // The comment names a DIFFERENT module: the exec line still decides.
    writeFileSync(
      launcher,
      '#!/bin/sh\nexec "$basedir/node" ' +
        '"$basedir/../../../../node_modules/vitest/vitest.mjs" "$@"\n' +
        '# cmd-shim-target=/private/tmp/install/node_modules/vendor/vitest.mjs\n',
    );
    const own = relatedTests({
      root,
      changed: ['packages/group/member/src/m.ts'],
      renamedFrom: [],
      ownerOf: (file) => /^packages\/group\/member/.exec(file)?.[0] ?? null,
      reachOf: (d) => [d],
    });
    expect(own.select('packages/group/member')).toBeDefined();
    // A launcher that EXECS a different vitest is a different vitest, even
    // when its comment names the root's.
    write('vendor/vitest/vitest.mjs');
    writeFileSync(
      launcher,
      '#!/bin/sh\nexec "$basedir/node" ' +
        '"$basedir/../../../../vendor/vitest/vitest.mjs" "$@"\n' +
        '# cmd-shim-target=/private/tmp/install/node_modules/vitest/vitest.mjs\n',
    );
    expect(own.select('packages/group/member')).toBeUndefined();
  });

  it('hands a suite the build output of a package it imports by name', () => {
    // cli imports core by package name: its graph holds core's `dist`.
    manifest('packages/core', {
      scripts: { test: 'vitest run' },
      main: 'dist/index.js',
      exports: { '.': './dist/index.js', './x': './dist/x.js' },
    });
    write('packages/core/dist/index.js');
    write('packages/core/dist/x.js');
    write('packages/core/dist/src/a.js');
    expect(select(['packages/core/src/a.ts'], 'packages/cli')?.paths).toEqual([
      '../core/dist/src/a.js',
      '../core/src/a.ts',
    ]);
    // A module that names a changed doc counts the same way.
    write('packages/core/dist/src/loader.js');
    expect(select(['docs/guide.md'], 'packages/cli')?.paths).toContain(
      '../core/dist/src/loader.js',
    );
    // A bundle has no counterpart: every entry stands in for it.
    rmSync(join(root, 'packages/core/dist/src'), { recursive: true });
    expect(select(['packages/core/src/a.ts'], 'packages/cli')?.paths).toEqual([
      '../core/dist/index.js',
      '../core/dist/x.js',
      '../core/src/a.ts',
    ]);
    // ...and a suite importing itself by name gets its own.
    expect(
      select(['packages/core/src/a.ts'], 'packages/core')?.paths,
    ).toContain('dist/index.js');
    // A dependency's own test is no module anything imports.
    write('packages/core/src/a.test.ts');
    expect(
      select(['packages/core/src/a.test.ts'], 'packages/cli')?.paths,
    ).toEqual(['../core/src/a.test.ts']);
    // An entry the build never produced: no path can name the graph's file.
    rmSync(join(root, 'packages/core/dist'), { recursive: true });
    expect(select(['packages/core/src/a.ts'], 'packages/cli')).toBeUndefined();
    // A source entry is in the graph as it is.
    manifest('packages/core', {
      scripts: { test: 'vitest run' },
      exports: { '.': { import: './src/index.ts' } },
    });
    expect(select(['packages/core/src/a.ts'], 'packages/cli')?.paths).toEqual([
      '../core/src/a.ts',
    ]);
    // What the suite cannot reach is not its concern.
    write('packages/web/src/w.ts');
    manifest('packages/web', {
      scripts: { test: 'vitest run' },
      main: 'dist/w.js',
    });
    expect(select(['packages/web/src/w.ts'], 'packages/cli')?.paths).toEqual([
      '../web/src/w.ts',
    ]);
  });

  it('runs the suite whole around an npm pretest or posttest', () => {
    const ruled = ['pretest', 'posttest'].map((hook) => {
      manifest('packages/core', {
        scripts: { test: 'vitest run', [hook]: 'node f.js' },
      });
      return select(['packages/core/src/a.ts'], 'packages/core');
    });
    expect(ruled).toEqual([undefined, undefined]);
    expect(select(['packages/core/src/a.ts'], 'packages/cli')).toBeDefined();
  });

  it('runs the suite whole when npm exec would not run the vitest npm test does', () => {
    // A workspace's own vitest: npm exec never looks there.
    write('packages/core/node_modules/vitest/vitest.mjs');
    mkdirSync(join(root, 'packages/core/node_modules/.bin'), {
      recursive: true,
    });
    symlinkSync(
      '../vitest/vitest.mjs',
      join(root, 'packages/core/node_modules/.bin/vitest'),
    );
    expect(select(['packages/core/src/a.ts'], 'packages/core')).toBeUndefined();
    expect(select(['packages/core/src/a.ts'], 'packages/cli')).toBeDefined();
    // One that is the root's, linked: the same vitest.
    rmSync(join(root, 'packages/core/node_modules'), { recursive: true });
    mkdirSync(join(root, 'packages/core/node_modules/.bin'), {
      recursive: true,
    });
    symlinkSync(
      '../../../../node_modules/vitest/vitest.mjs',
      join(root, 'packages/core/node_modules/.bin/vitest'),
    );
    expect(select(['packages/core/src/a.ts'], 'packages/core')).toBeDefined();
    // None at the root: npm exec would go to the registry.
    rmSync(join(root, 'node_modules/.bin'), { recursive: true });
    expect(select(['packages/core/src/a.ts'], 'packages/cli')).toBeUndefined();
  });

  it('runs the suite whole when its config moves the root, or hides what it sets', () => {
    const configs = [
      "export default defineConfig({ root: 'client' })",
      'const root = "client"; export default { root, test: {} }',
      "export default defineConfig({ test: { root: './src' } })",
      "import base from './vitest.base'; export default mergeConfig(base, {})",
      "export default async () => (await import('./shared.js')).default",
      "import './register-root.js'",
    ];
    const ruled = configs.map((text) => {
      write('packages/core/vitest.config.ts', text);
      return select(['packages/core/src/a.ts'], 'packages/core');
    });
    expect(ruled).toEqual(configs.map(() => undefined));
    // What only mentions a root in a comment, or a dir named root, is not one.
    write(
      'packages/core/vitest.config.ts',
      "// resolved against this file, not vitest's root/cwd\nconst p = '../root/x';",
    );
    expect(select(['packages/core/src/a.ts'], 'packages/core')).toBeDefined();
  });

  it('runs the suite whole when the diff changes a setup file its config names', () => {
    write(
      'packages/core/vitest.config.ts',
      "export default { test: { setupFiles: ['./src/setupTests.ts'], globalSetup: path.resolve(\n  __dirname,\n  '../../scripts/globals.js',\n) } }",
    );
    write('packages/core/src/setupTests.ts');
    write('scripts/globals.js');
    expect(
      select(['packages/core/src/setupTests.ts'], 'packages/core'),
    ).toBeUndefined();
    expect(select(['scripts/globals.js'], 'packages/core')).toBeUndefined();
    // A sibling module is still the graph's to relate.
    expect(select(['packages/core/src/a.ts'], 'packages/core')).toBeDefined();
  });

  it('runs the suite whole beside a vitest workspace or projects file', () => {
    for (const name of ['vitest.workspace.ts', 'vitest.projects.ts']) {
      write(`packages/core/${name}`, 'export default []');
      expect(
        select(['packages/core/src/a.ts'], 'packages/core'),
      ).toBeUndefined();
      rmSync(join(root, 'packages/core', name));
    }
  });

  it('reads the config the script names, and runs whole when it changes or is missing', () => {
    manifest('packages/core', {
      scripts: { test: 'vitest run --config cfg/unit.mts' },
    });
    expect(select(['packages/core/src/a.ts'], 'packages/core')).toBeUndefined();
    write('packages/core/cfg/unit.mts', "export default { root: 'x' }");
    expect(select(['packages/core/src/a.ts'], 'packages/core')).toBeUndefined();
    write('packages/core/cfg/unit.mts', 'export default {}');
    expect(select(['packages/core/src/a.ts'], 'packages/core')).toEqual({
      config: 'cfg/unit.mts',
      paths: ['src/a.ts'],
    });
    expect(
      select(
        ['packages/core/src/a.ts', 'packages/core/cfg/unit.mts'],
        'packages/core',
      ),
    ).toBeUndefined();
  });

  it('runs the suite whole when its script is not a plain vitest run', () => {
    manifest('packages/cli', { scripts: { test: 'vitest run --coverage' } });
    expect(select(['packages/core/src/a.ts'], 'packages/cli')).toBeUndefined();
    expect(select(['packages/core/src/a.ts'], 'packages/core')).toBeDefined();
  });

  it('runs every suite whole once the diff gives a reason', () => {
    const related = relatedTests({
      root,
      changed: ['packages/core/src/a.ts', 'packages/core/package.json'],
      renamedFrom: [],
      ownerOf: packageOf,
      reachOf: (d) => reach[d],
    });
    expect(related.reason).toBe('it changes packages/core/package.json');
    expect(related.select('packages/core')).toBeUndefined();
    // ...while the same suite is narrowable in its own right.
    expect(related.narrowable('packages/core')).toBe(true);
    expect(
      select(['packages/core/src/a.ts'], 'packages/core', [
        'packages/core/src/b.ts',
      ]),
    ).toBeUndefined();
  });

  it('carries a config the script names, and serves the root suite', () => {
    manifest('packages/web', {
      scripts: { test: 'vitest run --config vitest.unit.config.ts' },
    });
    write('packages/web/vitest.unit.config.ts', 'export default {}');
    expect(select(['docs/guide.md'], 'packages/web')).toEqual({
      config: 'vitest.unit.config.ts',
      paths: [
        '../../docs/guide.md',
        '../../scripts/lib/docs.ts',
        'src/docs.test.ts',
        'src/loader.ts',
      ],
    });
    write('package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));
    // The root's own: what lives outside every workspace.
    expect(select(['docs/guide.md'], '.')?.paths).toEqual([
      'docs/guide.md',
      'scripts/lib/docs.ts',
    ]);
  });

  it('leaves off a path no command can carry outside the suite, and runs whole for one inside it', () => {
    write('docs-site/src/app/[[...mdxPath]]/page.jsx');
    expect(
      select(
        ['docs-site/src/app/[[...mdxPath]]/page.jsx', 'packages/core/src/a.ts'],
        'packages/core',
      )?.paths,
    ).toEqual(['src/a.ts']);
    write('packages/core/src/odd name.ts');
    // Beside a file the suite would relate: the uncarried one decides.
    const both = ['packages/core/src/odd name.ts', 'packages/core/src/a.ts'];
    expect(select(both, 'packages/core')).toBeUndefined();
    expect(select(both, 'packages/cli')).toBeUndefined();
    // ...but it is nothing to a suite that cannot reach it.
    write('packages/web/src/w.ts');
    expect(
      select(
        ['packages/core/src/odd name.ts', 'packages/web/src/w.ts'],
        'packages/web',
      )?.paths,
    ).toEqual(['src/w.ts']);
  });

  it('runs the suite whole when what names a file cannot ride the command', () => {
    write('packages/cli/src/odd name.test.ts', "'guide.md'");
    expect(select(['docs/guide.md'], 'packages/cli')).toBeUndefined();
  });

  it('runs the suite whole past the path cap of one command', () => {
    for (let i = 0; i < 400; i++) {
      write(`packages/cli/src/n${i}.test.ts`, "'guide.md'");
    }
    expect(select(['docs/guide.md'], 'packages/cli')).toBeUndefined();
    // At it, the run is still related: 397 of these, the suite's own test,
    // core's loader and the doc itself.
    for (const f of ['n0.test.ts', 'n1.test.ts', 'n2.test.ts']) {
      rmSync(join(root, 'packages/cli/src', f));
    }
    rmSync(join(root, 'scripts/lib/docs.ts'));
    expect(select(['docs/guide.md'], 'packages/cli')?.paths).toHaveLength(400);
  });
});
