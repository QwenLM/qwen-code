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
  ])('fails closed for %s', (_name, content) => {
    expect(() => provide(temp(), ['src/change.ts'], content)).toThrow();
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

  it('produces deterministic code-unit sorted output', () => {
    const worktree = temp();
    write(join(worktree, 'src', 'z.ts'));
    write(join(worktree, 'src', 'A.ts'));
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
    expect(first?.relatedPaths).toEqual(['src/A.ts', 'src/z.ts']);
  });
});
