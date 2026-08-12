/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  manifestRepositoryContextProvider,
  MAX_GLOB_CANDIDATES,
  MAX_MATCH_WORK,
} from './manifest-repository-context.js';
import { MAX_IDENTITY_BYTES } from './repository-context.js';

const worktrees: string[] = [];

function temp(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'manifest-context-')));
  worktrees.push(root);
  return root;
}

// Several fixtures hold 16k-entry trees; leaking them exhausts a tmpfs
// /tmp within a handful of runs. Deleting them is tens of thousands of
// unlinks, which has blown past the default 10s hook timeout on a loaded
// CI runner — give the teardown the time it needs rather than failing a
// green suite on cleanup.
afterAll(() => {
  for (const root of worktrees) {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

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
    ['unsupported manifest version', manifest({ version: 2 })],
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

  it('fails closed when the rule count exceeds the parse bound', () => {
    // MAX_RULES is the parse-time/memory bound protecting the step from
    // adversarial manifests. Nothing else compensates: `paths: []` passes
    // the array validator and contributes nothing to the total-`paths` cap,
    // so an unbounded rule count would walk the full per-rule loop.
    expect(() =>
      provide(
        temp(),
        ['src/change.ts'],
        manifest({ rules: Array.from({ length: 129 }, () => ({ paths: [] })) }),
      ),
    ).toThrow('rules is invalid');
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
    expect(
      () =>
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
      // Distinct from the resolved-files cap in the expansion: the operator
      // must be able to tell whether to trim the glob list or the globs.
    ).toThrow('relatedPaths glob list exceeds limit');
  });

  it('rejects globs that enter dependency or build-output trees', () => {
    // The never-descend invariant is enforced for entries found during
    // recursion; without rejecting these at validation, a pattern ROOTED
    // below a skipped tree bypasses it through the scan roots (and can
    // exhaust the entry ceiling mid-scan on an installed checkout).
    const worktree = temp();
    const content = (paths: string[], relatedPaths: string[]) =>
      manifest({ rules: [{ paths, relatedPaths }] });
    expect(() =>
      provide(
        worktree,
        ['src/change.ts'],
        content(['src/**'], ['coverage/**']),
      ),
    ).toThrow('relatedPaths enters a skipped directory');
    expect(() =>
      provide(
        worktree,
        ['src/change.ts'],
        content(['src/**'], ['src/dist/**']),
      ),
    ).toThrow('relatedPaths enters a skipped directory');
    expect(() =>
      provide(
        worktree,
        ['src/change.ts'],
        content(['node_modules/vendor/**/*.ts'], ['src/**']),
      ),
    ).toThrow('paths enters a skipped directory');
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
  // shapes this guards against cannot exist there.
  it.skipIf(process.platform === 'win32')(
    'skips related files with POSIX-legal unsafe name bytes',
    () => {
      // A backslash and a control character are legal filename bytes on
      // POSIX; such files must be skipped rather than failing validation
      // for the whole review.
      const worktree = temp();
      write(join(worktree, 'src', 'safe.ts'));
      write(join(worktree, 'src', 'foo\\bar.ts'));
      write(join(worktree, 'src', 'foo\u0001bar.ts'));
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

  it.each([
    '.git',
    '.next',
    '.playwright',
    '.turbo',
    'coverage',
    'dist',
    'node_modules',
    'out',
    'playwright-report',
    'target',
    'test-results',
  ])(
    'never descends into %s',
    (name) => {
      // Without the skip this installed-shape tree exceeds the visited-entry
      // ceiling mid-scan; with it, only source entries count. Every member of
      // the skip set is pinned, or removing any single one ships green.
      const worktree = temp();
      write(join(worktree, 'src', 'keep.ts'));
      const skipped = join(worktree, 'src', name);
      mkdirSync(skipped, { recursive: true });
      for (let index = 0; index < MAX_GLOB_CANDIDATES; index++) {
        writeFileSync(
          join(skipped, `${String(index).padStart(6, '0')}.js`),
          '',
        );
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
    },
    30_000,
  );

  it('accepts a scan sitting exactly at the resolved-file bound', () => {
    // The reject side pins 129 matches; this accept pin sits exactly at
    // 128, where a `>` → `>=` regression would fail a legal manifest
    // closed at the source's own calibration point. 127 wildcard matches
    // plus one static entry also exercise the cap check in BOTH branches.
    const worktree = temp();
    const source = join(worktree, 'src');
    mkdirSync(source);
    for (let index = 0; index < 127; index++) {
      writeFileSync(join(source, `${String(index).padStart(3, '0')}.ts`), '');
    }
    write(join(worktree, 'zz', 'extra.ts'));
    expect(
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
      )?.relatedPaths,
    ).toHaveLength(128);
  });

  it('accepts a scan visiting exactly the visited-entry ceiling', () => {
    // The reject side pins 16,385 entries; this accept pin visits exactly
    // MAX_GLOB_CANDIDATES. Empty directories count as entries too; the
    // scan root itself does not.
    const worktree = temp();
    const source = join(worktree, 'src');
    mkdirSync(source);
    for (let index = 0; index < MAX_GLOB_CANDIDATES - 1; index++) {
      mkdirSync(join(source, `d-${String(index).padStart(5, '0')}`));
    }
    writeFileSync(join(source, 'keep.ts'), '');
    expect(
      provide(
        worktree,
        ['src/change.ts'],
        manifest({
          rules: [{ paths: ['src/**'], relatedPaths: ['src/**'] }],
        }),
      )?.relatedPaths,
    ).toEqual(['src/keep.ts']);
  }, 60_000);

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
    ).toThrow('relatedPaths exceeds limit');
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

  it('deduplicates related patterns before applying the merge bound', () => {
    // 128 rules each contribute the same two patterns: 256 pre-dedup
    // (OVER the cap) and 2 post-dedup (under it). A cap-before-dedup
    // regression throws here; under it, two matching rules sharing one
    // 100-pattern list would reject a legal, human-authored manifest.
    const worktree = temp();
    for (let index = 0; index < 5; index++) {
      write(join(worktree, 'src', `${index}.ts`));
    }
    for (let index = 0; index < 4; index++) {
      write(join(worktree, 'docs', `${index}.ts`));
    }
    const rules = Array.from({ length: 128 }, () => ({
      paths: ['src/**'],
      relatedPaths: ['src/**', 'docs/**'],
    }));
    expect(
      provide(worktree, ['src/change.ts'], manifest({ rules }))?.relatedPaths,
    ).toHaveLength(9);
  });

  it('fails closed when cumulative matching work exceeds the budget', () => {
    // The visited-entry cap bounds a COUNT; the per-candidate matching
    // work is a separate dimension (O(pattern segments x path segments)
    // per memoised attempt). Deep literal chains keep each attempt cheap
    // to run but maximal in charged segments, so the budget trips — with
    // the scan-limit wording — long before the entry cap does, pinning
    // the accounting without a minutes-long memo explosion.
    const worktree = temp();
    let directory = join(worktree, 'x');
    for (let level = 0; level < 198; level++) {
      directory = join(directory, 'a');
    }
    directory = join(directory, 'z');
    mkdirSync(directory, { recursive: true });
    for (let index = 0; index < 60; index++) {
      writeFileSync(
        join(directory, `leaf-${String(index).padStart(4, '0')}.ts`),
        '',
      );
    }
    const stem = `x/${'a/'.repeat(198)}*/`;
    expect(() =>
      provide(
        worktree,
        ['x/change.ts'],
        manifest({
          rules: [
            {
              paths: ['x/**'],
              relatedPaths: Array.from(
                { length: 128 },
                (_, index) => `${stem}b${index}`,
              ),
            },
          ],
        }),
      ),
    ).toThrow('matching work exceeds limit');
  }, 30_000);

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

  it('fails closed before parsing an oversized manifest', () => {
    // The size ceiling sits BEFORE JSON.parse: an attacker-committed
    // manifest near the push size limits must not drive the parser's
    // memory to the heap ceiling just to reach the bounded-array
    // rejection.
    expect(() =>
      provide(temp(), ['src/change.ts'], 'x'.repeat(MAX_IDENTITY_BYTES + 1)),
    ).toThrow('exceeds the size limit');
  });

  it('merges fields only from rules whose paths matched', () => {
    // A rule scoped to another tree must not attach its fields to a review
    // it does not match: `matched.flatMap` rewritten to
    // `manifest.rules.flatMap` inflates every context with every rule and
    // must turn red here.
    const worktree = temp();
    write(join(worktree, 'docs', 'note.md'));
    const content = manifest({
      rules: [
        { paths: ['docs/**'], domains: ['docs-domain'] },
        {
          paths: ['tools/**'],
          domains: ['tools-domain'],
          requiredAgents: ['test-matrix'],
          verificationNotes: ['tools note'],
        },
      ],
    });
    const context = provide(worktree, ['docs/note.md'], content);
    expect(context?.domains).toEqual(['docs-domain']);
    expect(context?.requiredAgents).toEqual([]);
    expect(context?.verificationNotes).toEqual([]);
  });

  it('enforces the skip set case-insensitively', () => {
    // A case-varied pattern or directory name walks into a skipped tree on
    // every platform unless membership compares case-insensitively at both
    // enforcement sites.
    const worktree = temp();
    expect(() =>
      provide(
        worktree,
        ['src/change.ts'],
        manifest({ rules: [{ paths: ['NODE_MODULES/**'] }] }),
      ),
    ).toThrow('paths enters a skipped directory');
    expect(() =>
      provide(
        worktree,
        ['src/change.ts'],
        manifest({
          rules: [{ paths: ['src/**'], relatedPaths: ['src/DIST/**'] }],
        }),
      ),
    ).toThrow('relatedPaths enters a skipped directory');
    write(join(worktree, 'src', 'keep.ts'));
    write(join(worktree, 'src', 'NODE_MODULES', 'dep.js'));
    expect(
      provide(
        worktree,
        ['src/change.ts'],
        manifest({
          rules: [{ paths: ['src/**'], relatedPaths: ['src/**'] }],
        }),
      )?.relatedPaths,
    ).toEqual(['src/keep.ts']);
  });

  it('skips a static related entry that is itself a symlink', () => {
    // The scan-root lstat guard needs its own pin: the recursion-level
    // dirent check never sees a symlink that IS the scan root.
    const worktree = temp();
    write(join(worktree, 'src', 'real.ts'));
    symlinkSync('real.ts', join(worktree, 'src', 'link.ts'));
    expect(
      provide(
        worktree,
        ['src/change.ts'],
        manifest({
          rules: [{ paths: ['src/**'], relatedPaths: ['src/link.ts'] }],
        }),
      )?.relatedPaths,
    ).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'excludes files reached through a symlinked interior scan-root component',
    () => {
      // The scan-root lstat guard inspects only the FINAL component; the
      // containment check is the only defense against an escaping symlink
      // MID-path. A head that swaps a base rule's directory for such a link
      // would otherwise leak outside files into every reviewer prompt.
      const root = temp();
      const worktree = join(root, 'worktree');
      const outside = join(root, 'outside');
      write(join(outside, 'v2', 'secret.ts'));
      mkdirSync(join(worktree, 'docs'), { recursive: true });
      symlinkSync(outside, join(worktree, 'docs', 'api'));
      expect(
        provide(
          worktree,
          ['src/change.ts'],
          manifest({
            rules: [
              {
                paths: ['src/**'],
                relatedPaths: ['docs/api/v2/**', 'docs/api/v2/secret.ts'],
              },
            ],
          }),
        )?.relatedPaths,
      ).toEqual([]);
    },
  );

  it('still scans names the skip set deliberately excludes', () => {
    // The per-member tests pin the set in the SHRINK direction only; this
    // pins that a name outside it stays scannable, or a perf-motivated
    // addition rejects legal manifests with every suite green.
    const worktree = temp();
    write(join(worktree, 'build', 'gen.ts'));
    expect(
      provide(
        worktree,
        ['src/change.ts'],
        manifest({
          rules: [{ paths: ['src/**'], relatedPaths: ['build/**'] }],
        }),
      )?.relatedPaths,
    ).toEqual(['build/gen.ts']);
  });

  it('dedupes identical scan roots before charging the scan bound', () => {
    // Two patterns sharing one static prefix scan the shared root ONCE; a
    // dedupe regression visits it per pattern and fails a legal manifest
    // closed at half the tree.
    const worktree = temp();
    const source = join(worktree, 'src');
    mkdirSync(source);
    for (let index = 0; index < MAX_GLOB_CANDIDATES / 2 + 1; index++) {
      mkdirSync(join(source, `d-${String(index).padStart(5, '0')}`));
    }
    writeFileSync(join(source, 'keep.ts'), '');
    expect(
      provide(
        worktree,
        ['src/change.ts'],
        manifest({
          rules: [{ paths: ['src/**'], relatedPaths: ['src/**', 'src/*.ts'] }],
        }),
      )?.relatedPaths,
    ).toEqual(['src/keep.ts']);
  }, 30_000);

  it('keeps sibling scan roots when one string-prefixes the other', () => {
    // The subsumption filter's trailing-`/` boundary: without it `src`
    // string-prefix-matches `sr` and every related file under it is
    // silently dropped.
    const worktree = temp();
    write(join(worktree, 'sr', 'a.ts'));
    write(join(worktree, 'src', 'b.ts'));
    expect(
      provide(
        worktree,
        ['src/change.ts'],
        manifest({
          rules: [{ paths: ['src/**'], relatedPaths: ['sr/**', 'src/**'] }],
        }),
      )?.relatedPaths,
    ).toEqual(['sr/a.ts', 'src/b.ts']);
  });

  it('fails closed when rule-filter matching work exceeds the budget', () => {
    // The filter bills the same length-based budget the expansion does: a
    // bulk change set crossed with schema-legal `paths` globs must fail
    // closed in this sibling stage too instead of stalling the step.
    const changed = Array.from(
      { length: 1024 },
      (_, index) =>
        `src/${'c'.repeat(240)}${String(index).padStart(4, '0')}.ts`,
    );
    const paths = Array.from(
      { length: 128 },
      (_, index) =>
        `src/${'p'.repeat(240)}${String(index).padStart(3, '0')}/**`,
    );
    expect(() =>
      provide(temp(), changed, manifest({ rules: [{ paths }] })),
    ).toThrow('paths matching work exceeds limit');
  }, 30_000);

  it('accepts matching work sitting exactly at the budget', () => {
    // The reject side pins an over-budget shape; this accept pin charges
    // exactly MAX_MATCH_WORK (pattern length x path length per attempt), so
    // a billing-multiplier or budget-halving regression fails a shape the
    // calibration admits. Every file misses every pattern, so the whole
    // budget is charged and nothing matches.
    const worktree = temp();
    const source = join(worktree, 'src');
    mkdirSync(source);
    const fileCount = 1024;
    for (let index = 0; index < fileCount; index++) {
      writeFileSync(
        join(source, `${'f'.repeat(53)}${String(index).padStart(4, '0')}.ts`),
        '',
      );
    }
    const patterns = Array.from(
      { length: 128 },
      (_, index) =>
        `src/**/${'m'.repeat(118)}${String(index).padStart(3, '0')}`,
    );
    const pathLength = `src/${'f'.repeat(53)}0000.ts`.length;
    expect(fileCount * patterns.length * pathLength * patterns[0].length).toBe(
      MAX_MATCH_WORK,
    );
    expect(
      provide(
        worktree,
        ['src/change.ts'],
        manifest({
          rules: [{ paths: ['src/**'], relatedPaths: patterns }],
        }),
      )?.relatedPaths,
    ).toEqual([]);
  }, 30_000);

  it('expands related globs whose static prefix contains ?', () => {
    // The prefix scanner must STOP at `?`: a break-condition regression
    // makes the scan root the literal `src/a?c`, which does not exist, and
    // the rule silently attaches nothing.
    const worktree = temp();
    write(join(worktree, 'src', 'a1c', 'x.ts'));
    write(join(worktree, 'src', 'a2c', 'y.ts'));
    expect(
      provide(
        worktree,
        ['src/change.ts'],
        manifest({
          rules: [{ paths: ['src/**'], relatedPaths: ['src/a?c/**'] }],
        }),
      )?.relatedPaths,
    ).toEqual(['src/a1c/x.ts', 'src/a2c/y.ts']);
  });

  // Permission-based failure injection is meaningless to root, and chmod(0)
  // does not block reads on Windows — the repo convention for this case.
  const isRoot = process.platform === 'win32' || process.getuid?.() === 0;

  it.skipIf(isRoot)(
    'fails closed when a scanned directory cannot be read',
    () => {
      // An unreadable subtree must fail the review closed, the way the
      // identity reader does — silently omitting it degrades the scan into
      // a complete-looking result with a hole in it.
      const worktree = temp();
      write(join(worktree, 'src', 'safe.ts'));
      const locked = join(worktree, 'src', 'locked');
      mkdirSync(locked);
      writeFileSync(join(locked, 'inner.ts'), '');
      chmodSync(locked, 0);
      try {
        expect(() =>
          provide(
            worktree,
            ['src/change.ts'],
            manifest({
              rules: [{ paths: ['src/**'], relatedPaths: ['src/**'] }],
            }),
          ),
        ).toThrow();
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );
});
