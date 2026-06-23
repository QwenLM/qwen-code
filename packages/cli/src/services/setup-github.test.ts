/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as gitUtils from '../utils/gitUtils.js';
import {
  GITHUB_WORKFLOW_PATHS,
  SetupGithubError,
  setupGithub,
  updateGitignore,
  type SetupGithubFileOps,
} from './setup-github.js';

const mockProxyAgent = vi.hoisted(() => vi.fn((proxy: string) => ({ proxy })));
const mockWriteStderrLine = vi.hoisted(() => vi.fn());

vi.mock('../utils/gitUtils.js', () => ({
  isGitHubRepository: vi.fn(),
  isGitHubRepositoryAsync: vi.fn(),
  getGitRepoRoot: vi.fn(),
  getGitRepoRootAsync: vi.fn(),
  getLatestGitHubRelease: vi.fn(),
  getGitHubRepoInfo: vi.fn(),
  getGitHubRepoInfoAsync: vi.fn(),
}));

vi.mock('undici', () => ({
  ProxyAgent: mockProxyAgent,
}));

vi.mock('../utils/stdioHelpers.js', () => ({
  writeStderrLine: mockWriteStderrLine,
}));

function okResponse(text: string): Response {
  return new Response(text, { status: 200 });
}

describe('setupGithub service', () => {
  let scratchDir = '';

  beforeEach(async () => {
    vi.resetAllMocks();
    mockProxyAgent.mockImplementation((proxy: string) => ({ proxy }));
    scratchDir = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'setup-github-service-'),
    );
    vi.mocked(gitUtils.isGitHubRepository).mockReturnValue(true);
    vi.mocked(gitUtils.isGitHubRepositoryAsync).mockResolvedValue(true);
    vi.mocked(gitUtils.getGitRepoRoot).mockReturnValue(scratchDir);
    vi.mocked(gitUtils.getGitRepoRootAsync).mockResolvedValue(scratchDir);
    vi.mocked(gitUtils.getLatestGitHubRelease).mockResolvedValue('v1.2.3');
    vi.mocked(gitUtils.getGitHubRepoInfo).mockReturnValue({
      owner: 'owner',
      repo: 'repo',
    });
    vi.mocked(gitUtils.getGitHubRepoInfoAsync).mockResolvedValue({
      owner: 'owner',
      repo: 'repo',
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (scratchDir) await fsp.rm(scratchDir, { recursive: true, force: true });
  });

  it('downloads latest release workflows with configured proxy', async () => {
    const dispatchers: unknown[] = [];
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        dispatchers.push(
          (init as RequestInit & { dispatcher?: unknown }).dispatcher,
        );
        return okResponse(`body:${path.basename(String(input))}`);
      },
    ) as unknown as typeof fetch;

    const result = await setupGithub({
      cwd: scratchDir,
      workspaceRoot: scratchDir,
      proxy: 'http://proxy.local:8080',
      fetchImpl,
    });

    expect(gitUtils.getLatestGitHubRelease).toHaveBeenCalledWith(
      'http://proxy.local:8080',
    );
    expect(mockProxyAgent).toHaveBeenCalledTimes(1);
    expect(mockProxyAgent).toHaveBeenCalledWith('http://proxy.local:8080');
    expect(fetchImpl).toHaveBeenCalledTimes(GITHUB_WORKFLOW_PATHS.length);
    expect(dispatchers).toHaveLength(GITHUB_WORKFLOW_PATHS.length);
    expect(
      dispatchers.every((dispatcher) => dispatcher === dispatchers[0]),
    ).toBe(true);
    expect(result.releaseTag).toBe('v1.2.3');
    expect(result.secretsUrl).toBe(
      'https://github.com/owner/repo/settings/secrets/actions',
    );
    expect(result.gitignore.status).toBe('created');
    for (const workflow of GITHUB_WORKFLOW_PATHS) {
      const target = path.join(
        scratchDir,
        '.github',
        'workflows',
        path.basename(workflow),
      );
      await expect(fsp.readFile(target, 'utf8')).resolves.toContain(
        path.basename(workflow),
      );
    }
  });

  it('fails before writing when release lookup fails', async () => {
    vi.mocked(gitUtils.getLatestGitHubRelease).mockRejectedValue(
      new Error('offline'),
    );
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(
      setupGithub({ cwd: scratchDir, workspaceRoot: scratchDir, fetchImpl }),
    ).rejects.toMatchObject({
      code: 'github_release_lookup_failed',
      status: 502,
    });
    await expect(
      fsp.access(path.join(scratchDir, '.github')),
    ).rejects.toBeDefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('offline'),
    );
  });

  it('does not write when workflow download fails', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(okResponse('first'))
      .mockResolvedValueOnce(
        new Response('missing', { status: 404, statusText: 'Not Found' }),
      ) as unknown as typeof fetch;

    await expect(
      setupGithub({ cwd: scratchDir, workspaceRoot: scratchDir, fetchImpl }),
    ).rejects.toMatchObject({
      code: 'github_workflow_download_failed',
      status: 502,
    });
    await expect(
      fsp.access(path.join(scratchDir, '.github')),
    ).rejects.toBeDefined();
  });

  it('aborts sibling workflow downloads after the first download failure', async () => {
    const abortedEndpoints: string[] = [];
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const endpoint = String(input);
        if (endpoint.includes('qwen-invoke.yml')) {
          return new Response('missing', {
            status: 404,
            statusText: 'Not Found',
          });
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            abortedEndpoints.push(endpoint);
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      },
    ) as unknown as typeof fetch;

    await expect(
      setupGithub({ cwd: scratchDir, workspaceRoot: scratchDir, fetchImpl }),
    ).rejects.toThrow(/qwen-invoke\.yml/);

    expect(abortedEndpoints.length).toBeGreaterThan(0);
  });

  it('reports partial workflow write failure without updating gitignore', async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse('workflow'),
    ) as unknown as typeof fetch;
    const readGitignore = vi.fn(async () => undefined);
    const fileOps: SetupGithubFileOps = {
      ensureWorkflowDirectory: vi.fn(async () => {}),
      writeTextFile: vi.fn(async (_gitRepoRoot, relativePath) => {
        if (relativePath.endsWith('qwen-invoke.yml')) {
          throw new Error('disk full');
        }
        return { sizeBytes: 8 };
      }),
      readTextFile: readGitignore,
    };

    await expect(
      setupGithub({
        cwd: scratchDir,
        workspaceRoot: scratchDir,
        fetchImpl,
        fileOps,
      }),
    ).rejects.toMatchObject({
      code: 'github_workflow_write_failed',
      status: 500,
      partial: true,
    });
    expect(readGitignore).not.toHaveBeenCalled();
  });

  it('updates gitignore idempotently', async () => {
    const gitignorePath = path.join(scratchDir, '.gitignore');
    await fsp.writeFile(gitignorePath, '.qwen/\nnode_modules/\n');

    const first = await updateGitignore(scratchDir);
    const second = await updateGitignore(scratchDir);

    expect(first.status).toBe('updated');
    expect(second.status).toBe('unchanged');
    await expect(fsp.readFile(gitignorePath, 'utf8')).resolves.toBe(
      '.qwen/\nnode_modules/\n\ngha-creds-*.json\n',
    );
  });

  it('rejects when git root is outside bound workspace', async () => {
    const otherWorkspace = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'setup-github-other-'),
    );
    try {
      await expect(
        setupGithub({
          cwd: scratchDir,
          workspaceRoot: otherWorkspace,
          fetchImpl: vi.fn() as unknown as typeof fetch,
        }),
      ).rejects.toMatchObject({
        code: 'github_git_root_mismatch',
        status: 400,
      });
    } finally {
      await fsp.rm(otherWorkspace, { recursive: true, force: true });
    }
  });

  it('wraps setup failures with SetupGithubError', async () => {
    vi.mocked(gitUtils.isGitHubRepositoryAsync).mockResolvedValue(false);

    await expect(
      setupGithub({
        cwd: scratchDir,
        workspaceRoot: scratchDir,
        fetchImpl: vi.fn() as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(SetupGithubError);
  });
});
