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
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_IDENTITY_BYTES,
  type RepositoryContextProvider,
} from './lib/repository-context.js';
import { repoContextCommand, runRepoContext } from './repo-context.js';
import { isolateHostGitConfig } from './lib/test-utils.js';

const tempRoots: string[] = [];

function temp(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'repo-context-')));
  tempRoots.push(root);
  return root;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Isolate the fixture from the developer's git environment, exactly like
// the sibling review-pipeline git fixtures: a global `commit.gpgsign=true`
// fails the suite for want of a key, and a global `core.hooksPath` runs the
// developer's hooks inside the test commits (`git worktree add` fires
// post-checkout too). The wrappers under test read `process.env` per call.
let gitIsolation: ReturnType<typeof isolateHostGitConfig>;

beforeEach(() => {
  gitIsolation = isolateHostGitConfig();
});

afterEach(() => {
  gitIsolation.dispose();
  // Every test builds fixture worktrees (several with initialized git
  // repos) in the OS tmpdir; leaking them accumulates toward ENOSPC on
  // long-lived machines.
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots.length = 0;
});

function initGit(root: string): void {
  execFileSync('git', ['init', '-q', '--template=', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  execFileSync('git', [
    '-C',
    root,
    'config',
    'core.hooksPath',
    join(root, '.no-such-hooks'),
  ]);
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
    const provide = vi.fn<RepositoryContextProvider['provide']>((input) => {
      expect(input.readIdentityFile('.review/identity')).toBe('base');
      return context();
    });
    const { outPath } = run(
      root,
      worktree,
      {
        files: [{ path: 'src/change.ts' }],
        mergeBaseSha: base,
      },
      [{ provide }],
    );
    // The provider MUST have run: an early return or a swallowed provider
    // error would otherwise keep every inner expect unexecuted and green.
    expect(provide).toHaveBeenCalledOnce();
    expect(readJson(outPath)).toEqual(context());
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

  it.skipIf(process.platform === 'win32')(
    'fails closed when the base identity symlink chain exceeds the hop ceiling',
    () => {
      // A committed symlink cycle is the only shape the hop counter guards
      // against; without the counter and the final throw it loops forever.
      const root = temp();
      const worktree = join(root, 'repository');
      initGit(worktree);
      mkdirSync(join(worktree, '.qwen'), { recursive: true });
      symlinkSync(
        'loop-b.json',
        join(worktree, '.qwen', 'review-context.json'),
      );
      symlinkSync(
        'review-context.json',
        join(worktree, '.qwen', 'loop-b.json'),
      );
      write(join(worktree, 'src', 'change.ts'), 'base\n');
      const base = commitAll(worktree);
      expect(() =>
        run(join(root, 'cycle'), worktree, {
          files: [{ path: 'src/change.ts' }],
          mergeBaseSha: base,
        }),
      ).toThrow('identity symlink chain is too deep');
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
    // both modes: CRLF normalised to LF, surrounding whitespace trimmed. The
    // interior CRLF is the pin — a single trailing one is stripped by trim
    // alone.
    const root = temp();
    const worktree = join(root, 'worktree');
    write(join(worktree, '.review', 'identity'), 'token\r\ntail\r\n');
    const localProvide = vi.fn<RepositoryContextProvider['provide']>(
      (input) => {
        expect(input.readIdentityFile('.review/identity')).toBe('token\ntail');
        return context();
      },
    );
    run(root, worktree, { files: [{ path: 'src/change.ts' }] }, [
      { provide: localProvide },
    ]);
    expect(localProvide).toHaveBeenCalledOnce();

    const repository = join(root, 'repository');
    initGit(repository);
    execFileSync('git', ['-C', repository, 'config', 'core.autocrlf', 'false']);
    write(join(repository, '.review', 'identity'), 'token\r\ntail\r\n');
    write(join(repository, 'src', 'change.ts'), 'base\n');
    const base = commitAll(repository);
    const prProvide = vi.fn<RepositoryContextProvider['provide']>((input) => {
      expect(input.readIdentityFile('.review/identity')).toBe('token\ntail');
      return context();
    });
    run(
      root,
      repository,
      { files: [{ path: 'src/change.ts' }], mergeBaseSha: base },
      [{ provide: prProvide }],
    );
    expect(prProvide).toHaveBeenCalledOnce();
  });

  it('treats an identity path resolving to the worktree root as absent', () => {
    const root = temp();
    const worktree = join(root, 'worktree');
    mkdirSync(worktree);
    symlinkSync(worktree, join(worktree, 'root-link'));
    const provide = vi.fn<RepositoryContextProvider['provide']>((input) => {
      expect(input.readIdentityFile('root-link')).toBeNull();
      return context();
    });
    run(root, worktree, { files: [{ path: 'src/change.ts' }] }, [{ provide }]);
    expect(provide).toHaveBeenCalledOnce();
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
    const provide = vi.fn<RepositoryContextProvider['provide']>((input) => {
      // The provider must receive the LINKED worktree, not the main
      // repository root the plan's --git-common-dir resolves to.
      expect(input.worktree).toBe(realpathSync(linked));
      return context();
    });
    const { planPath, outPath } = run(
      root,
      linked,
      {
        files: [{ path: 'src/change.ts' }],
        worktreePath: '../linked',
      },
      [{ provide }],
    );
    expect(provide).toHaveBeenCalledOnce();
    expect(readJson(outPath)).toEqual(context());
    expect(readJson(planPath)).toHaveProperty('repositoryContext', context());
  });

  it('rejects a recorded worktree path that matches no checkout', () => {
    // The guard's rejection branch: a plan recorded for one checkout must
    // not be served identity reads from a different worktree.
    const root = temp();
    const worktree = join(root, 'worktree');
    mkdirSync(worktree);
    expect(() =>
      run(root, worktree, {
        files: [{ path: 'src/change.ts' }],
        worktreePath: '../somewhere-else',
      }),
    ).toThrow('does not match plan.worktreePath');
  });

  it('degrades to a null artifact when the base identity path is a directory', () => {
    // `git show <base>:<dir>` exits 0 with the tree listing; the guard must
    // map a directory at the identity path to null — worktree mode's
    // `isFile() === false` — instead of feeding the listing to the parser,
    // whose throw would fail the whole review closed over a clean degrade.
    const root = temp();
    const worktree = join(root, 'repository');
    initGit(worktree);
    write(join(worktree, '.qwen', 'review-context.json', 'inner.txt'), '{}\n');
    write(join(worktree, 'src', 'change.ts'), 'base\n');
    const base = commitAll(worktree);
    const { outPath } = run(root, worktree, {
      files: [{ path: 'src/change.ts' }],
      mergeBaseSha: base,
    });
    expect(readJson(outPath)).toBeNull();
  });

  it.skipIf(process.platform === 'win32')(
    'reads a broken trailing-slash identity symlink as absent in both modes',
    () => {
      // A target ending in `/` that resolves to a regular file fails
      // ENOTDIR on disk (local mode); base mode must degrade the same way
      // instead of dropping the empty segment and returning content.
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
        'manifest.json/',
        join(worktree, '.qwen', 'review-context.json'),
      );
      write(join(worktree, 'src', 'change.ts'), 'base\n');
      const base = commitAll(worktree);

      const pr = run(join(root, 'pr'), worktree, {
        files: [{ path: 'src/change.ts' }],
        mergeBaseSha: base,
      });
      expect(readJson(pr.outPath)).toBeNull();
      const local = run(join(root, 'local'), worktree, {
        files: [{ path: 'src/change.ts' }],
      });
      expect(readJson(local.outPath)).toBeNull();
    },
  );

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
    // Names AND the `demandOption` flags — the flags are what makes the
    // options required; without them the handler dies on a raw TypeError
    // instead of yargs' clean missing-argument usage error.
    expect(
      option.mock.calls.map(([name, config]) => [
        name,
        (config as { demandOption?: boolean }).demandOption,
      ]),
    ).toEqual([
      ['plan', true],
      ['worktree', true],
      ['out', true],
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

  it('preserves plan fields the command does not know across the rewrite', () => {
    // The rewrite must carry every field downstream steps read — `files[]`,
    // `effort`, and anything else the plan holds — not just
    // `repositoryContext`.
    const root = temp();
    const worktree = join(root, 'worktree');
    mkdirSync(worktree);
    const { planPath } = run(
      root,
      worktree,
      {
        files: [{ path: 'src/change.ts' }],
        effort: 'high',
        customField: 'kept',
      },
      [{ provide: () => context() }],
    );
    expect(readJson(planPath)).toMatchObject({
      files: [{ path: 'src/change.ts' }],
      effort: 'high',
      customField: 'kept',
      repositoryContext: context(),
    });
  });

  it('rejects a corrupted plan whose files field is not an array', () => {
    // The sibling gate for item-level shape: a corrupted plan must exit
    // fail-closed, not produce empty changedPaths and a null artifact.
    const root = temp();
    const worktree = join(root, 'worktree');
    mkdirSync(worktree);
    expect(() => run(root, worktree, { files: 'oops' })).toThrow(
      'plan.files must be an array',
    );
  });

  it('creates a missing --out parent directory', () => {
    const root = temp();
    const worktree = join(root, 'worktree');
    mkdirSync(worktree);
    const planPath = planAt(root, { files: [{ path: 'src/change.ts' }] });
    const outPath = join(root, 'fresh-subdir', 'context.json');
    runRepoContext({ plan: planPath, worktree, out: outPath }, [
      { provide: () => context() },
    ]);
    expect(readJson(outPath)).toEqual(context());
  });

  it('fails closed when the local identity exceeds the size limit', () => {
    // The identity read is size-capped BEFORE its content is parsed; an
    // oversized manifest must throw rather than masquerade as readable.
    const root = temp();
    const worktree = join(root, 'worktree');
    write(
      join(worktree, '.qwen', 'review-context.json'),
      `"${'x'.repeat(MAX_IDENTITY_BYTES)}"`,
    );
    expect(() =>
      run(root, worktree, { files: [{ path: 'src/change.ts' }] }),
    ).toThrow('exceeds the size limit');
  });

  // Windows symlink creation needs elevated privileges.
  it.skipIf(process.platform === 'win32')(
    'canonicalizes a symlinked --worktree argument',
    () => {
      // Local-mode containment compares fully realpathed identity reads
      // against the canonicalised argument; with an un-canonicalised
      // argument whose ancestor is a symlink (macOS /tmp, linked mounts or
      // home dirs) every identity read computes an escaping path and the
      // whole review fails closed.
      const root = temp();
      const worktree = join(root, 'worktree');
      write(join(worktree, '.review', 'identity'), 'local\n');
      const link = join(root, 'worktree-link');
      symlinkSync(worktree, link);
      const provide = vi.fn<RepositoryContextProvider['provide']>((input) => {
        expect(input.worktree).toBe(realpathSync(worktree));
        expect(input.readIdentityFile('.review/identity')).toBe('local');
        return context();
      });
      run(root, link, { files: [{ path: 'src/change.ts' }] }, [{ provide }]);
      expect(provide).toHaveBeenCalledOnce();
    },
  );

  it('attaches context from a SHA-256 repository', () => {
    // The mergeBaseSha validator's 64-hex alternative exists for SHA-256
    // repositories; without this pin a future simplification to 40-hex
    // ships green and hard-fails every PR review in such a repository on a
    // correctly recorded value.
    const root = temp();
    const worktree = join(root, 'repository');
    try {
      execFileSync('git', [
        'init',
        '-q',
        '--template=',
        '--object-format=sha256',
        worktree,
      ]);
    } catch {
      return; // git < 2.29 has no object format
    }
    execFileSync('git', [
      '-C',
      worktree,
      'config',
      'user.email',
      'test@example.com',
    ]);
    execFileSync('git', ['-C', worktree, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', worktree, 'config', 'commit.gpgsign', 'false']);
    writeManifest(worktree);
    write(join(worktree, 'src', 'change.ts'), 'base\n');
    const base = commitAll(worktree);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(
      readJson(
        run(join(root, 'sha256'), worktree, {
          files: [{ path: 'src/change.ts' }],
          mergeBaseSha: base,
        }).outPath,
      ),
    ).toEqual(manifestContext());
  });

  it.skipIf(process.platform === 'win32')(
    'reads a `.`-targeted identity symlink as absent in both modes',
    () => {
      // A target like `a/.` walks THROUGH `a`, so the kernel fails ENOTDIR
      // when `a` is a file; base mode must degrade to null exactly like the
      // worktree reader instead of dropping the `.` and reading the blob —
      // the "base mode reads strictly less, never more" invariant.
      const root = temp();
      const worktree = join(root, 'repository');
      initGit(worktree);
      write(join(worktree, '.qwen', 'a'), '{}');
      symlinkSync('a/.', join(worktree, '.qwen', 'review-context.json'));
      write(join(worktree, 'src', 'change.ts'), 'base\n');
      const base = commitAll(worktree);
      const pr = run(join(root, 'pr'), worktree, {
        files: [{ path: 'src/change.ts' }],
        mergeBaseSha: base,
      });
      expect(readJson(pr.outPath)).toBeNull();
      const local = run(join(root, 'local'), worktree, {
        files: [{ path: 'src/change.ts' }],
      });
      expect(readJson(local.outPath)).toBeNull();
    },
  );
});
