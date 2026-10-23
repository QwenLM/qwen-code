/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GitCloneRequestError,
  claimCloneTarget,
  createWorkspaceGitCloner,
  normalizeGitCloneUrl,
  redactGitUrl,
  sanitizeGitCloneMessage,
  type GitCloneProcess,
  type GitCloneJobSnapshot,
  type WorkspaceGitCloner,
} from './workspace-git-clone.js';

const roots: string[] = [];

function supportsGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const GIT_AVAILABLE = supportsGit();

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'qwen-git-clone-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) =>
        rm(root, { recursive: true, force: true }).catch(() => undefined),
      ),
  );
});

function writingRunner(
  progress = 'Receiving objects:  42% (42/100), 1.00 MiB | 2.00 MiB/s',
): GitCloneProcess {
  return {
    async run({ target, onProgress }) {
      onProgress(progress);
      await writeFile(join(target, 'README.md'), 'hello');
    },
  };
}

function blockingRunner(): GitCloneProcess {
  return {
    run({ signal }) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            const error = new Error('cancelled');
            error.name = 'GitCloneCancelledError';
            reject(error);
          },
          { once: true },
        );
      });
    },
  };
}

async function waitForJob(
  cloner: WorkspaceGitCloner,
  jobId: string,
  attempts = 100,
): Promise<GitCloneJobSnapshot> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const job = cloner.get(jobId);
    if (job && job.status !== 'running') return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('clone job did not settle');
}

describe('normalizeGitCloneUrl', () => {
  it.each([
    'https://github.com/org/repo.git',
    'http://example.com/repo',
    'ssh://git@example.com/org/repo.git',
    'git://example.com/repo.git',
    'git+ssh://git@example.com/org/repo.git',
    'git@example.com:org/repo.git',
    'file:///tmp/repo.git',
  ])('accepts %s', (url) => {
    expect(normalizeGitCloneUrl(` ${url} `)).toBe(url);
  });

  it.each([
    '',
    '-u',
    '--upload-pack=sh',
    'ext::sh -c whoami',
    'ftp://example.com/repo.git',
    'https://',
    'https://example.com/\nrepo',
    `https://example.com/${'a'.repeat(2100)}`,
  ])('rejects %s', (url) => {
    expect(() => normalizeGitCloneUrl(url)).toThrow(GitCloneRequestError);
  });
});

describe('redactGitUrl', () => {
  it('removes userinfo from an HTTPS URL', () => {
    expect(redactGitUrl('https://user:secret@example.com/repo.git')).toBe(
      'https://***@example.com/repo.git',
    );
  });

  it('leaves credential-free URLs and scp-like addresses alone', () => {
    expect(redactGitUrl('https://example.com/repo.git')).toBe(
      'https://example.com/repo.git',
    );
    expect(redactGitUrl('git@example.com:repo.git')).toBe(
      'git@example.com:repo.git',
    );
  });
});

describe('sanitizeGitCloneMessage', () => {
  it('strips ANSI escapes, credential-bearing URLs, and bounds the length', () => {
    const url = 'https://user:secret@example.com/repo.git';
    const message = sanitizeGitCloneMessage(
      `\u001b[31mfatal: ${url} rejected\u001b[0m ${'x'.repeat(400)}`,
      url,
    );
    expect(message).not.toContain('secret');
    expect(message).not.toContain('\u001b');
    expect(message.length).toBeLessThanOrEqual(240);
  });
});

describe('claimCloneTarget', () => {
  it('rejects a relative path', async () => {
    await expect(claimCloneTarget('relative/repo')).rejects.toMatchObject({
      code: 'invalid_target',
    });
  });

  it('rejects a missing parent', async () => {
    const root = await tempRoot();
    await expect(
      claimCloneTarget(join(root, 'missing', 'repo')),
    ).rejects.toMatchObject({ code: 'invalid_target' });
  });

  it('rejects an existing target without touching it', async () => {
    const root = await tempRoot();
    const target = join(root, 'repo');
    await writeFile(target, 'keep me');
    await expect(claimCloneTarget(target)).rejects.toMatchObject({
      code: 'target_exists',
    });
    await expect(stat(target)).resolves.toBeDefined();
  });
});

describe('createWorkspaceGitCloner', () => {
  it('clones, reports progress, and returns the canonical cwd', async () => {
    const root = await tempRoot();
    const target = join(root, 'repo');
    const cloner = createWorkspaceGitCloner({ runner: writingRunner() });

    const { jobId } = await cloner.start({
      url: 'https://example.com/org/repo.git',
      target,
    });
    const job = await waitForJob(cloner, jobId);

    expect(job.status).toBe('succeeded');
    expect(job.percent).toBe(100);
    expect(job.cwd).toBeTruthy();
    expect(existsSync(join(job.cwd!, 'README.md'))).toBe(true);
  });

  it.skipIf(!GIT_AVAILABLE)(
    'clones a real local repository through the default runner',
    async () => {
      const root = await tempRoot();
      const source = join(root, 'source');
      execFileSync('git', ['init', source], { stdio: 'ignore' });
      execFileSync('git', [
        '-C',
        source,
        'config',
        'user.email',
        'test@example.com',
      ]);
      execFileSync('git', ['-C', source, 'config', 'user.name', 'Test']);
      await writeFile(join(source, 'README.md'), 'hello\n');
      execFileSync('git', ['-C', source, 'add', 'README.md']);
      execFileSync('git', ['-C', source, 'commit', '-m', 'init'], {
        stdio: 'ignore',
      });
      const bare = join(root, 'origin.git');
      execFileSync('git', ['clone', '--bare', source, bare], {
        stdio: 'ignore',
      });

      const cloner = createWorkspaceGitCloner();
      const { jobId } = await cloner.start({
        url: `file://${bare}`,
        target: join(root, 'clone'),
      });
      const job = await waitForJob(cloner, jobId, 500);

      expect(job.status).toBe('succeeded');
      expect(await readFile(join(job.cwd!, 'README.md'), 'utf8')).toBe(
        'hello\n',
      );
    },
    20_000,
  );

  it('reports progress percentages from git output', async () => {
    const root = await tempRoot();
    const cloner = createWorkspaceGitCloner({
      runner: writingRunner('Receiving objects:  42% (42/100)'),
    });
    const { jobId } = await cloner.start({
      url: 'https://example.com/org/repo.git',
      target: join(root, 'repo'),
    });
    const job = await waitForJob(cloner, jobId);
    expect(job.status).toBe('succeeded');
    expect(job.percent).toBe(100);
  });

  it('removes the target and sanitizes the error when the clone fails', async () => {
    const root = await tempRoot();
    const target = join(root, 'repo');
    const url = 'https://user:secret@example.com/repo.git';
    const cloner = createWorkspaceGitCloner({
      runner: {
        async run() {
          throw new Error(`fatal: could not read ${url}`);
        },
      },
    });
    const { jobId } = await cloner.start({ url, target });
    const job = await waitForJob(cloner, jobId);

    expect(job.status).toBe('failed');
    expect(job.error?.code).toBe('clone_failed');
    expect(job.error?.message).not.toContain('secret');
    expect(existsSync(target)).toBe(false);
  });

  it('cancels a running clone and removes the target', async () => {
    const root = await tempRoot();
    const target = join(root, 'repo');
    const cloner = createWorkspaceGitCloner({ runner: blockingRunner() });
    const { jobId } = await cloner.start({
      url: 'https://example.com/org/repo.git',
      target,
    });

    const job = await cloner.cancel(jobId);

    expect(job?.status).toBe('cancelled');
    expect(existsSync(target)).toBe(false);
  });

  it('times out a stuck clone and removes the target', async () => {
    const root = await tempRoot();
    const target = join(root, 'repo');
    const cloner = createWorkspaceGitCloner({
      runner: blockingRunner(),
      timeoutMs: 20,
    });
    const { jobId } = await cloner.start({
      url: 'https://example.com/org/repo.git',
      target,
    });
    const job = await waitForJob(cloner, jobId);

    expect(job.status).toBe('failed');
    expect(job.error?.code).toBe('clone_timeout');
    expect(existsSync(target)).toBe(false);
  });

  it('leaves no directory behind when the route rejects the target', async () => {
    const root = await tempRoot();
    const target = join(root, 'repo');
    const cloner = createWorkspaceGitCloner({ runner: writingRunner() });

    await expect(
      cloner.start({
        url: 'https://example.com/org/repo.git',
        target,
        validateTarget: () => ({
          status: 409,
          code: 'target_nested',
          message: 'nested',
        }),
      }),
    ).rejects.toMatchObject({ code: 'target_nested' });
    expect(existsSync(target)).toBe(false);
  });

  it('limits concurrent clones', async () => {
    const root = await tempRoot();
    const cloner = createWorkspaceGitCloner({
      runner: blockingRunner(),
      maxRunning: 1,
    });
    await cloner.start({
      url: 'https://example.com/org/repo.git',
      target: join(root, 'first'),
    });

    await expect(
      cloner.start({
        url: 'https://example.com/org/repo.git',
        target: join(root, 'second'),
      }),
    ).rejects.toMatchObject({ code: 'clone_limit_reached' });

    await cloner.sealAndWait();
  });

  it('rejects new clones after sealing and cancels running ones', async () => {
    const root = await tempRoot();
    const cloner = createWorkspaceGitCloner({ runner: blockingRunner() });
    const { jobId } = await cloner.start({
      url: 'https://example.com/org/repo.git',
      target: join(root, 'repo'),
    });

    await cloner.sealAndWait();

    expect(cloner.get(jobId)?.status).toBe('cancelled');
    await expect(
      cloner.start({
        url: 'https://example.com/org/repo.git',
        target: join(root, 'after'),
      }),
    ).rejects.toMatchObject({ code: 'daemon_shutting_down' });
  });

  it('publishes a success snapshot only after cwd is resolved', async () => {
    const root = await tempRoot();
    const target = join(root, 'repo');
    let resolveCwd!: (value: string) => void;
    const cwd = new Promise<string>((resolve) => {
      resolveCwd = resolve;
    });
    let runnerDone!: () => void;
    const done = new Promise<void>((resolve) => {
      runnerDone = resolve;
    });
    const cloner = createWorkspaceGitCloner({
      runner: {
        async run({ target: cloneTarget }) {
          await writeFile(join(cloneTarget, 'README.md'), 'x');
          runnerDone();
        },
      },
      resolveCwd: () => cwd,
    });
    const { jobId } = await cloner.start({
      url: 'https://example.com/org/repo.git',
      target,
    });
    await done;
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The terminal state must not be observable before its result path.
    expect(cloner.get(jobId)?.status).toBe('running');
    expect(cloner.get(jobId)?.cwd).toBeUndefined();

    resolveCwd('/canonical/repo');
    const job = await waitForJob(cloner, jobId);
    expect(job.status).toBe('succeeded');
    expect(job.cwd).toBe('/canonical/repo');
  });

  it('reserves the target for the job lifetime and releases it on success', async () => {
    const root = await tempRoot();
    const reserved: string[] = [];
    const released: string[] = [];
    const cloner = createWorkspaceGitCloner({ runner: writingRunner() });
    const { jobId } = await cloner.start({
      url: 'https://example.com/org/repo.git',
      target: join(root, 'repo'),
      reserveTarget: (value) => reserved.push(value),
      releaseTarget: (value) => released.push(value),
    });

    expect(reserved).toHaveLength(1);
    const job = await waitForJob(cloner, jobId);
    expect(job.status).toBe('succeeded');
    expect(released).toEqual(reserved);
  });

  it('does not reserve a target rejected by the route validator', async () => {
    const root = await tempRoot();
    const reserved: string[] = [];
    const cloner = createWorkspaceGitCloner({ runner: writingRunner() });

    await expect(
      cloner.start({
        url: 'https://example.com/org/repo.git',
        target: join(root, 'repo'),
        validateTarget: () => ({
          status: 409,
          code: 'target_nested',
          message: 'nested',
        }),
        reserveTarget: (value) => reserved.push(value),
      }),
    ).rejects.toMatchObject({ code: 'target_nested' });
    expect(reserved).toHaveLength(0);
  });

  it('releases the reservation when a clone is cancelled', async () => {
    const root = await tempRoot();
    const reserved: string[] = [];
    const released: string[] = [];
    const cloner = createWorkspaceGitCloner({ runner: blockingRunner() });
    const { jobId } = await cloner.start({
      url: 'https://example.com/org/repo.git',
      target: join(root, 'repo'),
      reserveTarget: (value) => reserved.push(value),
      releaseTarget: (value) => released.push(value),
    });

    const job = await cloner.cancel(jobId);
    expect(job?.status).toBe('cancelled');
    expect(released).toEqual(reserved);
  });
});
