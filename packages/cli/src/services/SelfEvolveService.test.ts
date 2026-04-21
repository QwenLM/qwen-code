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
  getSelfEvolveSessionNodeArgs,
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

function successTurn() {
  return {
    stdout: '',
    stderr: '',
    timedOut: false,
    childExited: false,
    result: {
      type: 'result',
      subtype: 'success',
      uuid: 'turn',
      session_id: 'session',
      is_error: false,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      result: 'done',
      usage: {
        input_tokens: 1,
        output_tokens: 1,
      },
      permission_denials: [],
    } as const,
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

  it('preserves the current Node launch arguments for child sessions', () => {
    process.execArgv = ['--import', 'tsx/esm'];
    process.argv = ['node', 'packages/cli/index.ts'];

    expect(
      getSelfEvolveSessionNodeArgs('123e4567-e89b-12d3-a456-426614174000'),
    ).toEqual([
      '--import',
      'tsx/esm',
      path.resolve('packages/cli/index.ts'),
      '--approval-mode',
      'yolo',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--session-id',
      '123e4567-e89b-12d3-a456-426614174000',
    ]);
  });

  it('retries failed validation in the same child session and promotes a clean review branch', async () => {
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
    let validationChecks = 0;

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

    const runShellCommand = vi.fn(async (cwd: string, command: string) => {
      if (cwd === projectDir) {
        return ok(command, cwd, '');
      }
      validationChecks += 1;
      if (validationChecks === 1) {
        return {
          command,
          cwd,
          exitCode: 1,
          stdout: '',
          stderr: 'lint failed',
          timedOut: false,
        };
      }
      return ok(command, cwd, '');
    });

    const sendPrompt = vi.fn(async (_prompt: string) => {
      const report =
        sendPrompt.mock.calls.length === 1
          ? {
              round: 1,
              status: 'validation_failed',
              selectedCandidateIndex: 1,
              selectedTask: {
                title: 'Address TODO in src/feature.ts:1',
                source: 'todo-comment',
                location: 'src/feature.ts:1',
              },
              summary: 'First round tightened the helper but lint still fails.',
              learnings: ['The first pass left a lint issue behind.'],
              validation: [{ command: 'npm run lint', summary: 'failed' }],
              suggestedCommitMessage:
                'fix(cli): tighten self-evolve TODO helper',
              changedFiles: ['src/feature.ts'],
            }
          : {
              round: 2,
              status: 'success',
              selectedCandidateIndex: 1,
              selectedTask: {
                title: 'Address TODO in src/feature.ts:1',
                source: 'todo-comment',
                location: 'src/feature.ts:1',
              },
              summary: 'Second round fixed the remaining lint issue.',
              learnings: ['Kept the task locked and fixed the lint failure.'],
              validation: [{ command: 'npm run lint', summary: 'passed' }],
              suggestedCommitMessage:
                'fix(cli): tighten self-evolve TODO helper',
              changedFiles: ['src/feature.ts'],
            };
      await fs.writeFile(
        path.join(reviewWorktreePath, '.qwen', 'self-evolve-report.json'),
        JSON.stringify(report, null, 2),
      );
      return successTurn();
    });
    const shutdown = vi
      .fn()
      .mockResolvedValue(ok('node qwen', reviewWorktreePath));
    const createQwenSession = vi.fn(() => ({
      sendPrompt,
      shutdown,
    }));

    const service = new SelfEvolveService({
      createWorktreeService: () =>
        ({
          setupWorktrees,
          removeWorktree,
          cleanupSession,
        }) as unknown as GitWorktreeService,
      runCommand,
      runShellCommand,
      createQwenSession: createQwenSession as never,
    });

    const result = await service.run(mockConfig, {
      direction: 'focus the CLI TODO path',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('Expected success result');
    }
    expect(result.roundsAttempted).toBe(2);
    expect(result.branch).toBe('self-evolve/review');
    expect(result.commitSha).toBe('review-sha');
    expect(result.changedFiles).toEqual(['src/feature.ts']);
    expect(result.selectedTask).toBe('Address TODO in src/feature.ts:1');
    expect(sendPrompt).toHaveBeenCalledTimes(2);
    expect(sendPrompt.mock.calls[0]?.[0]).toContain(
      'User direction for task selection: focus the CLI TODO path',
    );
    expect(sendPrompt.mock.calls[1]?.[0]).toContain(
      'This is repair round 2 of 5.',
    );
    expect(sendPrompt.mock.calls[1]?.[0]).toContain(
      'Locked candidate title: Address TODO in src/feature.ts:1',
    );
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(removeWorktree).toHaveBeenCalledWith(reviewWorktreePath);
    expect(cleanupSession).not.toHaveBeenCalled();
  });

  it('discards the isolated change only after exhausting validation retries in the same child session', async () => {
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

    const sendPrompt = vi.fn(async () => {
      const round = sendPrompt.mock.calls.length;
      await fs.writeFile(
        path.join(reviewWorktreePath, '.qwen', 'self-evolve-report.json'),
        JSON.stringify(
          {
            round,
            status: 'validation_failed',
            selectedCandidateIndex: 1,
            selectedTask: {
              title: 'Address TODO in src/feature.ts:1',
              source: 'todo-comment',
              location: 'src/feature.ts:1',
            },
            summary: `Round ${round} still fails lint.`,
            learnings: ['Still narrowing down the lint issue.'],
            validation: [{ command: 'npm run lint', summary: 'failed' }],
            changedFiles: ['src/feature.ts'],
          },
          null,
          2,
        ),
      );
      return successTurn();
    });
    const shutdown = vi
      .fn()
      .mockResolvedValue(ok('node qwen', reviewWorktreePath));

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
      createQwenSession: vi.fn(() => ({
        sendPrompt,
        shutdown,
      })) as never,
    });

    const result = await service.run(mockConfig, {
      direction: 'prefer TODO cleanup',
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected failure result');
    }
    expect(result.status).toBe('max_retries_exhausted');
    expect(result.roundsAttempted).toBe(5);
    expect(result.summary).toContain('5 unsuccessful validation rounds');
    expect(sendPrompt).toHaveBeenCalledTimes(5);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(cleanupSession).toHaveBeenCalledWith(
      expect.stringContaining('-review'),
    );
  });

  it('returns no_safe_task when no discovered candidates match the requested direction', async () => {
    await fs.writeFile(
      path.join(projectDir, 'package.json'),
      JSON.stringify(
        {
          name: 'test-repo',
          scripts: {
            typecheck: 'tsc --noEmit',
          },
        },
        null,
        2,
      ),
    );
    await fs.writeFile(
      path.join(projectDir, 'src', 'unrelated.ts'),
      'export const broken = missing.value;\n',
    );

    const setupWorktrees = vi.fn();
    const runCommand = vi.fn(
      async (cwd: string, command: string, args: string[]) => {
        const joined = `${command} ${args.join(' ')}`;
        if (joined === 'git rev-parse --abbrev-ref HEAD') {
          return ok(joined, cwd, 'main\n');
        }
        if (joined === 'git ls-files') {
          return ok(joined, cwd, 'package.json\nsrc/unrelated.ts\n');
        }
        if (joined === 'git ls-files --others --exclude-standard') {
          return ok(joined, cwd, '');
        }
        throw new Error(`Unexpected command: ${joined}`);
      },
    );
    const runShellCommand = vi.fn(async (cwd: string, command: string) => {
      if (cwd !== projectDir || command !== 'npm run typecheck') {
        return ok(command, cwd, '');
      }
      return {
        command,
        cwd,
        exitCode: 1,
        stdout:
          "src/unrelated.ts(1,23): error TS2304: Cannot find name 'missing'.\n",
        stderr: '',
        timedOut: false,
      };
    });
    const createQwenSession = vi.fn();

    const service = new SelfEvolveService({
      createWorktreeService: () =>
        ({
          setupWorktrees,
        }) as unknown as GitWorktreeService,
      runCommand,
      runShellCommand,
      createQwenSession: createQwenSession as never,
    });

    const result = await service.run(mockConfig, {
      direction: '专注于self-evolve这个功能的ui和ux的优化',
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected failure result');
    }
    expect(result.status).toBe('no_safe_task');
    expect(result.summary).toBe(
      'No discovered self-evolve candidates matched the requested direction.',
    );
    expect(setupWorktrees).not.toHaveBeenCalled();
    expect(createQwenSession).not.toHaveBeenCalled();
  });

  it('rejects retry rounds that drift to a different selected task', async () => {
    await fs.mkdir(path.join(reviewWorktreePath, '.qwen'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(projectDir, 'src', 'other.ts'),
      '// TODO: adjust a different helper\nexport const other = 1;\n',
    );

    const cleanupSession = vi.fn().mockResolvedValue({ success: true });
    const runCommand = vi.fn(
      async (cwd: string, command: string, args: string[]) => {
        const joined = `${command} ${args.join(' ')}`;
        if (joined === 'git rev-parse --abbrev-ref HEAD') {
          return ok(joined, cwd, 'main\n');
        }
        if (joined === 'git ls-files') {
          return ok(
            joined,
            cwd,
            'package.json\nsrc/feature.ts\nsrc/other.ts\n',
          );
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
    const sendPrompt = vi.fn(async () => {
      const report =
        sendPrompt.mock.calls.length === 1
          ? {
              round: 1,
              status: 'validation_failed',
              selectedCandidateIndex: 1,
              selectedTask: {
                title: 'Address TODO in src/feature.ts:1',
                source: 'todo-comment',
                location: 'src/feature.ts:1',
              },
              summary: 'Round 1 picked the feature TODO.',
              validation: [{ command: 'npm run lint', summary: 'failed' }],
            }
          : {
              round: 2,
              status: 'success',
              selectedCandidateIndex: 2,
              selectedTask: {
                title: 'Address TODO in src/other.ts:1',
                source: 'todo-comment',
                location: 'src/other.ts:1',
              },
              summary: 'Round 2 drifted to a different TODO.',
              validation: [{ command: 'npm run lint', summary: 'passed' }],
            };
      await fs.writeFile(
        path.join(reviewWorktreePath, '.qwen', 'self-evolve-report.json'),
        JSON.stringify(report, null, 2),
      );
      return successTurn();
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
      createQwenSession: vi.fn(() => ({
        sendPrompt,
        shutdown: vi
          .fn()
          .mockResolvedValue(ok('node qwen', reviewWorktreePath)),
      })) as never,
    });

    const result = await service.run(mockConfig);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected failure result');
    }
    expect(result.summary).toBe(
      'The isolated self-evolve session drifted away from the originally selected task.',
    );
    expect(result.selectedTask).toBe('Address TODO in src/feature.ts:1');
    expect(cleanupSession).toHaveBeenCalledWith(
      expect.stringContaining('-review'),
    );
  });
});
