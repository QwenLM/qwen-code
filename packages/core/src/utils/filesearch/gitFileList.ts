/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { internalGitArgs } from '../gitCommandPolicy.js';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { createGitCommandEnv } from '../gitUtils.js';

export interface GitFileListOptions {
  cwd: string;
  args: string[];
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * Runs a git command that prints one path per line without buffering stdout.
 */
export function listGitFiles(options: GitFileListOptions): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const child = spawn(
      'git',
      [
        ...internalGitArgs(),
        '-C',
        options.cwd,
        '-c',
        'core.quotepath=false',
        'ls-files',
        ...options.args,
      ],
      {
        env: createGitCommandEnv(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    const decoder = new StringDecoder('utf8');
    const paths: string[] = [];
    let remainder = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abortHandler);
      if (error) {
        reject(error);
      } else {
        resolve(paths);
      }
    };

    const abortHandler = () => {
      aborted = true;
      child.kill();
      const error = new Error('git ls-files aborted');
      error.name = 'AbortError';
      finish(error);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
      const error = new Error('git ls-files timed out');
      error.name = 'AbortError';
      finish(error);
    }, options.timeoutMs);
    timeout.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      const data = remainder + decoder.write(chunk);
      const lines = data.split('\n');
      remainder = lines.pop() ?? '';
      for (const line of lines) {
        const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
        if (normalized) paths.push(normalized);
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) {
        stderr += chunk.toString('utf8');
      }
    });

    child.on('error', (error) => {
      finish(error);
    });

    child.on('close', (code) => {
      if (settled) return;
      if (aborted || timedOut) {
        const error = new Error(
          timedOut ? 'git ls-files timed out' : 'git ls-files aborted',
        );
        error.name = 'AbortError';
        finish(error);
        return;
      }

      const tail = remainder + decoder.end();
      const normalizedTail = tail.endsWith('\r') ? tail.slice(0, -1) : tail;
      if (normalizedTail) paths.push(normalizedTail);

      if (code === 0) {
        finish();
        return;
      }

      const detail = stderr.trim();
      finish(
        new Error(
          `git ls-files exited with code ${String(code)}${detail ? `: ${detail}` : ''}`,
        ),
      );
    });

    if (options.signal?.aborted) {
      abortHandler();
    } else {
      options.signal?.addEventListener('abort', abortHandler, { once: true });
    }
  });
}

/** Best-effort mtime for the repository's actual index, including worktrees. */
export function getGitIndexMtime(gitRoot: string | null): number | null {
  if (!gitRoot) return null;

  try {
    const dotGitPath = path.join(gitRoot, '.git');
    const stat = fs.statSync(dotGitPath);
    let gitDirectory = dotGitPath;

    if (stat.isFile()) {
      const content = fs.readFileSync(dotGitPath, 'utf8').trim();
      const match = /^gitdir:\s*(.+)$/i.exec(content);
      if (!match) return null;
      gitDirectory = path.resolve(gitRoot, match[1]);
    }

    return fs.statSync(path.join(gitDirectory, 'index')).mtimeMs;
  } catch {
    return null;
  }
}
