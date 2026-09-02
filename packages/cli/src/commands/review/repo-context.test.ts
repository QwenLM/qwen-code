/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  chmodSync,
  cpSync,
  linkSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_IDENTITY_BYTES,
  type RepositoryContextProvider,
} from './lib/repository-context.js';
import {
  commitPlanPreservingEpoch,
  repoContextCommand,
  runRepoContext,
} from './repo-context.js';
import { stringifyPlanReport } from './lib/report.js';
import { isolateHostGitConfig } from './lib/test-utils.js';
import {
  appendRunSession,
  priorSessionIds,
  recordResume,
} from './lib/run-ledger.js';

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

  it('fails actionably when the worktree vanished mid-review (#9205)', () => {
    // A concurrent same-PR cleanup (or any delete) removes the worktree a
    // review is running on; the bare `ENOENT … lstat` realpathSync produced
    // named neither the cause nor the remedy.
    const root = temp();
    const planPath = planAt(root, { files: [] });
    expect(() =>
      runRepoContext(
        {
          plan: planPath,
          worktree: join(root, 'missing-worktree'),
          out: join(root, 'context.json'),
        },
        [],
      ),
    ).toThrow(
      'is missing — recreate the review worktree ' +
        '(for PR targets: re-run `qwen review fetch-pr`)',
    );
  });

  it('keeps the precise error for a worktree path that is not a directory', () => {
    // A regular file at --worktree is NOT a missing worktree: converting it
    // to the "missing" remedy would point at a fix that cannot help.
    const root = temp();
    const planPath = planAt(root, { files: [] });
    const notADirectory = join(root, 'worktree-file');
    write(notADirectory, 'not a directory\n');
    expect(() =>
      runRepoContext(
        {
          plan: planPath,
          worktree: notADirectory,
          out: join(root, 'context.json'),
        },
        [],
      ),
    ).toThrow('worktree is not a directory');
  });

  // Windows/libuv maps a regular file as an intermediate path component
  // to ENOENT, never ENOTDIR — see the measured record in
  // serve/fs/paths.ts — so the kernel shape this pins is POSIX-only.
  it.skipIf(process.platform === 'win32')(
    'rethrows ENOTDIR when a regular file is an intermediate path component',
    () => {
      // `--worktree <file>/subdir` is a malformed argument, not a missing
      // worktree: the "re-run fetch-pr" remedy cannot fix it, and absorbing
      // ENOTDIR into the missing-worktree message would lose the diagnosis
      // that names the real cause.
      const root = temp();
      const planPath = planAt(root, { files: [] });
      const blocker = join(root, 'blocker');
      write(blocker, 'not a directory\n');
      expect(() =>
        runRepoContext(
          {
            plan: planPath,
            worktree: join(blocker, 'wt'),
            out: join(root, 'context.json'),
          },
          [],
        ),
      ).toThrow('ENOTDIR');
    },
  );

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

  // On Windows `mountRootFor` refuses every absolute path (a drive letter is a
  // colon), so containment cannot exist there and this pair of cases has no
  // answer to assert.
  const itWhereContainmentExists = it.skipIf(process.platform === 'win32');

  itWhereContainmentExists(
    'refuses to read identity files through a rewritten review-worktree gitfile',
    () => {
      // This command's whole point is that the identity files come from the
      // MERGE BASE rather than from the PR head — and every read it makes
      // (`--git-common-dir`, `cat-file -e`, `ls-tree`, `show <base>:<path>`)
      // resolves the repository through the review worktree's own `.git`,
      // which sits inside the directory the sandbox hands the reviewed code
      // read-write. Read through a rewritten pointer, the "merge base"
      // identity is whatever the PR author committed into a repository they
      // planted, and the boundary is decoration.
      const root = temp();
      const repository = join(root, 'repository');
      initGit(repository);
      write(join(repository, 'src', 'change.ts'), 'base\n');
      const base = commitAll(repository);
      const worktree = join(repository, '.qwen', 'tmp', 'review-pr-1');
      mkdirSync(dirname(worktree), { recursive: true });
      execFileSync('git', [
        '-C',
        repository,
        'worktree',
        'add',
        '-q',
        '--detach',
        worktree,
        'HEAD',
      ]);
      // The plant: an admin entry copied beside the tree, inside the same
      // temp dir, with git's own BARE backpointer so the round-trip gates
      // this command inherits all agree with it.
      const realEntry = join(repository, '.git', 'worktrees', 'review-pr-1');
      const planted = join(repository, '.qwen', 'tmp', '.evil-git');
      cpSync(realEntry, planted, { recursive: true });
      writeFileSync(
        join(planted, 'commondir'),
        `${join(repository, '.git')}\n`,
      );
      writeFileSync(join(planted, 'gitdir'), `${join(worktree, '.git')}\n`);
      rmSync(join(worktree, '.git'), { force: true });
      writeFileSync(join(worktree, '.git'), `gitdir: ${planted}\n`);

      expect(() =>
        run(root, worktree, {
          files: [{ path: 'src/change.ts' }],
          mergeBaseSha: base,
        }),
      ).toThrow(/refusing to read the repository context/);
    },
  );

  itWhereContainmentExists(
    'still reads a review worktree whose pointer is the one the pipeline wrote',
    () => {
      // The admit arm: the geometry the gate above refuses is the SAME
      // geometry every PR review runs in, so a gate that refused on location
      // alone would refuse every review.
      const root = temp();
      const repository = join(root, 'repository');
      initGit(repository);
      // Committed, because the identity read this command makes is
      // `git show <mergeBase>:<path>` — a manifest that exists only in the
      // working tree is the HEAD-side one the trust boundary refuses.
      writeManifest(repository);
      write(join(repository, 'src', 'change.ts'), 'base\n');
      const base = commitAll(repository);
      const worktree = join(repository, '.qwen', 'tmp', 'review-pr-1');
      mkdirSync(dirname(worktree), { recursive: true });
      execFileSync('git', [
        '-C',
        repository,
        'worktree',
        'add',
        '-q',
        '--detach',
        worktree,
        'HEAD',
      ]);

      const { outPath } = run(root, worktree, {
        files: [{ path: 'src/change.ts' }],
        mergeBaseSha: base,
      });
      expect(readJson(outPath)).toEqual(manifestContext());
    },
  );

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

  it('rejects an --out whose canonical identity equals an absent --plan', () => {
    // The hardened absent-side semantics, untested by the alias cases above
    // (which all compare two EXISTING paths): neither file is on disk yet,
    // but --out is spelled through a symlinked directory component, so its
    // canonical identity is the plan's. A revert to the old local sameFile —
    // false whenever a side is absent — passes green and re-opens the
    // overwrite this guard closes.
    const root = temp();
    const worktree = join(root, 'worktree');
    mkdirSync(worktree);
    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'link'));
    expect(() =>
      runRepoContext(
        {
          plan: join(root, 'real/plan.json'),
          worktree,
          out: join(root, 'link/plan.json'),
        },
        [{ provide: () => context() }],
      ),
    ).toThrow('--out must differ');
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

describe('the plan mtime is the run epoch — enrichment must not advance it', () => {
  // The run-session ledger, deadline stamps, prompt records and transcripts
  // are all fenced on the plan's mtime, and fetch-pr's session entry lands an
  // orchestrator turn BEFORE this command runs. A rewrite that advanced the
  // mtime re-keyed the epoch mid-run and orphaned everything recorded before
  // it — a resumed run then saw no prior evidence at all.
  it('preserves the plan mtime across the enrichment rewrite', () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-context-epoch-'));
    try {
      const worktree = join(root, 'wt');
      mkdirSync(worktree, { recursive: true });
      const planPath = planAt(root, { files: [{ path: 'src/a.ts' }] });
      const before = new Date(Date.now() - 3600_000);
      utimesSync(planPath, before, before);
      const mtimeBefore = statSync(planPath).mtimeMs;

      runRepoContext({ plan: planPath, worktree, out: join(root, 'ctx.json') });

      // Within a millisecond, not exactly: `mtimeMs` is a double over a
      // nanosecond clock and `utimesSync` takes seconds as a double, so a
      // restore costs a unit in the last place on ext4 (…911.999 goes back as
      // …911.998). That is the same tolerance the ledger's own plan fence
      // uses, and the assertion that matters — the entries stay visible — is
      // the one below.
      expect(Math.abs(statSync(planPath).mtimeMs - mtimeBefore)).toBeLessThan(
        1,
      );
      // The rewrite itself still happened — asserted on CONTENT, not just
      // parseability: a regression that skips the write when content changed
      // passes both mtime assertions.
      expect(
        (JSON.parse(readFileSync(planPath, 'utf8')) as Record<string, unknown>)[
          'repositoryContext'
        ],
      ).toBeUndefined();
      expect(readFileSync(planPath, 'utf8')).toContain('files');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips the write entirely when the enrichment changes nothing', () => {
    // The resumed-run common case the code comments on, unreachable from
    // `planAt` fixtures: those write compact JSON while production plans are
    // written by `stringifyPlanReport`, so `planUnchanged` was always false
    // in this suite and the skip branch ran nowhere. Write the plan the way
    // production does, with its context already attached, and assert no
    // write happened at all — the strongest form of "the epoch cannot move"
    // is that the commit-then-restore window never opens.
    const root = mkdtempSync(join(tmpdir(), 'repo-context-skip-'));
    try {
      const worktree = join(root, 'wt');
      mkdirSync(worktree, { recursive: true });
      const planPath = join(root, 'plan.json');
      const context0 = context();
      const planObj = {
        files: [{ path: 'src/a.ts' }],
        repositoryContext: context0,
      };
      writeFileSync(planPath, stringifyPlanReport(planObj as never));
      const before = new Date(Date.now() - 3600_000);
      utimesSync(planPath, before, before);
      const inoBefore = statSync(planPath).ino;
      const mtimeBefore = statSync(planPath).mtimeMs;

      const same: RepositoryContextProvider = {
        provide: () => context0,
      };
      runRepoContext(
        { plan: planPath, worktree, out: join(root, 'ctx.json') },
        [same],
      );

      // Same inode, same mtime: not restored — never rewritten.
      expect(statSync(planPath).ino).toBe(inoBefore);
      expect(statSync(planPath).mtimeMs).toBe(mtimeBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('aborts on a rename-replacement even with the mtime restored', () => {
    // The inode disjunct: an in-place rewrite fires the mtime clause, so a
    // swap that RESTORES the mtime — the checkpoint-faking shape — is the
    // only thing this half catches, and no test exercised it.
    const root = mkdtempSync(join(tmpdir(), 'repo-context-ino-'));
    try {
      const worktree = join(root, 'wt');
      mkdirSync(worktree, { recursive: true });
      const planPath = planAt(root, { files: [{ path: 'src/a.ts' }] });
      const before = statSync(planPath);
      const racer: RepositoryContextProvider = {
        provide() {
          // Replace the FILE (new inode), then put the old mtime back.
          const tmp = join(root, 'swap.json');
          writeFileSync(tmp, readFileSync(planPath, 'utf8'));
          rmSync(planPath);
          renameSync(tmp, planPath);
          utimesSync(planPath, before.atime, before.mtime);
          return null;
        },
      };
      expect(() =>
        runRepoContext(
          { plan: planPath, worktree, out: join(root, 'ctx.json') },
          [racer],
        ),
      ).toThrow(/changed while repository context was being computed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('aborts when the plan changed while providers were running', () => {
    // The plan path is shared per PR and providers take real time: a
    // concurrent capture can replace the file mid-computation, and this run
    // would then write contents derived from the OLD plan and restore the
    // NEW run's epoch over them — the other run's ledger and transcripts
    // pass an exact mtime fence against a plan they never described.
    const root = mkdtempSync(join(tmpdir(), 'repo-context-cas-'));
    try {
      const worktree = join(root, 'wt');
      mkdirSync(worktree, { recursive: true });
      const planPath = planAt(root, { files: [{ path: 'src/a.ts' }] });
      const racer: RepositoryContextProvider = {
        provide() {
          // The concurrent run captures the plan mid-computation.
          writeFileSync(planPath, JSON.stringify({ files: [] }));
          const later = new Date(Date.now() + 60_000);
          utimesSync(planPath, later, later);
          return null;
        },
      };
      expect(() =>
        runRepoContext(
          { plan: planPath, worktree, out: join(root, 'ctx.json') },
          [racer],
        ),
      ).toThrow(/changed while repository context was being computed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves a SUB-MILLISECOND plan mtime, and stays silent about it', () => {
    // The case a `Date`-backdated fixture cannot reach. `Date` carries whole
    // milliseconds; APFS and ext4 keep nanoseconds. Restoring from
    // `planStat.mtime` truncates the remainder, so the plan comes back with a
    // mtime that is CLOSE to the original and not equal to it — and the run
    // ledger's exact `planMtimeMs === planMtime` fence reads that as a
    // different plan and drops every session entry, silently emptying the
    // resume ledger. The test that shipped alongside the restore used an
    // integer-millisecond fixture, which round-trips exactly and sees none of
    // this.
    const root = mkdtempSync(join(tmpdir(), 'repo-context-epoch-sub-ms-'));
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const worktree = join(root, 'wt');
      mkdirSync(worktree, { recursive: true });
      const planPath = planAt(root, { files: [{ path: 'src/a.ts' }] });
      // Seconds as a float: 0.1234567 s past the epoch second, which no
      // `Date` can hold.
      const seconds = Math.floor(Date.now() / 1000) - 3600 + 0.1234567;
      utimesSync(planPath, seconds, seconds);
      const mtimeBefore = statSync(planPath).mtimeMs;
      // The ledger `fetch-pr` writes an orchestrator turn before this command
      // runs: S0 is the interrupted attempt, S1 the continuation reading it.
      appendRunSession(planPath, { QWEN_CODE_SESSION_ID: 'S0' });
      recordResume(planPath, { QWEN_CODE_SESSION_ID: 'S1' });
      // The fixture is only meaningful if this filesystem actually keeps the
      // fraction; on one that does not, the integer case above already covers
      // it.
      const hasSubMs = mtimeBefore !== Math.floor(mtimeBefore);

      runRepoContext({ plan: planPath, worktree, out: join(root, 'ctx.json') });

      if (hasSubMs) {
        expect(Math.abs(statSync(planPath).mtimeMs - mtimeBefore)).toBeLessThan(
          1,
        );
      }
      // The consequence that actually matters, asserted end to end rather
      // than inferred from a timestamp: the session entry `fetch-pr` wrote
      // before this command ran is still THIS run's. Honest scope note: with
      // the ledger fence tolerating 1ms, a `Date`-based restore (which loses
      // strictly less than 1ms) would ALSO pass this assertion — the fence's
      // tolerance is what makes that regression benign, and this test pins
      // the end-to-end visibility, not the float restore itself.
      expect(priorSessionIds(planPath, { QWEN_CODE_SESSION_ID: 'S1' })).toEqual(
        ['S0'],
      );
      // And no WARNING: the verification compares floats that survived a
      // filesystem round trip, so an exact-equality check reports failure on
      // every enrichment that changed anything.
      const printed = err.mock.calls.map((c) => String(c[0])).join('');
      expect(printed).not.toContain("could not restore the plan's timestamp");
    } finally {
      err.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('commitPlanPreservingEpoch — the epoch never advances, even torn', () => {
  let root: string;
  let plan: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'commit-epoch-')));
    plan = join(root, 'plan.json');
    writeFileSync(plan, '{"old":true}');
    const past = new Date(Date.now() - 300_000);
    utimesSync(plan, past, past);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('the committed file carries the anchor epoch, atomically', () => {
    // The temp file is stamped BEFORE the rename: there is no instant at
    // which the plan path exists with an advanced mtime, so a kill at any
    // point leaves either the old plan under the old epoch or the new plan
    // under the old epoch — never the new plan under a new one. The
    // separate write-then-restore pair had exactly that instant, and the
    // skip-when-identical retry guard made it permanent.
    const anchor = statSync(plan);
    commitPlanPreservingEpoch(plan, '{"new":true}', anchor);
    expect(readFileSync(plan, 'utf8')).toBe('{"new":true}');
    expect(
      Math.abs(statSync(plan).mtimeMs - anchor.mtimeMs),
    ).toBeLessThanOrEqual(1);
    expect(readdirSync(root).filter((n) => n.includes('enrich-tmp'))).toEqual(
      [],
    );
  });

  it('refuses to overwrite a capture that landed after the anchor', () => {
    // The compare-and-refuse upstream leaves a read+compare+write window; a
    // concurrent capture landing inside it was silently overwritten with
    // stale derived contents under the OTHER run's epoch. Identity is
    // re-checked against the anchor immediately before the rename.
    const anchor = statSync(plan);
    writeFileSync(plan, '{"captured":"by-another-run"}');
    expect(() =>
      commitPlanPreservingEpoch(plan, '{"stale":true}', anchor),
    ).toThrow(/changed while repository context was being committed/);
    expect(readFileSync(plan, 'utf8')).toBe('{"captured":"by-another-run"}');
    expect(readdirSync(root).filter((n) => n.includes('enrich-tmp'))).toEqual(
      [],
    );
  });

  it('refuses when the inode moved even if the mtime was forged back', () => {
    const anchor = statSync(plan);
    // The imposter is created WHILE the original still exists, then renamed
    // over it — so its inode is guaranteed distinct. A delete-then-create
    // fixture is not: ext4 recycles a just-freed inode number immediately,
    // and the imposter came back as the same (ino, mtime) identity, which
    // no check can (or should) tell apart.
    const imposter = join(root, 'imposter.json');
    writeFileSync(imposter, '{"captured":"by-another-run"}');
    renameSync(imposter, plan);
    // Forge the anchor's mtime onto the imposter: the inode still differs.
    utimesSync(plan, anchor.atimeMs / 1000, anchor.mtimeMs / 1000);
    expect(() =>
      commitPlanPreservingEpoch(plan, '{"stale":true}', anchor),
    ).toThrow(/changed while repository context was being committed/);
  });
});
