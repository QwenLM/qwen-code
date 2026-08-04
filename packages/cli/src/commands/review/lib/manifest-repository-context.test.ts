/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  manifestRepositoryContextProvider,
  MAX_GLOB_CANDIDATES,
} from './manifest-repository-context.js';

function temp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'manifest-context-')));
}

function write(path: string, content = ''): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function manifest(overrides: object = {}): string {
  return JSON.stringify({
    version: 1,
    label: 'Example repository',
    rules: [{ paths: ['src/**'] }],
    ...overrides,
  });
}

function provide(
  worktree: string,
  changedPaths: string[],
  content: string | null,
) {
  return manifestRepositoryContextProvider.provide({
    worktree,
    changedPaths,
    readIdentityFile: () => content,
  });
}

describe('manifest repository context provider', () => {
  it('matches rules, merges fields, and expands related files', () => {
    const worktree = temp();
    write(join(worktree, 'src', 'change.ts'));
    write(join(worktree, 'src', 'support.ts'));
    write(join(worktree, 'src', '.hidden.ts'));
    const content = manifest({
      rules: [
        {
          paths: ['src/**'],
          relatedPaths: ['src/**'],
          domains: ['runtime'],
          recommendedTests: ['test:fast'],
          requiredConfigurations: ['debug'],
          requiredAgents: ['test-matrix'],
          unverifiedDimensions: ['Alternate configuration'],
          verificationNotes: ['Run focused checks'],
        },
        {
          paths: ['src/*.ts'],
          domains: ['compiler', 'runtime'],
          recommendedTests: ['test:fast', 'test:full'],
        },
      ],
    });

    expect(provide(worktree, ['src/change.ts'], content)).toEqual({
      version: 1,
      provider: 'manifest',
      label: 'Example repository',
      domains: ['compiler', 'runtime'],
      relatedPaths: ['src/.hidden.ts', 'src/support.ts'],
      recommendedTests: ['test:fast', 'test:full'],
      requiredConfigurations: ['debug'],
      requiredAgents: ['test-matrix'],
      unverifiedDimensions: ['Alternate configuration'],
      verificationNotes: ['Run focused checks'],
    });
  });

  it('returns null without a manifest or matching rule', () => {
    const worktree = temp();
    expect(provide(worktree, ['src/change.ts'], null)).toBeNull();
    expect(
      provide(
        worktree,
        ['src/change.ts'],
        manifest({ rules: [{ paths: ['docs/**'] }] }),
      ),
    ).toBeNull();
  });

  it('attaches nothing for an empty change set', () => {
    // `[].some(...)` is false, so no rule matches an empty diff — pinning the
    // filter against a `.every` mutation, under which EVERY rule matches.
    const worktree = temp();
    const content = manifest({
      rules: [{ paths: ['**'], requiredAgents: ['test-matrix'] }],
    });
    expect(provide(worktree, [], content)).toBeNull();
  });

  it.each([
    ['malformed JSON', '{'],
    ['unknown top-level field', manifest({ extra: true })],
    ['missing required field', JSON.stringify({ version: 1, rules: [] })],
    [
      'unknown rule field',
      manifest({ rules: [{ paths: ['src/**'], extra: [] }] }),
    ],
    ['duplicate array', manifest({ rules: [{ paths: ['src/**', 'src/**'] }] })],
    ['unsafe traversal glob', manifest({ rules: [{ paths: ['src/../**'] }] })],
    ['unsafe absolute glob', manifest({ rules: [{ paths: ['/src/**'] }] })],
    ['unsafe brace glob', manifest({ rules: [{ paths: ['src/{a,b}.ts'] }] })],
    ['unsafe extglob', manifest({ rules: [{ paths: ['src/+(a).ts'] }] })],
    [
      'unbounded related glob',
      manifest({
        rules: [{ paths: ['src/**'], relatedPaths: ['**/*.ts'] }],
      }),
    ],
    [
      'root-level wildcard related glob',
      manifest({
        rules: [{ paths: ['src/**'], relatedPaths: ['*.ts'] }],
      }),
    ],
    [
      'first-segment wildcard related glob',
      manifest({
        rules: [{ paths: ['src/**'], relatedPaths: ['src*/*.ts'] }],
      }),
    ],
  ])('fails closed for %s', (_name, content) => {
    expect(() => provide(temp(), ['src/change.ts'], content)).toThrow();
  });

  it('fails closed when the total paths globs outgrow the matching bound', () => {
    // The rule filter tests every changed path against every `paths` glob,
    // so the total across rules — not each rule's array — is capped.
    const worktree = temp();
    const rules = [
      { paths: Array.from({ length: 128 }, (_, index) => `area-${index}.ts`) },
      { paths: ['src/**'] },
    ];
    expect(() =>
      provide(worktree, ['src/change.ts'], manifest({ rules })),
    ).toThrow('paths exceeds limit');
  });

  it('fails closed when merged fields or glob lists outgrow the wire bound', () => {
    const worktree = temp();
    // Every single rule honors the 128-item bound; the MERGE does not.
    expect(() =>
      provide(
        worktree,
        ['src/change.ts'],
        manifest({
          rules: [
            {
              paths: ['src/**'],
              domains: Array.from(
                { length: 128 },
                (_, index) => `domain-a-${String(index).padStart(3, '0')}`,
              ),
            },
            {
              paths: ['src/**'],
              domains: Array.from(
                { length: 128 },
                (_, index) => `domain-b-${String(index).padStart(3, '0')}`,
              ),
            },
          ],
        }),
      ),
    ).toThrow('domains exceeds limit');
    expect(() =>
      provide(
        worktree,
        ['src/change.ts'],
        manifest({
          rules: Array.from({ length: 65 }, (_, index) => ({
            paths: ['src/**'],
            verificationNotes: [
              `note-a-${String(index).padStart(3, '0')}`,
              `note-b-${String(index).padStart(3, '0')}`,
            ],
          })),
        }),
      ),
    ).toThrow('verificationNotes exceeds limit');
    // The merged `relatedPaths` pattern list is capped BEFORE any scan, or a
    // max-cardinality manifest stalls expansion for minutes.
    expect(() =>
      provide(
        worktree,
        ['src/change.ts'],
        manifest({
          rules: [
            {
              paths: ['src/**'],
              relatedPaths: Array.from(
                { length: 128 },
                (_, index) => `p-a/${index}.ts`,
              ),
            },
            {
              paths: ['src/**'],
              relatedPaths: Array.from(
                { length: 128 },
                (_, index) => `p-b/${index}.ts`,
              ),
            },
          ],
        }),
      ),
    ).toThrow('relatedPaths exceeds limit');
  });

  it('excludes related file and directory symlink escapes', () => {
    const root = temp();
    const worktree = join(root, 'worktree');
    const outside = join(root, 'outside');
    write(join(outside, 'secret.ts'));
    write(join(worktree, 'src', 'safe.ts'));
    symlinkSync(join(outside, 'secret.ts'), join(worktree, 'src', 'escape.ts'));
    symlinkSync(outside, join(worktree, 'src', 'external'));

    const context = provide(
      worktree,
      ['src/change.ts'],
      manifest({
        rules: [{ paths: ['src/**'], relatedPaths: ['src/**'] }],
      }),
    );
    expect(context?.relatedPaths).toEqual(['src/safe.ts']);
  });

  // A backslash is a path separator on Windows, so the POSIX-only filename
  // shape this guards against cannot exist there.
  it.skipIf(process.platform === 'win32')(
    'skips related files with POSIX-legal unsafe name bytes',
    () => {
      // A backslash is a legal filename byte on POSIX; such a file must be
      // skipped rather than failing validation for the whole review.
      const worktree = temp();
      write(join(worktree, 'src', 'safe.ts'));
      write(join(worktree, 'src', 'foo\\bar.ts'));
      const context = provide(
        worktree,
        ['src/change.ts'],
        manifest({
          rules: [{ paths: ['src/**'], relatedPaths: ['src/**'] }],
        }),
      );
      expect(context?.relatedPaths).toEqual(['src/safe.ts']);
    },
  );

  it('never descends into dependency or build-output trees', () => {
    // Without the skip this installed-shape tree exceeds the visited-entry
    // ceiling mid-scan; with it, only source entries count.
    const worktree = temp();
    write(join(worktree, 'src', 'keep.ts'));
    write(join(worktree, 'src', 'dist', 'built.js'));
    const deps = join(worktree, 'src', 'node_modules');
    mkdirSync(deps, { recursive: true });
    for (let index = 0; index < MAX_GLOB_CANDIDATES; index++) {
      writeFileSync(join(deps, `${String(index).padStart(6, '0')}.js`), '');
    }
    expect(
      provide(
        worktree,
        ['src/change.ts'],
        manifest({
          rules: [{ paths: ['src/**'], relatedPaths: ['src/**'] }],
        }),
      )?.relatedPaths,
    ).toEqual(['src/keep.ts']);
  }, 30_000);

  it('fails closed as soon as related matches exceed the bound', () => {
    const worktree = temp();
    const source = join(worktree, 'src');
    mkdirSync(source);
    for (let index = 0; index < 129; index++) {
      writeFileSync(join(source, `${String(index).padStart(3, '0')}.ts`), '');
    }
    expect(() =>
      provide(
        worktree,
        ['src/change.ts'],
        manifest({
          rules: [{ paths: ['src/**'], relatedPaths: ['src/**'] }],
        }),
      ),
    ).toThrow('exceeds limit');
  });

  it('fails closed on the static branch when merged matches exceed the bound', () => {
    // 128 wildcard matches sit exactly at the bound, then a static root adds
    // one more — the static-file branch enforces the same cap the directory
    // branch does, or the wire validator reports a schema shape error instead.
    const worktree = temp();
    const source = join(worktree, 'src');
    mkdirSync(source);
    for (let index = 0; index < 128; index++) {
      writeFileSync(join(source, `${String(index).padStart(3, '0')}.ts`), '');
    }
    write(join(worktree, 'zz', 'extra.ts'));
    expect(() =>
      provide(
        worktree,
        ['src/change.ts'],
        manifest({
          rules: [
            {
              paths: ['src/**'],
              relatedPaths: ['src/**', 'zz/extra.ts'],
            },
          ],
        }),
      ),
    ).toThrow('relatedPaths exceeds limit');
  });

  it('bounds candidate scanning even when matches are later excluded', () => {
    const worktree = temp();
    const source = join(worktree, 'src');
    mkdirSync(source);
    const changedPaths = Array.from(
      { length: MAX_GLOB_CANDIDATES + 1 },
      (_, index) => {
        const name = `${String(index).padStart(6, '0')}.ts`;
        writeFileSync(join(source, name), '');
        return `src/${name}`;
      },
    );
    expect(() =>
      provide(
        worktree,
        changedPaths,
        manifest({
          rules: [{ paths: ['src/**'], relatedPaths: ['src/**'] }],
        }),
      ),
    ).toThrow('scan exceeds limit');
  }, 30_000);

  it('expands nested related globs without double-counting the subsumed root', () => {
    const worktree = temp();
    write(join(worktree, 'docs', 'a.ts'));
    write(join(worktree, 'docs', 'api', 'b.ts'));
    expect(
      provide(
        worktree,
        ['src/change.ts'],
        manifest({
          rules: [
            {
              paths: ['src/**'],
              relatedPaths: ['docs/**', 'docs/api/**'],
            },
          ],
        }),
      )?.relatedPaths,
    ).toEqual(['docs/a.ts', 'docs/api/b.ts']);
  });

  it('counts a subsumed subtree against the scan bound only once', () => {
    // Double-scanning this tree against the shared counter visits ~2x8194
    // entries and fails a legal manifest closed at half the tree.
    const worktree = temp();
    const api = join(worktree, 'docs', 'api');
    mkdirSync(api, { recursive: true });
    for (let index = 0; index < MAX_GLOB_CANDIDATES / 2; index++) {
      mkdirSync(join(api, `dir-${String(index).padStart(5, '0')}`));
    }
    write(join(worktree, 'docs', 'a.ts'));
    expect(
      provide(
        worktree,
        ['src/change.ts'],
        manifest({
          rules: [
            {
              paths: ['src/**'],
              relatedPaths: ['docs/**', 'docs/api/**'],
            },
          ],
        }),
      )?.relatedPaths,
    ).toEqual(['docs/a.ts']);
  }, 30_000);

  it('accepts unsorted manifest arrays and sorts the merged output', () => {
    // The manifest is human-authored: only uniqueness is enforced there; the
    // provider sorts before the wire format's strict sorted-and-unique
    // validator sees the result.
    const worktree = temp();
    write(join(worktree, 'src', 'a.ts'));
    write(join(worktree, 'src', 'b.ts'));
    const content = manifest({
      rules: [
        {
          paths: ['src/b.ts', 'src/a.ts'],
          relatedPaths: ['src/b.ts', 'src/a.ts'],
          domains: ['zeta', 'alpha'],
        },
      ],
    });
    const context = provide(worktree, ['src/a.ts'], content);
    expect(context?.domains).toEqual(['alpha', 'zeta']);
    expect(context?.relatedPaths).toEqual(['src/b.ts']);
  });

  it('deduplicates related patterns before applying the scan bound', () => {
    const worktree = temp();
    for (let index = 0; index < 9; index++) {
      write(join(worktree, 'src', `${index}.ts`));
    }
    const rules = Array.from({ length: 128 }, () => ({
      paths: ['src/**'],
      relatedPaths: ['src/**'],
    }));
    expect(
      provide(worktree, ['src/change.ts'], manifest({ rules }))?.relatedPaths,
    ).toHaveLength(9);
  });

  it('expands static related paths as their own files', () => {
    const worktree = temp();
    write(join(worktree, 'src', 'main.ts'));
    write(join(worktree, 'src', 'main.test.ts'));
    expect(
      provide(
        worktree,
        ['src/main.ts'],
        manifest({
          rules: [{ paths: ['src/**'], relatedPaths: ['src/main.test.ts'] }],
        }),
      )?.relatedPaths,
    ).toEqual(['src/main.test.ts']);
  });

  it('resolves a top-level static related entry as itself', () => {
    // A completely static entry can never begin with a repository-wide
    // wildcard, so the directory-prefix rule applies only to wildcard globs.
    const worktree = temp();
    write(join(worktree, 'package.json'), '{}');
    expect(
      provide(
        worktree,
        ['src/change.ts'],
        manifest({
          rules: [{ paths: ['src/**'], relatedPaths: ['package.json'] }],
        }),
      )?.relatedPaths,
    ).toEqual(['package.json']);
  });

  it('uses case-sensitive UTF-16 matching for rules and related expansion', () => {
    const worktree = temp();
    write(join(worktree, 'src', 'X.TS'));
    write(join(worktree, 'src', '😀.ts'));
    expect(
      provide(
        worktree,
        ['src/X.TS'],
        manifest({ rules: [{ paths: ['src/*.ts'] }] }),
      ),
    ).toBeNull();
    expect(
      provide(
        worktree,
        ['src/😀.ts'],
        manifest({ rules: [{ paths: ['src/?.ts'] }] }),
      ),
    ).toBeNull();
    expect(
      provide(
        worktree,
        ['src/😀.ts'],
        manifest({ rules: [{ paths: ['src/??.ts'] }] }),
      )?.label,
    ).toBe('Example repository');
  });

  it('matches multi-star segments in polynomial time', () => {
    // `'ab*'` repeated in one segment is the catastrophic-backtracking shape
    // the old compiled regex died on (a 45 s watchdog killed the probe at an
    // 81-char filename); the matcher stays polynomial in pattern x value.
    const worktree = temp();
    write(join(worktree, 'src', `${'ab'.repeat(40)}x`));
    write(join(worktree, 'src', 'ababab'));
    const content = manifest({
      rules: [
        {
          paths: ['src/**'],
          relatedPaths: [`src/${'ab*'.repeat(30)}ab`, 'src/ab*ab*ab'],
        },
      ],
    });
    expect(provide(worktree, ['src/change.ts'], content)?.relatedPaths).toEqual(
      ['src/ababab'],
    );
  }, 10_000);

  it('produces deterministic code-unit sorted output', () => {
    const worktree = temp();
    write(join(worktree, 'src', 'z.ts'));
    write(join(worktree, 'src', 'A.ts'));
    // A directory that is a strict prefix of a sibling file's name: the scan
    // emits the directory's contents before the sibling ('eslint' sorts
    // before 'eslint.config.js'), the REVERSE of code-unit order ('.' 0x2E
    // < '/' 0x2F) — the shape the final sort exists to repair.
    write(join(worktree, 'src', 'eslint', 'index.ts'));
    write(join(worktree, 'src', 'eslint.config.js'));
    const content = manifest({
      rules: [
        {
          paths: ['src/**'],
          relatedPaths: ['src/**'],
          domains: ['zeta'],
        },
        {
          paths: ['src/*.ts'],
          domains: ['Alpha'],
        },
      ],
    });
    const first = provide(worktree, ['src/change.ts'], content);
    const second = provide(worktree, ['src/change.ts'], content);
    expect(first).toEqual(second);
    expect(first?.domains).toEqual(['Alpha', 'zeta']);
    expect(first?.relatedPaths).toEqual([
      'src/A.ts',
      'src/eslint.config.js',
      'src/eslint/index.ts',
      'src/z.ts',
    ]);
  });
});
