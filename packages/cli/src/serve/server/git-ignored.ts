/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { gitEnv } from '@qwen-code/qwen-code-core/utils/git-branches.js';
import { NO_EXEC_CONFIG } from '@qwen-code/qwen-code-core/utils/gitUtils.js';

export function isGitIgnorePaths(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 256 &&
    value.every(
      (entry: unknown) =>
        typeof entry === 'string' &&
        entry.length > 0 &&
        entry.length <= 4096 &&
        !entry.startsWith('/') &&
        !/^[a-zA-Z]:/.test(entry) &&
        !entry.includes('\\') &&
        !entry.includes('\0') &&
        !entry.split('/').some((part) => part === '..' || part === '.'),
    )
  );
}

export async function getGitIgnoredPaths(
  cwd: string,
  paths: readonly string[],
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string[]> {
  const requestSignal = AbortSignal.any([
    AbortSignal.timeout(5_000),
    ...(signal ? [signal] : []),
  ]);
  return collectGitIgnoredPaths(
    paths,
    (batch) =>
      new Promise((resolve, reject) => {
        const child = execFile(
          'git',
          [...NO_EXEC_CONFIG, 'check-ignore', '-z', '--stdin'],
          {
            cwd,
            env: { ...gitEnv(env), LC_ALL: 'C' },
            signal: requestSignal,
            timeout: 5_000,
            maxBuffer: 2 * 1024 * 1024,
          },
          (error, stdout, stderr) => {
            if (error && (error.killed || typeof error.code !== 'number'))
              reject(new Error('Git ignore status is unavailable'));
            else
              resolve({
                exitCode: (error?.code as number) ?? 0,
                stdout,
                stderr,
              });
          },
        );
        child.stdin?.on('error', () => {});
        child.stdin?.end(batch.map((entry) => `./${entry}\0`).join(''));
      }),
    requestSignal,
  );
}

export async function collectGitIgnoredPaths(
  paths: readonly string[],
  query: (
    paths: readonly string[],
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  signal: AbortSignal,
  batchSize = 256,
): Promise<string[]> {
  let remaining = 32;
  const ignored = new Set<string>();
  const probe = async (batch: readonly string[]): Promise<void> => {
    if (!batch.length || signal.aborted || remaining-- <= 0) return;
    let result: Awaited<ReturnType<typeof query>>;
    try {
      result = await query(batch);
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
    for (const entry of result.stdout.split('\0').filter(Boolean)) {
      ignored.add(entry.replace(/^\.\//, ''));
    }
    if (result.exitCode === 0 || result.exitCode === 1) return;
    if (result.stderr.includes('not a git repository')) return;
    if (
      result.stderr.includes('beyond a symbolic link') ||
      result.stderr.includes('is in submodule')
    ) {
      if (batch.length === 1) return;
      const unknown = batch.filter((entry) => !ignored.has(entry));
      const middle = Math.ceil(unknown.length / 2);
      await probe(unknown.slice(0, middle));
      await probe(unknown.slice(middle));
      return;
    }
    throw new Error('Git ignore status is unavailable');
  };
  for (let index = 0; index < paths.length; index += batchSize) {
    await probe(paths.slice(index, index + batchSize));
  }
  return [...ignored];
}
