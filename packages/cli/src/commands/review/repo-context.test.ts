/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
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

function run(
  root: string,
  worktree: string,
  plan: object,
  providers: readonly RepositoryContextProvider[],
): { planPath: string; outPath: string } {
  const planPath = planAt(root, plan);
  const outPath = join(root, 'context.json');
  runRepoContext({ plan: planPath, worktree, out: outPath }, providers);
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
      expect(input.readIdentityFile('.review/identity')).toBe('local\n');
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

  it('reads pull-request identity only from the trusted base commit', () => {
    const root = temp();
    const worktree = join(root, 'repository');
    initGit(worktree);
    write(join(worktree, '.review', 'identity'), 'base\n');
    write(join(worktree, 'src', 'change.ts'), 'base\n');
    const base = commitAll(worktree);
    write(join(worktree, '.review', 'identity'), 'head\n');
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

  it('fails closed for failed, stale, or invalid base identity', () => {
    const root = temp();
    const worktree = join(root, 'repository');
    initGit(worktree);
    write(join(worktree, 'src', 'change.ts'), 'base\n');
    const base = commitAll(worktree);
    const provider: RepositoryContextProvider = { provide: () => context() };
    expect(() =>
      run(
        join(root, 'fetch-failed'),
        worktree,
        {
          files: [{ path: 'src/change.ts' }],
          mergeBaseSha: base,
          baseFetchFailed: true,
        },
        [provider],
      ),
    ).toThrow('base fetch failed');
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

  it('rejects changed-path traversal before providers run', () => {
    const root = temp();
    const worktree = join(root, 'worktree');
    mkdirSync(worktree);
    const provide = vi.fn<RepositoryContextProvider['provide']>();
    expect(() =>
      run(root, worktree, { files: [{ path: '../secret' }] }, [{ provide }]),
    ).toThrow('plan.files[0].path is invalid');
    expect(provide).not.toHaveBeenCalled();
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

  it('declares all required command options and the default empty provider list writes null', () => {
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
    mkdirSync(worktree);
    const plan = planAt(root, { files: [{ path: 'src/change.ts' }] });
    const out = join(root, 'context.json');
    (repoContextCommand.handler as (args: unknown) => void)({
      plan,
      worktree,
      out,
    });
    expect(readJson(out)).toBeNull();
  });
});
