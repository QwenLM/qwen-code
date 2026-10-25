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

  it('leaves a diff of present source files to the graph', () => {
    touch('packages/a/src/x.ts', 'docs/guide.md', 'packages/a/src/x.test.ts');
    expect(
      wholeSuiteReason(
        root,
        ['packages/a/src/x.ts', 'docs/guide.md', 'packages/a/src/x.test.ts'],
        [],
      ),
    ).toBeUndefined();
    // A test OF a setup is in the graph like any other test.
    touch('packages/a/src/globalSetup.test.ts');
    expect(
      wholeSuiteReason(root, ['packages/a/src/globalSetup.test.ts'], []),
    ).toBeUndefined();
  });

  it('runs every suite whole for what reaches tests without an import', () => {
    const files = [
      'package.json',
      'packages/a/package.json',
      'pnpm-lock.yaml',
      'package-lock.json',
      'pnpm-workspace.yaml',
      '.npmrc',
      'packages/a/tsconfig.build.json',
      'packages/a/vitest.config.ts',
      'packages/a/vite.lib.config.ts',
      'vitest.workspace.ts',
      'packages/a/test-setup.ts',
      'scripts/vitest-global-setup.js',
      'patches/dep@1.0.0.patch',
    ];
    touch(...files);
    expect(files.map((f) => wholeSuiteReason(root, [f], []))).toEqual(
      files.map((f) => `it changes ${f}`),
    );
  });

  it('runs every suite whole for a deletion, a rename, or a name no command can carry', () => {
    expect(wholeSuiteReason(root, ['packages/a/src/gone.ts'], [])).toBe(
      'it deletes packages/a/src/gone.ts',
    );
    touch('packages/a/src/new.ts');
    expect(
      wholeSuiteReason(
        root,
        ['packages/a/src/new.ts'],
        ['packages/a/src/old.ts'],
      ),
    ).toBe('it renames packages/a/src/old.ts');
    const unsafe = ['a b.ts', 'x$(id).ts', '-flag.ts', 'q"uote.ts'];
    expect(unsafe.map((f) => wholeSuiteReason(root, [f], []))).toEqual(
      unsafe.map(
        (f) => `${JSON.stringify(f)} cannot be passed to vitest as written`,
      ),
    );
    const many = Array.from({ length: 201 }, (_, i) => `f${i}.ts`);
    touch(...many);
    expect(wholeSuiteReason(root, many, [])).toBe('it changes 201 files');
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
    write('a/longer.ts', "'my-guide.md' + 'guide.mdx' + 'guide.md.bak'");
    write('a/prose.md', 'guide.md');
    expect(filesNaming(root, ['guide.md'])?.get('guide.md')?.sort()).toEqual([
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
  const owners = ['packages/cli', 'packages/core', 'packages/web'];
  const ownerOf = (file: string): string | null =>
    owners.find((d) => file.startsWith(`${d}/`)) ?? null;
  const reach: Record<string, string[]> = {
    'packages/cli': ['packages/core', 'packages/cli'],
    'packages/core': ['packages/core'],
    'packages/web': ['packages/web'],
  };
  const select = (changed: string[], dir: string, renamedFrom: string[] = []) =>
    relatedTests({
      root,
      changed,
      renamedFrom,
      ownerOf,
      reachOf: (d) => reach[d] ?? [d],
    }).select(dir);

  beforeEach(() => {
    for (const d of owners) {
      write(
        `${d}/package.json`,
        JSON.stringify({ scripts: { test: 'vitest run' } }),
      );
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
    // but not to run.
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

  it('looks up no source module by name: the graph covers it', () => {
    write('packages/core/src/a.test.ts', "'a.ts'");
    expect(select(['packages/core/src/a.ts'], 'packages/core')?.paths).toEqual([
      'src/a.ts',
    ]);
  });

  it('runs the suite whole when its script is not a plain vitest run', () => {
    write(
      'packages/cli/package.json',
      JSON.stringify({ scripts: { test: 'vitest run --coverage' } }),
    );
    expect(select(['packages/core/src/a.ts'], 'packages/cli')).toBeUndefined();
    expect(select(['packages/core/src/a.ts'], 'packages/core')).toBeDefined();
  });

  it('runs every suite whole once the diff gives a reason', () => {
    write('packages/core/package.json', '{}');
    expect(
      relatedTests({
        root,
        changed: ['packages/core/src/a.ts', 'packages/core/package.json'],
        renamedFrom: [],
        ownerOf,
        reachOf: (d) => reach[d],
      }).reason,
    ).toBe('it changes packages/core/package.json');
    expect(
      select(['packages/core/src/a.ts'], 'packages/core', [
        'packages/core/src/b.ts',
      ]),
    ).toBeUndefined();
  });

  it('carries a config the script names, and serves the root suite', () => {
    write(
      'packages/web/package.json',
      JSON.stringify({
        scripts: { test: 'vitest run --config vitest.unit.config.ts' },
      }),
    );
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
