/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import * as childProcess from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../config/config.js';
import { Storage } from '../config/storage.js';
import {
  isPackageInstallation,
  ContainerExecutionEnvironment,
  workerContainerArguments,
  type ContainerExecutionOptions,
} from './container-execution-environment.js';
import type { ExecutionWorkerOptions } from './execution-environment.js';
import { ExecutionCleanupError } from './execution-environment.js';
import type { ToolResult } from '../tools/tools.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: vi.fn(),
}));

describe('container execution boundary', () => {
  it('preserves preparation errors and cleanup ownership when release fails', async () => {
    const failure = new Error('invalid working directory');
    const cleanupFailure = new ExecutionCleanupError('removal failed');
    const releaseGitMountPoint = vi.fn();
    const primary = {
      request: vi
        .fn()
        .mockRejectedValueOnce(failure)
        .mockRejectedValue(cleanupFailure),
      dispose: vi.fn().mockRejectedValue(cleanupFailure),
    };
    const environment: ContainerExecutionEnvironment = Object.assign(
      Object.create(ContainerExecutionEnvironment.prototype),
      {
        primary,
        options: { runtime: 'docker' },
        temporaryDirectory: '/tmp/failed-container',
        workers: new Set([primary]),
        invocations: new Map(),
        releaseGitMountPoint,
      },
    );
    await expect(
      environment.prepare(
        { id: 'read', toolName: 'Read', params: {} },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      message: expect.stringMatching(
        /invalid working directory.*removal failed/,
      ),
      cause: failure,
    });
    await expect(environment.dispose()).rejects.toBe(cleanupFailure);
    expect(primary.dispose).toHaveBeenCalledOnce();
    expect(releaseGitMountPoint).not.toHaveBeenCalled();
  });

  it.each([
    {
      llmContent: 'installed package',
      returnDisplay: 'installation complete',
      outputBudgetApplied: true,
    },
    {
      llmContent: [{ text: 'installed package' }],
      returnDisplay: 'installation complete',
      outputBudgetApplied: true,
    },
    {
      llmContent: 'partial installation output',
      returnDisplay: 'installation failed',
      outputBudgetApplied: true,
      error: { message: 'partial installation output' },
    },
  ] satisfies ToolResult[])(
    'preserves the tool result and cleanup ownership when installation cleanup fails: %j',
    async (toolResult) => {
      const temporaryDirectory = await mkdtemp(
        join(tmpdir(), 'execution-cleanup-'),
      );
      const failure = new ExecutionCleanupError(
        'container removal failed' +
          (toolResult.error ? 'x'.repeat(35_000) : ''),
      );
      const primary = { dispose: vi.fn().mockResolvedValue(undefined) };
      const install = {
        request: vi.fn().mockResolvedValue(structuredClone(toolResult)),
        dispose: vi.fn().mockRejectedValue(failure),
      };
      const environment: ContainerExecutionEnvironment = Object.assign(
        Object.create(ContainerExecutionEnvironment.prototype),
        {
          primary,
          options: { runtime: 'docker' },
          temporaryDirectory,
          workers: new Set([primary, install]),
          invocations: new Map([['install', install]]),
        },
      );
      try {
        const result = await environment.execute(
          'install',
          new AbortController().signal,
        );
        expect(JSON.stringify(result.llmContent)).toContain(
          typeof toolResult.llmContent === 'string'
            ? toolResult.llmContent
            : toolResult.llmContent[0].text,
        );
        expect(result.returnDisplay).toContain(toolResult.returnDisplay);
        expect(JSON.stringify(result.llmContent)).toContain(
          'Container cleanup failed after tool execution',
        );
        expect(result.returnDisplay).toContain('do not automatically retry');
        expect(result.outputBudgetApplied).not.toBe(true);
        if (toolResult.error) {
          expect(result.error?.message).toContain(toolResult.error.message);
          expect(result.error?.message).toContain('container removal failed');
          expect(result.error?.message).toBe(result.llmContent);
          expect(result.error?.message.length).toBeGreaterThan(30_000);
        } else {
          expect(result.error).toBeUndefined();
        }
        await expect(environment.dispose()).rejects.toBe(failure);
        await expect(access(temporaryDirectory)).resolves.toBeUndefined();
        expect(primary.dispose).toHaveBeenCalledOnce();
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    'npm ci',
    'npm install',
    'npm install --ignore-scripts',
    'pnpm install --frozen-lockfile',
    'yarn install',
  ])('recognizes standalone installation: %s', (command) => {
    expect(isPackageInstallation(command)).toBe(true);
  });
  it.each([
    'npm test',
    'npm run build',
    'pnpm test',
    'yarn build',
    'npm ci && curl example.com',
    'npm ci; npm test',
    'npm ci\ncurl example.com',
    'npm install $(curl example.com)',
    'npm install `whoami`',
    'npm ci | cat',
    'npm ci > output',
    'npm ci &',
    'env TOKEN=value npm ci',
    'sh -c "npm ci"',
    'npm install "${TOKEN}"',
    'npm install <(curl example.com)',
  ])('keeps other shell expressions offline: %s', (command) => {
    expect(isPackageInstallation(command)).toBe(false);
  });

  const options: ContainerExecutionOptions = {
    runtime: 'docker',
    image: 'trusted-image',
    bundleDirectory: '/trusted/cli',
    trustedDirectories: [],
    runtimeEnv: { OPENAI_API_KEY: 'host-only' },
    environment: ['CI=1', 'HOME=/executor-home'],
    containerHome: '/executor-home',
  };
  const worker: ExecutionWorkerOptions = {
    workspace: '/workspace/project',
    outputDirectory: '/tmp/executor/output',
    sessionId: 'test-executor',
    truncateToolOutputLines: 100,
    truncateToolOutputThreshold: 10000,
    fileReadCacheDisabled: false,
  };

  it.skipIf(process.platform === 'win32')(
    'preserves runtime cancellation errors',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'execution-abort-'));
      const workspace = join(root, 'workspace');
      const bundle = join(root, 'bundle');
      await mkdir(workspace);
      await mkdir(bundle);
      await writeFile(join(bundle, 'execution-worker.js'), '');
      const error = new DOMException('cancelled', 'AbortError');
      const exec = vi
        .spyOn(childProcess, 'execFile')
        .mockImplementation((...args) => {
          const callback = args.at(-1) as (
            error: Error,
            stdout: string,
            stderr: string,
          ) => void;
          callback(error, '', '');
          return {} as childProcess.ChildProcess;
        });
      try {
        await expect(
          ContainerExecutionEnvironment.create(
            { getWorkingDir: () => workspace } as Config,
            { ...options, bundleDirectory: bundle },
            new AbortController().signal,
          ),
        ).rejects.toMatchObject({ name: 'AbortError' });
      } finally {
        exec.mockRestore();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it
    .skipIf(process.platform === 'win32')
    .each(['ancestor', 'equal', 'descendant'])(
    'rejects a %s workspace of dependencies outside the bundle',
    async (relationship) => {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), 'execution-dependency-')),
      );
      const bundle = join(root, 'bundle');
      const dependencies = join(root, 'installation', 'node_modules');
      await mkdir(bundle);
      await mkdir(join(dependencies, 'sharp'), { recursive: true });
      const workspace =
        relationship === 'ancestor'
          ? join(root, 'installation')
          : relationship === 'equal'
            ? dependencies
            : join(dependencies, 'sharp');
      try {
        await expect(
          ContainerExecutionEnvironment.create(
            { getWorkingDir: () => workspace } as Config,
            {
              ...options,
              bundleDirectory: bundle,
              trustedDirectories: [dependencies],
            },
            new AbortController().signal,
          ),
        ).rejects.toThrow('bundle or dependency directories');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it
    .skipIf(process.platform === 'win32')
    .each([
      'ancestor',
      'equal',
      'descendant',
      'symlink-ancestor',
      'symlink-descendant',
    ])(
    'rejects a %s workspace alias of the trusted bundle before runtime access',
    async (relationship) => {
      const root = await mkdtemp(join(tmpdir(), 'execution-bundle-overlap-'));
      const bundle = join(root, 'bundle');
      const chunks = join(bundle, 'chunks');
      await mkdir(chunks, { recursive: true });
      let workspace = relationship.endsWith('ancestor')
        ? root
        : relationship === 'equal'
          ? bundle
          : chunks;
      if (relationship.startsWith('symlink-')) {
        const alias = join(root, 'workspace-alias');
        await symlink(workspace, alias, 'dir');
        workspace = alias;
      }
      try {
        await expect(
          ContainerExecutionEnvironment.create(
            { getWorkingDir: () => workspace } as Config,
            { ...options, bundleDirectory: bundle },
            new AbortController().signal,
          ),
        ).rejects.toThrow('workspace must not overlap the trusted CLI bundle');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'allows disjoint sibling names past the bundle overlap guard',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'execution-bundle-siblings-'));
      const bundle = join(root, 'project');
      const workspace = join(root, 'project-worktree');
      await mkdir(bundle);
      await mkdir(workspace);
      try {
        await expect(
          ContainerExecutionEnvironment.create(
            { getWorkingDir: () => workspace } as Config,
            { ...options, bundleDirectory: bundle },
            new AbortController().signal,
          ),
        ).rejects.toMatchObject({
          code: 'ENOENT',
          path: expect.stringContaining('execution-worker.js'),
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it
    .skipIf(process.platform === 'win32')
    .each(['getGlobalQwenDir', 'getRuntimeBaseDir'] as const)(
    'refuses to mount a workspace containing %s',
    async (getter) => {
      const workspace = await mkdtemp(
        join(tmpdir(), 'qwen-executor-boundary-'),
      );
      const protectedPath = join(workspace, 'private-state');
      await mkdir(protectedPath);
      const mock = vi.spyOn(Storage, getter).mockReturnValue(protectedPath);
      try {
        await expect(
          ContainerExecutionEnvironment.create(
            { getWorkingDir: () => workspace } as Config,
            { ...options, bundleDirectory: workspace },
            new AbortController().signal,
          ),
        ).rejects.toThrow('Qwen credentials or runtime directory');
      } finally {
        mock.mockRestore();
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32').each([
    ['getGlobalQwenDir', true],
    ['getGlobalQwenDir', false],
    ['getRuntimeBaseDir', true],
    ['getRuntimeBaseDir', false],
  ] as const)(
    'resolves an uncreated %s through its symlink ancestor (inside=%s)',
    async (getter, inside) => {
      const root = await mkdtemp(join(tmpdir(), 'execution-protected-root-'));
      const workspace = join(root, 'workspace');
      const bundle = join(root, 'bundle');
      const outside = join(root, 'outside');
      const alias = join(root, 'alias');
      await mkdir(workspace);
      await mkdir(bundle);
      await mkdir(outside);
      await symlink(inside ? workspace : outside, alias, 'dir');
      const protectedPath = join(alias, 'missing', 'private-state');
      const mock = vi.spyOn(Storage, getter).mockReturnValue(protectedPath);
      try {
        const creation = ContainerExecutionEnvironment.create(
          { getWorkingDir: () => workspace } as Config,
          { ...options, bundleDirectory: bundle },
          new AbortController().signal,
        );
        if (inside) {
          await expect(creation).rejects.toThrow(
            'Qwen credentials or runtime directory',
          );
        } else {
          await expect(creation).rejects.toMatchObject({
            code: 'ENOENT',
            path: expect.stringContaining('execution-worker.js'),
          });
        }
        await expect(access(protectedPath)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } finally {
        mock.mockRestore();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32').each(['inside', 'equal', 'symlink'])(
    'rejects a temporary root %s the writable workspace',
    async (relationship) => {
      const root = await mkdtemp(join(tmpdir(), 'execution-temp-boundary-'));
      const workspace = join(root, 'workspace');
      const bundle = join(root, 'bundle');
      await mkdir(workspace);
      await mkdir(bundle);
      let temporaryRoot = workspace;
      if (relationship !== 'equal') {
        temporaryRoot = join(workspace, 'temporary');
        await mkdir(temporaryRoot);
      }
      if (relationship === 'symlink') {
        const alias = join(root, 'temporary-alias');
        await symlink(temporaryRoot, alias, 'dir');
        temporaryRoot = alias;
      }
      vi.stubEnv('TMPDIR', temporaryRoot);
      try {
        await expect(
          ContainerExecutionEnvironment.create(
            { getWorkingDir: () => workspace } as Config,
            { ...options, bundleDirectory: bundle },
            new AbortController().signal,
          ),
        ).rejects.toThrow('temporary directory');
      } finally {
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'mounts only the workspace, trusted bundle and read-only Git mask, without host credentials',
    () => {
      const args = workerContainerArguments(
        options,
        worker,
        'agent-name',
        false,
        '/tmp/mask',
      );
      expect(args.slice(0, 6)).toEqual([
        'create',
        '--init',
        '--interactive',
        '--name',
        'agent-name',
        '--cap-drop',
      ]);
      expect(args).toContain('/workspace/project:/workspace/project');
      expect(args).toContain('/tmp/executor/output:/tmp/executor/output');
      expect(args).toContain('/trusted/cli:/opt/qwen-executor:ro');
      expect(args).toContain('/tmp/mask:/workspace/project/.git:ro');
      expect(
        args.slice(args.indexOf('--network'), args.indexOf('--network') + 2),
      ).toEqual(['--network', 'none']);
      expect(args.join(' ')).not.toMatch(
        /OPENAI_API_KEY|host-only|docker\.sock|--privileged/,
      );
      expect(args.slice(-3)).toEqual([
        'trusted-image',
        '/opt/qwen-executor/execution-worker.js',
        JSON.stringify(worker),
      ]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'allows ordinary networking only for the install worker and preserves rootless ownership',
    () => {
      const args = workerContainerArguments(
        options,
        worker,
        'install-name',
        true,
        '/tmp/mask',
        true,
      );
      expect(args).not.toContain('--network');
      expect(args).not.toContain('--user');
      expect(args).toContain('/tmp/mask:/workspace/project/.git:ro');
      expect(args).toContain('HOME=/executor-home');
    },
  );
});
