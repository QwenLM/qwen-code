/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { repoContextCommand, runRepoContext } from './repo-context.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'repo-context-command-'));
  dirs.push(dir);
  return dir;
}

function write(root: string, path: string, text = ''): string {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
  return file;
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: join(root, 'global.gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
    },
  }).trim();
}

function makePlan(
  root: string,
  worktree: string,
  repositoryContext: unknown = undefined,
): string {
  return write(
    root,
    'plan.json',
    JSON.stringify({
      worktreePath: worktree,
      files: [{ path: 'src/hotspot/share/opto/a.cpp' }],
      ...(repositoryContext === undefined ? {} : { repositoryContext }),
    }),
  );
}

describe('repo-context command', () => {
  it('reads plan.files paths, writes the artifact, and embeds identical context', () => {
    const root = tempDir();
    const worktree = join(root, 'jdk');
    write(worktree, '.jcheck/conf', '[general]\nproject=jdk\n');
    write(worktree, 'src/hotspot/share/opto/a.cpp');
    write(worktree, 'src/hotspot/share/opto/a.hpp');
    write(
      worktree,
      'test/hotspot/jtreg/TEST.groups',
      'hotspot_compiler = compiler\n',
    );
    const plan = makePlan(root, worktree);
    const out = join(root, 'artifacts', 'repository-context.json');

    runRepoContext({ plan, worktree, out });

    const artifact = JSON.parse(readFileSync(out, 'utf8')) as unknown;
    const updated = JSON.parse(readFileSync(plan, 'utf8')) as {
      repositoryContext: unknown;
    };
    expect(updated.repositoryContext).toEqual(artifact);
    expect(artifact).toMatchObject({
      adapter: 'openjdk',
      relatedPaths: ['src/hotspot/share/opto/a.hpp'],
    });
    expect(readFileSync(plan, 'utf8')).toContain('\n  "files":');
  });

  it('writes null and removes stale context for a non-OpenJDK worktree', () => {
    const root = tempDir();
    const worktree = join(root, 'ordinary-repo');
    mkdirSync(worktree);
    const plan = makePlan(root, worktree, { version: 999 });
    const out = join(root, 'context.json');

    runRepoContext({ plan, worktree, out });

    expect(JSON.parse(readFileSync(out, 'utf8'))).toBeNull();
    expect(JSON.parse(readFileSync(plan, 'utf8'))).not.toHaveProperty(
      'repositoryContext',
    );
  });

  it('rejects a different worktree, including a symlink alias to another tree', () => {
    const root = tempDir();
    const recorded = join(root, 'recorded');
    const other = join(root, 'other');
    mkdirSync(recorded);
    mkdirSync(other);
    const alias = join(root, 'other-alias');
    symlinkSync(other, alias);
    const plan = makePlan(root, recorded);

    expect(() =>
      runRepoContext({ plan, worktree: alias, out: join(root, 'out.json') }),
    ).toThrow(/does not match plan\.worktreePath/);
  });

  it('uses merge-base metadata when the reviewed tree deletes jcheck config', () => {
    const root = tempDir();
    const worktree = join(root, 'jdk');
    mkdirSync(worktree);
    git(worktree, 'init', '-q');
    write(worktree, '.jcheck/conf', '[general]\nproject=jdk\n');
    write(worktree, 'src/hotspot/share/opto/a.cpp');
    git(worktree, 'add', '.');
    git(
      worktree,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-qm',
      'base',
    );
    const mergeBaseSha = git(worktree, 'rev-parse', 'HEAD');
    rmSync(join(worktree, '.jcheck'), { recursive: true });
    const plan = write(
      root,
      'plan.json',
      JSON.stringify({
        worktreePath: worktree,
        mergeBaseSha,
        files: [{ path: 'src/hotspot/share/opto/a.cpp' }],
      }),
    );

    runRepoContext({
      plan,
      worktree,
      out: join(root, 'context.json'),
    });

    expect(JSON.parse(readFileSync(plan, 'utf8'))).toHaveProperty(
      'repositoryContext.adapter',
      'openjdk',
    );
  });

  it('does not let a reviewed tree opt into OpenJDK context', () => {
    const root = tempDir();
    const worktree = join(root, 'repo');
    mkdirSync(worktree);
    git(worktree, 'init', '-q');
    write(worktree, 'src/hotspot/share/opto/a.cpp');
    git(worktree, 'add', '.');
    git(
      worktree,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-qm',
      'base',
    );
    const mergeBaseSha = git(worktree, 'rev-parse', 'HEAD');
    write(worktree, '.jcheck/conf', '[general]\nproject=jdk\n');
    const plan = write(
      root,
      'plan.json',
      JSON.stringify({
        worktreePath: worktree,
        mergeBaseSha,
        files: [{ path: 'src/hotspot/share/opto/a.cpp' }],
      }),
    );
    const out = join(root, 'context.json');

    runRepoContext({ plan, worktree, out });

    expect(JSON.parse(readFileSync(out, 'utf8'))).toBeNull();
    expect(JSON.parse(readFileSync(plan, 'utf8'))).not.toHaveProperty(
      'repositoryContext',
    );
  });

  it('fails closed when the recorded merge base cannot be resolved', () => {
    const root = tempDir();
    const worktree = join(root, 'repo');
    mkdirSync(worktree);
    git(worktree, 'init', '-q');
    const plan = write(
      root,
      'plan.json',
      JSON.stringify({
        worktreePath: worktree,
        mergeBaseSha: '0000000000000000000000000000000000000000',
        files: [{ path: 'src/a.ts' }],
      }),
    );

    expect(() =>
      runRepoContext({
        plan,
        worktree,
        out: join(root, 'context.json'),
      }),
    ).toThrow(/mergeBaseSha cannot be resolved/);
  });

  it('fails closed when the merge base may come from a stale base ref', () => {
    const root = tempDir();
    const worktree = join(root, 'repo');
    mkdirSync(worktree);
    git(worktree, 'init', '-q');
    write(worktree, '.jcheck/conf', '[general]\nproject=jdk\n');
    write(worktree, 'src/hotspot/share/opto/a.cpp');
    git(worktree, 'add', '.');
    git(
      worktree,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-qm',
      'base',
    );
    const plan = write(
      root,
      'plan.json',
      JSON.stringify({
        worktreePath: worktree,
        mergeBaseSha: git(worktree, 'rev-parse', 'HEAD'),
        baseFetchFailed: true,
        files: [{ path: 'src/hotspot/share/opto/a.cpp' }],
      }),
    );

    expect(() =>
      runRepoContext({
        plan,
        worktree,
        out: join(root, 'context.json'),
      }),
    ).toThrow(/mergeBaseSha may be stale/);
  });

  it('leaves the plan unchanged when the artifact cannot be written', () => {
    const root = tempDir();
    const worktree = join(root, 'jdk');
    write(worktree, '.jcheck/conf', '[general]\nproject=jdk\n');
    write(worktree, 'src/hotspot/share/opto/a.cpp');
    const plan = makePlan(root, worktree);
    const original = readFileSync(plan, 'utf8');
    const out = join(root, 'out-directory');
    mkdirSync(out);

    expect(() => runRepoContext({ plan, worktree, out })).toThrow();
    expect(readFileSync(plan, 'utf8')).toBe(original);
  });

  it('rejects output aliases of the plan before overwriting either file', () => {
    const root = tempDir();
    const worktree = join(root, 'repo');
    mkdirSync(worktree);
    const plan = makePlan(root, worktree);
    const alias = join(root, 'alias.json');
    linkSync(plan, alias);
    const original = readFileSync(plan, 'utf8');

    expect(() => runRepoContext({ plan, worktree, out: alias })).toThrow(
      /--out must differ from --plan/,
    );
    expect(readFileSync(plan, 'utf8')).toBe(original);
  });

  it('resolves relative worktree paths from the project cwd', () => {
    const root = tempDir();
    const worktree = join(root, 'jdk');
    write(worktree, '.jcheck/conf', '[general]\nproject=jdk\n');
    write(worktree, 'src/hotspot/share/opto/a.cpp');
    const plan = write(
      root,
      'artifacts/plan.json',
      JSON.stringify({
        worktreePath: 'jdk',
        files: [{ path: 'src/hotspot/share/opto/a.cpp' }],
      }),
    );
    const previousCwd = process.cwd();
    try {
      process.chdir(root);
      runRepoContext({
        plan,
        worktree: 'jdk',
        out: join(root, 'artifacts/context.json'),
      });
    } finally {
      process.chdir(previousCwd);
    }

    expect(JSON.parse(readFileSync(plan, 'utf8'))).toHaveProperty(
      'repositoryContext.adapter',
      'openjdk',
    );
  });

  it('resolves a relative recorded path from the main checkout when run in a linked worktree', () => {
    const root = tempDir();
    const repository = join(root, 'repo');
    mkdirSync(repository);
    git(repository, 'init', '-q');
    write(repository, '.jcheck/conf', '[general]\nproject=jdk\n');
    write(repository, 'src/hotspot/share/opto/a.cpp');
    git(repository, 'add', '.');
    git(
      repository,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-qm',
      'base',
    );
    const relativeWorktree = '.qwen/tmp/review-pr-1';
    const worktree = join(repository, relativeWorktree);
    git(repository, 'worktree', 'add', '-q', '-b', 'review-pr-1', worktree);
    const plan = write(
      root,
      'plan.json',
      JSON.stringify({
        worktreePath: relativeWorktree,
        files: [{ path: 'src/hotspot/share/opto/a.cpp' }],
      }),
    );
    const previousCwd = process.cwd();
    try {
      process.chdir(worktree);
      runRepoContext({
        plan,
        worktree,
        out: join(root, 'context.json'),
      });
    } finally {
      process.chdir(previousCwd);
    }

    expect(JSON.parse(readFileSync(plan, 'utf8'))).toHaveProperty(
      'repositoryContext.adapter',
      'openjdk',
    );
  });

  it('rejects malformed file entries and changed-path traversal before writing', () => {
    const root = tempDir();
    const worktree = join(root, 'jdk');
    write(worktree, '.jcheck/conf', '[general]\nproject=jdk\n');
    const malformed = write(
      root,
      'malformed.json',
      JSON.stringify({ worktreePath: worktree, files: [{}] }),
    );
    expect(() =>
      runRepoContext({
        plan: malformed,
        worktree,
        out: join(root, 'malformed-out.json'),
      }),
    ).toThrow(/files\[0\]\.path/);

    const escaping = write(
      root,
      'escaping.json',
      JSON.stringify({
        worktreePath: worktree,
        files: [{ path: '../secret.cpp' }],
      }),
    );
    expect(() =>
      runRepoContext({
        plan: escaping,
        worktree,
        out: join(root, 'escaping-out.json'),
      }),
    ).toThrow(/escapes the worktree/);
  });

  it('declares all three required CLI options and delegates through the handler', () => {
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

    const root = tempDir();
    const worktree = join(root, 'repo');
    mkdirSync(worktree);
    const plan = makePlan(root, worktree);
    const out = join(root, 'out.json');
    (repoContextCommand.handler as (args: unknown) => void)({
      plan,
      worktree,
      out,
    });
    expect(JSON.parse(readFileSync(out, 'utf8'))).toBeNull();
  });
});
