/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
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
import {
  isShellResultDisplay,
  shellResultText,
} from '../utils/shell-result.js';

/** Runs `body` in a fresh temporary directory, removed afterwards. */
async function inTempDir(
  prefix: string,
  body: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

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
    {
      llmContent: 'installed package',
      returnDisplay: {
        type: 'shell_result',
        version: 1,
        text: 'installation complete',
        output: 'installed package',
        directory: '/workspace',
        exitCode: 0,
        signal: null,
        pid: 42,
        error: null,
        outcome: 'completed',
        notices: ['existing notice'],
        truncated: false,
        outputFiles: [],
      },
      outputBudgetApplied: true,
    },
  ] satisfies ToolResult[])(
    'preserves the tool result and cleanup ownership when installation cleanup fails: %j',
    (toolResult) =>
      inTempDir('execution-cleanup-', async (temporaryDirectory) => {
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
        const result = await environment.execute(
          'install',
          new AbortController().signal,
        );
        expect(JSON.stringify(result.llmContent)).toContain(
          typeof toolResult.llmContent === 'string'
            ? toolResult.llmContent
            : toolResult.llmContent[0].text,
        );
        expect(shellResultText(result.returnDisplay)).toContain(
          shellResultText(toolResult.returnDisplay),
        );
        expect(JSON.stringify(result.llmContent)).toContain(
          'Container cleanup failed after tool execution',
        );
        expect(shellResultText(result.returnDisplay)).toContain(
          'do not automatically retry',
        );
        if (isShellResultDisplay(toolResult.returnDisplay)) {
          expect(result.returnDisplay).toMatchObject({
            output: toolResult.returnDisplay.output,
            notices: [
              'existing notice',
              expect.stringContaining('Container cleanup failed'),
            ],
          });
        }
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
      }),
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
  const onPosix = it.skipIf(process.platform === 'win32');

  /** Creates an environment for `workspace`, overriding `options`. */
  const create = (
    workspace: string,
    overrides: Partial<ContainerExecutionOptions>,
  ) =>
    ContainerExecutionEnvironment.create(
      { getWorkingDir: () => workspace } as Config,
      { ...options, ...overrides },
      new AbortController().signal,
    );

  onPosix.each(['ancestor', 'equal', 'descendant'])(
    'rejects a %s workspace of dependencies outside the bundle',
    (relationship) =>
      inTempDir('execution-dependency-', async (directory) => {
        const root = await realpath(directory);
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
        await expect(
          create(workspace, {
            bundleDirectory: bundle,
            trustedDirectories: [dependencies],
          }),
        ).rejects.toThrow('bundle or dependency directories');
      }),
  );

  onPosix.each([
    'ancestor',
    'equal',
    'descendant',
    'symlink-ancestor',
    'symlink-descendant',
  ])(
    'rejects a %s workspace alias of the trusted bundle before runtime access',
    (relationship) =>
      inTempDir('execution-bundle-overlap-', async (root) => {
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
        await expect(
          create(workspace, { bundleDirectory: bundle }),
        ).rejects.toThrow('workspace must not overlap the trusted CLI bundle');
      }),
  );

  onPosix('allows disjoint sibling names past the bundle overlap guard', () =>
    inTempDir('execution-bundle-siblings-', async (root) => {
      const bundle = join(root, 'project');
      const workspace = join(root, 'project-worktree');
      for (const directory of [bundle, workspace]) await mkdir(directory);
      await expect(
        create(workspace, { bundleDirectory: bundle }),
      ).rejects.toMatchObject({
        code: 'ENOENT',
        path: expect.stringContaining('execution-worker.js'),
      });
    }),
  );

  onPosix.each(['getGlobalQwenDir', 'getRuntimeBaseDir'] as const)(
    'refuses to mount a workspace containing %s',
    (getter) =>
      inTempDir('qwen-executor-boundary-', async (workspace) => {
        const protectedPath = join(workspace, 'private-state');
        await mkdir(protectedPath);
        const mock = vi.spyOn(Storage, getter).mockReturnValue(protectedPath);
        try {
          await expect(
            create(workspace, { bundleDirectory: workspace }),
          ).rejects.toThrow('Qwen credentials or runtime directory');
        } finally {
          mock.mockRestore();
        }
      }),
  );

  onPosix.each([
    ['getGlobalQwenDir', true],
    ['getGlobalQwenDir', false],
    ['getRuntimeBaseDir', true],
    ['getRuntimeBaseDir', false],
  ] as const)(
    'resolves an uncreated %s through its symlink ancestor (inside=%s)',
    (getter, inside) =>
      inTempDir('execution-protected-root-', async (root) => {
        const workspace = join(root, 'workspace');
        const bundle = join(root, 'bundle');
        const outside = join(root, 'outside');
        const alias = join(root, 'alias');
        for (const directory of [workspace, bundle, outside])
          await mkdir(directory);
        await symlink(inside ? workspace : outside, alias, 'dir');
        const protectedPath = join(alias, 'missing', 'private-state');
        const mock = vi.spyOn(Storage, getter).mockReturnValue(protectedPath);
        try {
          const creation = create(workspace, { bundleDirectory: bundle });
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
        }
      }),
  );

  onPosix.each(['inside', 'equal', 'symlink'])(
    'rejects a temporary root %s the writable workspace',
    (relationship) =>
      inTempDir('execution-temp-boundary-', async (root) => {
        const workspace = join(root, 'workspace');
        const bundle = join(root, 'bundle');
        for (const directory of [workspace, bundle]) await mkdir(directory);
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
            create(workspace, { bundleDirectory: bundle }),
          ).rejects.toThrow('temporary directory');
        } finally {
          vi.unstubAllEnvs();
        }
      }),
  );

  onPosix(
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

  onPosix(
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
