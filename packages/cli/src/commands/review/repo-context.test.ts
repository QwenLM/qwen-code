/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import type { RepositoryContextProvider } from './lib/repository-context.js';
import { repoContextCommand, runRepoContext } from './repo-context.js';

function temp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'repo-context-')));
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function initGit(root: string): void {
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
}

function commitAll(root: string): string {
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'snapshot']);
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
}

function context(provider = 'fake-provider') {
  return {
    version: 1 as const,
    provider,
    label: 'Fake project',
    domains: ['runtime'],
    relatedPaths: ['src/related.ts'],
    recommendedTests: ['test:runtime'],
    requiredConfigurations: ['debug'],
    requiredAgents: ['test-matrix' as const],
    unverifiedDimensions: ['Alternate runtime was not exercised'],
    verificationNotes: ['Use the repository native test runner'],
  };
}

function planAt(root: string, plan: object): string {
  const path = join(root, 'plan.json');
  write(path, `${JSON.stringify(plan)}\n`);
  return path;
}

function writeManifest(worktree: string, paths = ['src/**']): void {
  write(
    join(worktree, '.qwen', 'review-context.json'),
    JSON.stringify({
      version: 1,
      label: 'Manifest project',
      rules: [{ paths, domains: ['runtime'] }],
    }),
  );
}

function manifestContext() {
  return {
    version: 1,
    provider: 'manifest',
    label: 'Manifest project',
    domains: ['runtime'],
    relatedPaths: [],
    recommendedTests: [],
    requiredConfigurations: [],
    requiredAgents: [],
    unverifiedDimensions: [],
    verificationNotes: [],
  };
}

function run(
  root: string,
  worktree: string,
  plan: object,
  providers?: readonly RepositoryContextProvider[],
): { planPath: string; outPath: string } {
  const planPath = planAt(root, plan);
  const outPath = join(root, 'context.json');
  if (providers === undefined) {
    runRepoContext({ plan: planPath, worktree, out: outPath });
  } else {
    runRepoContext({ plan: planPath, worktree, out: outPath }, providers);
  }
  return { planPath, outPath };
}

describe('repo-context providers and trust boundary', () => {
  it('writes null and clears stale context when no provider matches', () => {
    const root = temp();
    const worktree = join(root, 'worktree');
    mkdirSync(worktree);
    const { planPath, outPath } = run(
      root,
      worktree,
      {
        files: [{ path: 'src/change.ts' }],
        repositoryContext: context(),
      },
      [],
    );
    expect(readJson(outPath)).toBeNull();
    expect(readJson(planPath)).not.toHaveProperty('repositoryContext');
  });

  it('passes sorted unique changed paths and local identity to a provider', () => {
    const root = temp();
    const worktree = join(root, 'worktree');
    write(join(worktree, '.review', 'identity'), 'local\n');
    const provide = vi.fn<RepositoryContextProvider['provide']>((input) => {
      expect(input.worktree).toBe(realpathSync(worktree));
      expect(input.changedPaths).toEqual(['src/a.ts', 'src/b.ts']);
      expect(input.readIdentityFile('.review/identity')).toBe('local');
      expect(input.readIdentityFile('.review/missing')).toBeNull();
      return context();
    });
    const { planPath, outPath } = run(
      root,
      worktree,
      {
        files: [
          { path: 'src/b.ts' },
          { path: 'src/a.ts' },
          { path: 'src/a.ts' },
        ],
      },
      [{ provide }],
    );
    expect(provide).toHaveBeenCalledOnce();
    expect(readJson(outPath)).toEqual(context());
    expect(readJson(planPath)).toHaveProperty('repositoryContext', context());
  });

  it('uses the trusted base manifest for pull-request opt in and opt out', () => {
    const root = temp();
    const worktree = join(root, 'repository');
    initGit(worktree);
    writeManifest(worktree);
    write(join(worktree, 'src', 'change.ts'), 'base\n');
    const base = commitAll(worktree);
    // A second commit makes HEAD != mergeBaseSha: a reader that took the
    // manifest from HEAD (instead of the recorded base) would see the
    // forged non-matching scope and drop the context.
    writeManifest(worktree, ['docs/**']);
    commitAll(worktree);
    expect(
      readJson(
        run(join(root, 'base-enabled'), worktree, {
          files: [{ path: 'src/change.ts' }],
          mergeBaseSha: base,
        }).outPath,
      ),
    ).toEqual(manifestContext());

    const second = join(root, 'second');
    initGit(second);
    writeManifest(second, ['docs/**']);
    write(join(second, 'src', 'change.ts'), 'base\n');
    const disabledBase = commitAll(second);
    // Head-side commit carries a matching manifest that must never opt IN.
    writeManifest(second);
    commitAll(second);
    expect(
      readJson(
        run(join(root, 'base-disabled'), second, {
          files: [{ path: 'src/change.ts' }],
          mergeBaseSha: disabledBase,
        }).outPath,
      ),
    ).toBeNull();
  });

  it('reads pull-request identity only from the trusted base commit', () => {
    const root = temp();
    const worktree = join(root, 'repository');
    initGit(worktree);
    write(join(worktree, '.review', 'identity'), 'base\n');
    write(join(worktree, 'src', 'change.ts'), 'base\n');
    const base = commitAll(worktree);
    // Commit the forged head-side identity so HEAD != mergeBaseSha: a reader
    // keyed on HEAD would return 'head' and fail the assertion.
    write(join(worktree, '.review', 'identity'), 'head\n');
    commitAll(worktree);
    const provider: RepositoryContextProvider = {
      provide(input) {
        expect(input.readIdentityFile('.review/identity')).toBe('base');
        return context();
      },
    };
    run(
      root,
      worktree,
      {
        files: [{ path: 'src/change.ts' }],
        mergeBaseSha: base,
      },
      [provider],
    );
  });

  it('does not let the current tree opt in or opt out of base identity', () => {
    const root = temp();
    const worktree = join(root, 'repository');
    initGit(worktree);
    write(join(worktree, '.review', 'identity'), 'enabled\n');
    write(join(worktree, 'src', 'change.ts'), 'base\n');
    const base = commitAll(worktree);
    write(join(worktree, '.review', 'identity'), 'disabled\n');
    commitAll(worktree);
    const enabled: RepositoryContextProvider = {
      provide(input) {
        return input.readIdentityFile('.review/identity') === 'enabled'
          ? context()
          : null;
      },
    };
    expect(
      readJson(
        run(
          join(root, 'base-enabled'),
          worktree,
          { files: [{ path: 'src/change.ts' }], mergeBaseSha: base },
          [enabled],
        ).outPath,
      ),
    ).toEqual(context());

    const second = join(root, 'second');
    initGit(second);
    write(join(second, '.review', 'identity'), 'disabled\n');
    write(join(second, 'src', 'change.ts'), 'base\n');
    const disabledBase = commitAll(second);
    write(join(second, '.review', 'identity'), 'enabled\n');
    commitAll(second);
    expect(
      readJson(
        run(
          join(root, 'base-disabled'),
          second,
          {
            files: [{ path: 'src/change.ts' }],
            mergeBaseSha: disabledBase,
          },
          [enabled],
        ).outPath,
      ),
    ).toBeNull();
  });

  it('writes null when the identity is absent at the base commit', () => {
    // "Absent at the base" is a definite state (`ls-tree` exits 0 with no
    // output), distinct from "git failed" — and a head-side manifest never
    // substitutes for it: deleting the existence probe would make `git show`
    // throw and this test fail instead of returning null.
    const root = temp();
    const worktree = join(root, 'repository');
    initGit(worktree);
    write(join(worktree, 'src', 'change.ts'), 'base\n');
    const base = commitAll(worktree);
    // Commit the head-side manifest: HEAD != mergeBaseSha, so a probe keyed
    // on HEAD would find the manifest and fail closed on the base read.
    writeManifest(worktree);
    commitAll(worktree);
    const { planPath, outPath } = run(root, worktree, {
      files: [{ path: 'src/change.ts' }],
      mergeBaseSha: base,
    });
    expect(readJson(outPath)).toBeNull();
    expect(readJson(planPath)).not.toHaveProperty('repositoryContext');
  });

  // Committed symlink objects are not portable to Windows runners.
  it.skipIf(process.platform === 'win32')(
    'follows a committed symlink identity like the worktree reader',
    () => {
      const root = temp();
      const worktree = join(root, 'repository');
      initGit(worktree);
      write(
        join(worktree, '.qwen', 'manifest.json'),
        JSON.stringify({
          version: 1,
          label: 'Manifest project',
          rules: [{ paths: ['src/**'], domains: ['runtime'] }],
        }),
      );
      symlinkSync(
        'manifest.json',
        join(worktree, '.qwen', 'review-context.json'),
      );
      write(join(worktree, 'src', 'change.ts'), 'base\n');
      const base = commitAll(worktree);

      expect(
        readJson(
          run(join(root, 'pr'), worktree, {
            files: [{ path: 'src/change.ts' }],
            mergeBaseSha: base,
          }).outPath,
        ),
      ).toEqual(manifestContext());
      expect(
        readJson(
          run(join(root, 'local'), worktree, {
            files: [{ path: 'src/change.ts' }],
          }).outPath,
        ),
      ).toEqual(manifestContext());
    },
  );

  it.skipIf(process.platform === 'win32')(
    'fails closed when a committed identity symlink escapes the tree',
    () => {
      const root = temp();
      const worktree = join(root, 'repository');
      initGit(worktree);
      write(join(worktree, 'outside.json'), '{}');
      mkdirSync(join(worktree, '.qwen'), { recursive: true });
      symlinkSync(
        '../../outside.json',
        join(worktree, '.qwen', 'review-context.json'),
      );
      write(join(worktree, 'src', 'change.ts'), 'base\n');
      const base = commitAll(worktree);
      expect(() =>
        run(join(root, 'escape'), worktree, {
          files: [{ path: 'src/change.ts' }],
          mergeBaseSha: base,
        }),
      ).toThrow('escapes the worktree');
    },
  );

  it('degrades to a null artifact when the base fetch failed', () => {
    // merge-base documents the state as not fatal, fetch-pr warns and
    // continues, base-tree refuses the possibly stale sha — repo-context
    // degrades like the unresolved base instead of halting the review.
    const root = temp();
    const worktree = join(root, 'repository');
    initGit(worktree);
    writeManifest(worktree);
    write(join(worktree, 'src', 'change.ts'), 'base\n');
    const base = commitAll(worktree);
    const provide = vi.fn<RepositoryContextProvider['provide']>(() =>
      context(),
    );
    const { planPath, outPath } = run(
      root,
      worktree,
      {
        files: [{ path: 'src/change.ts' }],
        mergeBaseSha: base,
        baseFetchFailed: true,
      },
      [{ provide }],
    );
    expect(provide).not.toHaveBeenCalled();
    expect(readJson(outPath)).toBeNull();
    expect(readJson(planPath)).not.toHaveProperty('repositoryContext');
  });

  it('fails closed for an invalid or unresolvable base', () => {
    const root = temp();
    const worktree = join(root, 'repository');
    initGit(worktree);
    write(join(worktree, 'src', 'change.ts'), 'base\n');
    commitAll(worktree);
    const provider: RepositoryContextProvider = { provide: () => context() };
    expect(() =>
      run(
        join(root, 'invalid'),
        worktree,
        { files: [{ path: 'src/change.ts' }], mergeBaseSha: 'nope' },
        [provider],
      ),
    ).toThrow('mergeBaseSha is invalid');
    expect(() =>
      run(
        join(root, 'stale'),
        worktree,
        {
          files: [{ path: 'src/change.ts' }],
          mergeBaseSha: '0'.repeat(40),
        },
        [provider],
      ),
    ).toThrow('cannot be resolved');
  });

  it('writes null without consulting the worktree when the base never resolved', () => {
    // fetch-pr records `mergeBaseSha: null` and degrades rather than failing
    // the review; repo-context must degrade the same way — and MUST NOT fall
    // back to the worktree reader, which would take the manifest from the PR
    // head, the exact read the trust boundary forbids.
    const root = temp();
    const worktree = join(root, 'repository');
    initGit(worktree);
    writeManifest(worktree); // a head-side manifest that must never be read
    write(join(worktree, 'src', 'change.ts'), 'base\n');
    commitAll(worktree);
    const provide = vi.fn<RepositoryContextProvider['provide']>(() =>
      context(),
    );

    const first = run(
      join(root, 'null-base'),
      worktree,
      { files: [{ path: 'src/change.ts' }], mergeBaseSha: null },
      [{ provide }],
    );
    expect(provide).not.toHaveBeenCalled();
    expect(readJson(first.outPath)).toBeNull();
    expect(readJson(first.planPath)).not.toHaveProperty('repositoryContext');

    // A failed base fetch with no resolved sha degrades the same way: there
    // is nothing stale, and nothing to trust.
    const second = run(
      join(root, 'null-base-fetch-failed'),
      worktree,
      {
        files: [{ path: 'src/change.ts' }],
        mergeBaseSha: null,
        baseFetchFailed: true,
      },
      [{ provide }],
    );
    expect(provide).not.toHaveBeenCalled();
    expect(readJson(second.outPath)).toBeNull();
  });

  it('normalizes identity content identically in local and pull-request modes', () => {
    // A provider that exact-compares a marker file must get the same value in
    // both modes: CRLF normalised to LF, surrounding whitespace trimmed.
    const root = temp();
    const worktree = join(root, 'worktree');
    write(join(worktree, '.review', 'identity'), 'token\r\n');
    const localProvider: RepositoryContextProvider = {
      provide(input) {
        expect(input.readIdentityFile('.review/identity')).toBe('token');
        return context();
      },
    };
    run(root, worktree, { files: [{ path: 'src/change.ts' }] }, [
      localProvider,
    ]);

    const repository = join(root, 'repository');
    initGit(repository);
    execFileSync('git', ['-C', repository, 'config', 'core.autocrlf', 'false']);
    write(join(repository, '.review', 'identity'), 'token\r\n');
    write(join(repository, 'src', 'change.ts'), 'base\n');
    const base = commitAll(repository);
    const prProvider: RepositoryContextProvider = {
      provide(input) {
        expect(input.readIdentityFile('.review/identity')).toBe('token');
        return context();
      },
    };
    run(
      root,
      repository,
      { files: [{ path: 'src/change.ts' }], mergeBaseSha: base },
      [prProvider],
    );
  });

  it('treats an identity path resolving to the worktree root as absent', () => {
    const root = temp();
    const worktree = join(root, 'worktree');
    mkdirSync(worktree);
    symlinkSync(worktree, join(worktree, 'root-link'));
    const provider: RepositoryContextProvider = {
      provide(input) {
        expect(input.readIdentityFile('root-link')).toBeNull();
        return context();
      },
    };
    run(root, worktree, { files: [{ path: 'src/change.ts' }] }, [provider]);
  });

  // Permission-based failure injection is meaningless to root, and chmod(0)
  // does not block reads on Windows — the repo convention for this case.
  const isRoot = process.platform === 'win32' || process.getuid?.() === 0;

  it.skipIf(isRoot)(
    'fails closed when a present local identity file cannot be read',
    () => {
      const root = temp();
      const worktree = join(root, 'worktree');
      const identity = join(worktree, '.review', 'identity');
      write(identity, 'token\n');
      chmodSync(identity, 0);
      try {
        expect(() =>
          run(root, worktree, { files: [{ path: 'src/change.ts' }] }, [
            {
              provide(input) {
                input.readIdentityFile('.review/identity');
                return context();
              },
            },
          ]),
        ).toThrow();
      } finally {
        chmodSync(identity, 0o644);
      }
    },
  );

  it.skipIf(isRoot)('keeps the artifact when the plan write fails', () => {
    // Write ordering is artifact-then-plan on purpose: when the plan write is
    // the one that fails, the artifact has landed but the plan is untouched,
    // so the two never disagree about a run — the next invocation rewrites
    // both.
    const root = temp();
    const worktree = join(root, 'worktree');
    mkdirSync(worktree);
    const planDir = join(root, 'plan-dir');
    mkdirSync(planDir);
    const planPath = join(planDir, 'plan.json');
    write(
      planPath,
      `${JSON.stringify({ files: [{ path: 'src/change.ts' }] })}\n`,
    );
    const outPath = join(root, 'context.json');
    const before = readFileSync(planPath, 'utf8');
    chmodSync(planDir, 0o555);
    try {
      expect(() =>
        runRepoContext({ plan: planPath, worktree, out: outPath }, [
          { provide: () => context() },
        ]),
      ).toThrow();
      expect(readJson(outPath)).toEqual(context());
      expect(readFileSync(planPath, 'utf8')).toBe(before);
    } finally {
      chmodSync(planDir, 0o755);
    }
  });

  it('supports recorded linked-worktree paths', () => {
    const root = temp();
    const repository = join(root, 'repository');
    initGit(repository);
    write(join(repository, 'src', 'change.ts'), 'base\n');
    commitAll(repository);
    const linked = join(root, 'linked');
    execFileSync('git', ['-C', repository, 'worktree', 'add', '-q', linked]);
    run(
      root,
      linked,
      {
        files: [{ path: 'src/change.ts' }],
        worktreePath: '../linked',
      },
      [{ provide: () => context() }],
    );
  });

  it('rejects identity traversal and symlink escapes', () => {
    const root = temp();
    const worktree = join(root, 'worktree');
    mkdirSync(worktree);
    write(join(root, 'outside'), 'secret\n');
    symlinkSync(join(root, 'outside'), join(worktree, 'identity'));
    for (const identityPath of ['../outside', '/outside', 'identity']) {
      expect(() =>
        run(
          join(root, identityPath.replaceAll('/', '_')),
          worktree,
          { files: [{ path: 'src/change.ts' }] },
          [
            {
              provide(input) {
                input.readIdentityFile(identityPath);
                return context();
              },
            },
          ],
        ),
      ).toThrow();
    }
  });

  it('skips unsafe changed paths instead of aborting the step', () => {
    // Changed paths are only matched against manifest globs, never opened, so
    // an unsafe-but-real path (a backslash is a legal POSIX filename byte)
    // must not kill a step that runs on every review — it just cannot match.
    const root = temp();
    const worktree = join(root, 'worktree');
    mkdirSync(worktree);
    const provide = vi.fn<RepositoryContextProvider['provide']>((input) => {
      expect(input.changedPaths).toEqual(['src/ok.ts']);
      return context();
    });
    run(
      root,
      worktree,
      { files: [{ path: '../secret' }, { path: 'src/ok.ts' }] },
      [{ provide }],
    );
    expect(provide).toHaveBeenCalledOnce();
  });

  it('still rejects a corrupted plan whose file paths are not strings', () => {
    const root = temp();
    const worktree = join(root, 'worktree');
    mkdirSync(worktree);
    expect(() => run(root, worktree, { files: [{ path: 42 }] })).toThrow(
      'plan.files[0].path is invalid',
    );
  });

  it('rejects plan/out aliases and preserves the plan on artifact failure', () => {
    const root = temp();
    const worktree = join(root, 'worktree');
    mkdirSync(worktree);
    const planPath = planAt(root, { files: [{ path: 'src/change.ts' }] });
    expect(() =>
      runRepoContext({ plan: planPath, worktree, out: planPath }, [
        { provide: () => context() },
      ]),
    ).toThrow('--out must differ');

    const alias = join(root, 'alias.json');
    linkSync(planPath, alias);
    expect(() =>
      runRepoContext({ plan: planPath, worktree, out: alias }, [
        { provide: () => context() },
      ]),
    ).toThrow('--out must differ');

    const before = readFileSync(planPath, 'utf8');
    const outDirectory = join(root, 'out-directory');
    mkdirSync(outDirectory);
    expect(() =>
      runRepoContext({ plan: planPath, worktree, out: outDirectory }, [
        { provide: () => context() },
      ]),
    ).toThrow();
    expect(readFileSync(planPath, 'utf8')).toBe(before);
  });

  it('rejects invalid provider output', () => {
    const root = temp();
    const worktree = join(root, 'worktree');
    mkdirSync(worktree);
    expect(() =>
      run(root, worktree, { files: [{ path: 'src/change.ts' }] }, [
        {
          provide: () =>
            ({
              ...context(),
              requiredAgents: ['unknown-role'],
            }) as never,
        },
      ]),
    ).toThrow('unsupported role');
  });

  it('declares all required command options and uses the default manifest provider', () => {
    const option = vi.fn().mockReturnThis();
    const built = (repoContextCommand.builder as (yargs: unknown) => unknown)({
      option,
    });
    expect(built).toBeDefined();
    expect(option.mock.calls.map(([name]) => name)).toEqual([
      'plan',
      'worktree',
      'out',
    ]);

    const root = temp();
    const worktree = join(root, 'worktree');
    writeManifest(worktree);
    const plan = planAt(root, { files: [{ path: 'src/change.ts' }] });
    const out = join(root, 'context.json');
    (repoContextCommand.handler as (args: unknown) => void)({
      plan,
      worktree,
      out,
    });
    expect(readJson(out)).toEqual(manifestContext());
  });
});
