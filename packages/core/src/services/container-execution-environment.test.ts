/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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

describe('container execution boundary', () => {
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

  it.each(['getGlobalQwenDir', 'getRuntimeBaseDir'] as const)(
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

  it('mounts only the workspace, trusted bundle and read-only Git mask, without host credentials', () => {
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
  });

  it('allows ordinary networking only for the install worker and preserves rootless ownership', () => {
    const args = workerContainerArguments(
      options,
      worker,
      'install-name',
      true,
      undefined,
      true,
    );
    expect(args).not.toContain('--network');
    expect(args).not.toContain('--user');
    expect(args).not.toContain('/tmp/mask:/workspace/project/.git:ro');
    expect(args).toContain('HOME=/executor-home');
  });
});
