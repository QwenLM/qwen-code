/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config, GitWorktreeService } from '@qwen-code/qwen-code-core';
import {
  SelfEvolveService,
  getSelfEvolveAttemptNodeArgs,
} from './SelfEvolveService.js';

function ok(command: string, cwd: string, stdout = '') {
  return {
    command,
    cwd,
    exitCode: 0,
    stdout,
    stderr: '',
    timedOut: false,
  };
}

describe('SelfEvolveService', () => {
  let tempDir: string;
  let projectDir: string;
  let projectRuntimeDir: string;
  let reviewWorktreePath: string;
  let mockConfig: Config;
  const originalExecArgv = [...process.execArgv];
  const originalArgv = [...process.argv];

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'self-evolve-'));
    projectDir = path.join(tempDir, 'repo');
    projectRuntimeDir = path.join(tempDir, 'runtime-project');
    reviewWorktreePath = path.join(tempDir, 'review-worktree');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(projectRuntimeDir, { recursive: true });
    await fs.mkdir(path.join(projectDir, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, 'package.json'),
      JSON.stringify({ name: 'test-repo' }, null, 2),
    );
    await fs.writeFile(
      path.join(projectDir, 'src', 'feature.ts'),
      '// TODO: tighten the helper\nexport const answer = 42;\n',
    );

    mockConfig = {
      getProjectRoot: () => projectDir,
      storage: {
        getProjectDir: () => projectRuntimeDir,
      },
    } as unknown as Config;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    process.execArgv = [...originalExecArgv];
    process.argv = [...originalArgv];
    vi.restoreAllMocks();
  });

  it('preserves the current Node launch arguments for child attempts', () => {
    process.execArgv = ['--import', 'tsx/esm'];
    process.argv = ['node', 'packages/cli/index.ts'];

    expect(getSelfEvolveAttemptNodeArgs('fix TODO')).toEqual([
      '--import',
      'tsx/esm',
      path.resolve('packages/cli/index.ts'),
      '--prompt',
      'fix TODO',
      '--approval-mode',
      'yolo',
      '--output-format',
      'text',
    ]);
  });

  it('promotes a validated attempt into a clean review branch', async () => {
    await fs.mkdir(path.join(reviewWorktreePath, '.qwen'), {
      recursive: true,
    });

    const setupWorktrees = vi.fn().mockResolvedValue({
      success: true,
      worktreesByName: {
        review: {
          path: reviewWorktreePath,
          branch: 'self-evolve/review',
        },
      },
    });
    const removeWorktree = vi.fn().mockResolvedValue({ success: true });
    const cleanupSession = vi.fn().mockResolvedValue({ success: true });
    let reviewStatusChecks = 0;

    const runCommand = vi.fn(
      async (cwd: string, command: string, args: string[]) => {
        const joined = `${command} ${args.join(' ')}`;
        if (joined === 'git rev-parse --abbrev-ref HEAD') {
          return ok(joined, cwd, 'main\n');
        }
        if (joined === 'git ls-files') {
          return ok(joined, cwd, 'package.json\nsrc/feature.ts\n');
        }
        if (joined === 'git ls-files --others --exclude-standard') {
          return ok(joined, cwd, '');
        }
        if (joined === 'git status --short') {
          reviewStatusChecks += 1;
          return ok(
            joined,
            cwd,
            reviewStatusChecks === 1 ? 'M src/feature.ts\n' : '',
          );
        }
        if (joined === 'git add --all') {
          return ok(joined, cwd);
        }
        if (joined.startsWith('git commit --no-verify -m ')) {
          return ok(joined, cwd, '[branch] commit\n');
        }
        if (joined === 'git reset --hard HEAD') {
          return ok(joined, cwd, 'HEAD is now at review-sha\n');
        }
        if (joined === 'git clean -fd') {
          return ok(joined, cwd, '');
        }
        if (joined === 'git rev-parse HEAD' && cwd === reviewWorktreePath) {
          return ok(joined, cwd, 'review-sha\n');
        }
        if (joined === 'git diff-tree --no-commit-id --name-only -r HEAD') {
          return ok(joined, cwd, 'src/feature.ts\n');
        }
        throw new Error(`Unexpected command: ${joined} @ ${cwd}`);
      },
    );

    const runShellCommand = vi.fn(async (cwd: string, command: string) =>
      ok(command, cwd, ''),
    );

    const runQwenAttempt = vi.fn(async ({ cwd }: { cwd: string }) => {
      await fs.writeFile(
        path.join(cwd, '.qwen', 'self-evolve-report.json'),
        JSON.stringify(
          {
            status: 'success',
            selectedTask: {
              title: 'Address TODO in src/feature.ts:1',
              source: 'todo-comment',
              location: 'src/feature.ts:1',
            },
            summary: 'Tightened the helper around the TODO note.',
            learnings: ['Kept the edit small and local.'],
            validation: [{ command: 'npm run lint', summary: 'passed' }],
            suggestedCommitMessage: 'fix(cli): tighten self-evolve TODO helper',
            changedFiles: ['src/feature.ts'],
          },
          null,
          2,
        ),
      );
      return ok('qwen', cwd, 'done');
    });

    const service = new SelfEvolveService({
      createWorktreeService: () =>
        ({
          setupWorktrees,
          removeWorktree,
          cleanupSession,
        }) as unknown as GitWorktreeService,
      runCommand,
      runShellCommand,
      runQwenAttempt,
    });

    const result = await service.run(mockConfig, {
      direction: 'focus the CLI TODO path',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('Expected success result');
    }
    expect(result.branch).toBe('self-evolve/review');
    expect(result.commitSha).toBe('review-sha');
    expect(result.changedFiles).toEqual(['src/feature.ts']);
    expect(result.direction).toBe('focus the CLI TODO path');
    expect(setupWorktrees).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeNames: ['review'],
        branchToken: expect.stringMatching(
          /^focus-the-cli-todo-path-[a-f0-9]{6}$/,
        ),
      }),
    );
    expect(runQwenAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          'User direction for task selection: focus the CLI TODO path',
        ),
      }),
    );
    expect(removeWorktree).toHaveBeenCalledWith(reviewWorktreePath);
    expect(cleanupSession).not.toHaveBeenCalled();
  });

  it('discards the isolated attempt and records learnings when validation fails', async () => {
    await fs.mkdir(path.join(reviewWorktreePath, '.qwen'), {
      recursive: true,
    });

    const cleanupSession = vi.fn().mockResolvedValue({ success: true });
    const runCommand = vi.fn(
      async (cwd: string, command: string, args: string[]) => {
        const joined = `${command} ${args.join(' ')}`;
        if (joined === 'git rev-parse --abbrev-ref HEAD') {
          return ok(joined, cwd, 'main\n');
        }
        if (joined === 'git ls-files') {
          return ok(joined, cwd, 'package.json\nsrc/feature.ts\n');
        }
        if (joined === 'git ls-files --others --exclude-standard') {
          return ok(joined, cwd, '');
        }
        throw new Error(`Unexpected command: ${joined}`);
      },
    );
    const runShellCommand = vi.fn(async (cwd: string, command: string) => {
      if (cwd === projectDir) {
        return ok(command, cwd, '');
      }
      return {
        command,
        cwd,
        exitCode: 1,
        stdout: '',
        stderr: 'lint failed',
        timedOut: false,
      };
    });

    const runQwenAttempt = vi.fn(async ({ cwd }: { cwd: string }) => {
      await fs.writeFile(
        path.join(cwd, '.qwen', 'self-evolve-report.json'),
        JSON.stringify(
          {
            status: 'success',
            selectedTask: {
              title: 'Address TODO in src/feature.ts:1',
              source: 'todo-comment',
              location: 'src/feature.ts:1',
            },
            summary: 'Attempted the TODO fix.',
            learnings: ['Validation matters.'],
            validation: [{ command: 'npm run lint', summary: 'failed' }],
          },
          null,
          2,
        ),
      );
      return ok('qwen', cwd, 'done');
    });

    const service = new SelfEvolveService({
      createWorktreeService: () =>
        ({
          setupWorktrees: vi.fn().mockResolvedValue({
            success: true,
            worktreesByName: {
              review: {
                path: reviewWorktreePath,
                branch: 'self-evolve/review',
              },
            },
          }),
          removeWorktree: vi.fn(),
          cleanupSession,
        }) as unknown as GitWorktreeService,
      runCommand,
      runShellCommand,
      runQwenAttempt,
    });

    const result = await service.run(mockConfig, {
      direction: 'prefer TODO cleanup',
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected failure result');
    }
    expect(result.summary).toBe(
      'The isolated self-evolve change failed validation.',
    );
    expect(result.direction).toBe('prefer TODO cleanup');
    expect(result.learnings).toContain('Validation failed: npm run lint');
    expect(cleanupSession).toHaveBeenCalledWith(
      expect.stringContaining('-review'),
    );
    const record = JSON.parse(await fs.readFile(result.recordPath, 'utf8'));
    expect(record.summary).toBe(result.summary);
    expect(record.direction).toBe('prefer TODO cleanup');
  });
});
