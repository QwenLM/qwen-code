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

function partialTextEvent(text: string) {
  return {
    type: 'stream_event',
    uuid: 'stream-1',
    session_id: 'session',
    parent_tool_use_id: null,
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'text_delta',
        text,
      },
    },
  } as const;
}

function assistantTextMessage(text: string) {
  return {
    type: 'assistant',
    uuid: 'assistant-1',
    session_id: 'session',
    parent_tool_use_id: null,
    message: {
      id: 'message-1',
      type: 'message',
      role: 'assistant',
      model: 'qwen',
      content: [
        {
          type: 'text',
          text,
        },
      ],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
      },
    },
  } as const;
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

  it('accepts a child-owned implementation and validation loop in a single child session', async () => {
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

    const runShellCommand = vi.fn();
    const sendPrompt = vi.fn(
      async (
        _prompt: string,
        _timeoutMs: number,
        onStreamEvent?: (message: ReturnType<typeof partialTextEvent>) => void,
      ) => {
        onStreamEvent?.(
          partialTextEvent(
            `${[
              'SELF_EVOLVE_PROGRESS {"kind":"selected_task","round":1,"message":"Selected Address TODO in src/feature.ts:1"}',
              'SELF_EVOLVE_PROGRESS {"kind":"command","round":1,"message":"Running npm run lint","command":"npm run lint"}',
              'SELF_EVOLVE_PROGRESS {"kind":"command_result","round":1,"message":"npm run lint failed with one remaining warning","command":"npm run lint"}',
              'SELF_EVOLVE_PROGRESS {"kind":"round_start","round":2,"message":"Repairing the remaining lint issue."}',
              'SELF_EVOLVE_PROGRESS {"kind":"command_result","round":2,"message":"npm run lint passed","command":"npm run lint"}',
            ].join('\n')}\n`,
          ),
        );

        await fs.writeFile(
          path.join(reviewWorktreePath, '.qwen', 'self-evolve-report.json'),
          JSON.stringify(
            {
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
            },
            null,
            2,
          ),
        );
        return successTurn();
      },
    );
    const shutdown = vi
      .fn()
      .mockResolvedValue(ok('node qwen', reviewWorktreePath));
    const createQwenSession = vi.fn(() => ({
      sendPrompt,
      shutdown,
    }));
    const progressEvents: Array<{ stage: string; message: string }> = [];

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
      onProgress: (event) =>
        progressEvents.push({
          stage: event.stage,
          message: event.message,
        }),
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
    expect(result.selectedTaskSource).toBe('todo-comment');
    expect(result.selectedTaskLocation).toBe('src/feature.ts:1');
    expect(result.validation).toEqual(['passed: npm run lint']);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(sendPrompt.mock.calls[0]?.[0]).toContain(
      'Own the full implementation and validation loop inside this single child session',
    );
    expect(sendPrompt.mock.calls[0]?.[0]).toContain(
      'SELF_EVOLVE_PROGRESS {"kind":"selected_task|round_start|command|command_result|final"',
    );
    expect(sendPrompt.mock.calls[0]?.[0]).toContain(
      'After you choose the candidate, emit the selected_task progress line immediately before any further inspection, editing, or command execution.',
    );
    expect(sendPrompt.mock.calls[0]?.[0]).toContain(
      'Small does not mean trivial: the change must still materially improve correctness, reliability, usability, maintainability, or a real user/developer workflow.',
    );
    expect(sendPrompt.mock.calls[0]?.[0]).toContain(
      'Do not treat low-signal churn as success: avoid trivial copy tweaks, wording polish, comment-only edits, formatting-only edits, or other tiny changes that do not materially improve the product or workflow.',
    );
    expect(runShellCommand).not.toHaveBeenCalled();
    expect(progressEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'child_activity',
          message: expect.stringContaining(
            'Child round 1 [selected_task]: Selected Address TODO in src/feature.ts:1',
          ),
        }),
        expect.objectContaining({
          stage: 'child_activity',
          message: expect.stringContaining(
            'Child round 2 [command_result]: npm run lint passed',
          ),
        }),
      ]),
    );
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(removeWorktree).toHaveBeenCalledWith(reviewWorktreePath);
    expect(cleanupSession).not.toHaveBeenCalled();
  });

  it('parses selected_task progress from assistant messages and deduplicates repeated progress lines', async () => {
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

    const sendPrompt = vi.fn(
      async (
        _prompt: string,
        _timeoutMs: number,
        onStreamEvent?: (
          message:
            | ReturnType<typeof partialTextEvent>
            | ReturnType<typeof assistantTextMessage>,
        ) => void,
      ) => {
        const selectedTaskLine =
          'SELF_EVOLVE_PROGRESS {"kind":"selected_task","round":1,"message":"Selected Address TODO in src/feature.ts:1"}';
        onStreamEvent?.(partialTextEvent(`${selectedTaskLine}\n`));
        onStreamEvent?.(
          assistantTextMessage(
            [
              selectedTaskLine,
              'SELF_EVOLVE_PROGRESS {"kind":"command_result","round":1,"message":"npm run lint passed","command":"npm run lint"}',
            ].join('\n'),
          ),
        );

        await fs.writeFile(
          path.join(reviewWorktreePath, '.qwen', 'self-evolve-report.json'),
          JSON.stringify(
            {
              round: 1,
              status: 'success',
              selectedCandidateIndex: 1,
              selectedTask: {
                title: 'Address TODO in src/feature.ts:1',
                source: 'todo-comment',
                location: 'src/feature.ts:1',
              },
              summary: 'Captured child progress from an assistant message.',
              learnings: ['The selected task was surfaced before validation.'],
              validation: [{ command: 'npm run lint', summary: 'passed' }],
              suggestedCommitMessage:
                'fix(cli): surface child progress from assistant text',
              changedFiles: ['src/feature.ts'],
            },
            null,
            2,
          ),
        );
        return successTurn();
      },
    );
    const shutdown = vi
      .fn()
      .mockResolvedValue(ok('node qwen', reviewWorktreePath));
    const progressEvents: Array<{ stage: string; message: string }> = [];

    const service = new SelfEvolveService({
      createWorktreeService: () =>
        ({
          setupWorktrees,
          removeWorktree,
          cleanupSession,
        }) as unknown as GitWorktreeService,
      runCommand,
      runShellCommand: vi.fn(),
      createQwenSession: vi.fn(() => ({
        sendPrompt,
        shutdown,
      })) as never,
    });

    const result = await service.run(mockConfig, {
      onProgress: (event) =>
        progressEvents.push({
          stage: event.stage,
          message: event.message,
        }),
    });

    expect(result.ok).toBe(true);
    const selectedTaskMessages = progressEvents.filter((event) =>
      event.message.includes(
        'Child round 1 [selected_task]: Selected Address TODO in src/feature.ts:1',
      ),
    );
    expect(selectedTaskMessages).toHaveLength(1);
    expect(progressEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'child_activity',
          message: expect.stringContaining(
            'Child round 1 [command_result]: npm run lint passed',
          ),
        }),
      ]),
    );
  });

  it('discards the isolated change when the child reports exhausted internal retries', async () => {
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
    const runShellCommand = vi.fn();

    const sendPrompt = vi.fn(async () => {
      await fs.writeFile(
        path.join(reviewWorktreePath, '.qwen', 'self-evolve-report.json'),
        JSON.stringify(
          {
            round: 5,
            status: 'max_retries_exhausted',
            selectedCandidateIndex: 1,
            selectedTask: {
              title: 'Address TODO in src/feature.ts:1',
              source: 'todo-comment',
              location: 'src/feature.ts:1',
            },
            summary:
              'The isolated self-evolve change was discarded after 5 unsuccessful internal validation rounds.',
            learnings: [
              'npm run lint kept failing after the fifth internal repair.',
            ],
            validation: [{ command: 'npm run lint', summary: 'failed' }],
            changedFiles: [],
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
    expect(result.summary).toContain(
      '5 unsuccessful internal validation rounds',
    );
    expect(result.validation).toEqual(['failed: npm run lint']);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(runShellCommand).not.toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(cleanupSession).toHaveBeenCalledWith(
      expect.stringContaining('-review'),
    );
  });

  it('can execute a direction-led task even when built-in discovery finds no candidates', async () => {
    await fs.mkdir(path.join(reviewWorktreePath, '.qwen'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(projectDir, 'src', 'feature.ts'),
      'export const answer = 42;\n',
    );

    const direction = '专注于self-evolve这个功能的ui和ux的优化';
    const directionCandidateTitle = `Advance user direction: ${direction}`;
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
        throw new Error(`Unexpected command: ${joined}`);
      },
    );
    const runShellCommand = vi.fn();
    const sendPrompt = vi.fn(async (prompt: string) => {
      expect(prompt).toContain(directionCandidateTitle);
      expect(prompt).toContain('If you choose the [user-direction] candidate');
      expect(prompt).toContain(
        'If the best candidate would only result in a negligible change, write status "no_safe_task" instead of forcing a weak edit.',
      );
      await fs.writeFile(
        path.join(reviewWorktreePath, '.qwen', 'self-evolve-report.json'),
        JSON.stringify(
          {
            round: 1,
            status: 'success',
            selectedCandidateIndex: 1,
            selectedTask: {
              title: directionCandidateTitle,
              source: 'user-direction',
              location: 'packages/cli/src/ui/commands/selfEvolveCommand.ts',
              rationale:
                'Narrowed the brief to the recurring self-evolve scheduling flow and confirmation behavior.',
            },
            summary: 'Improved the recurring self-evolve scheduling flow UX.',
            learnings: [
              'The broad UI/UX brief was narrowed to the scheduling confirmation flow instead of a copy-only tweak.',
            ],
            validation: [{ command: 'npm run lint', summary: 'passed' }],
            suggestedCommitMessage:
              'fix(cli): improve self-evolve scheduling flow UX',
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
          setupWorktrees,
          removeWorktree,
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
      direction,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('Expected success result');
    }
    expect(result.selectedTask).toBe(directionCandidateTitle);
    expect(result.selectedTaskSource).toBe('user-direction');
    expect(result.selectedTaskLocation).toBe(
      'packages/cli/src/ui/commands/selfEvolveCommand.ts',
    );
    expect(result.selectedTaskRationale).toBe(
      'Narrowed the brief to the recurring self-evolve scheduling flow and confirmation behavior.',
    );
    expect(result.summary).toBe(
      'Improved the recurring self-evolve scheduling flow UX.',
    );
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(runShellCommand).not.toHaveBeenCalled();
    expect(removeWorktree).toHaveBeenCalledWith(reviewWorktreePath);
    expect(cleanupSession).not.toHaveBeenCalled();
  });

  it('rejects final reports that do not select one of the provided candidates', async () => {
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
    const runShellCommand = vi.fn();
    const sendPrompt = vi.fn(async () => {
      await fs.writeFile(
        path.join(reviewWorktreePath, '.qwen', 'self-evolve-report.json'),
        JSON.stringify(
          {
            round: 2,
            status: 'success',
            selectedCandidateIndex: 99,
            selectedTask: {
              title: 'Address TODO in src/missing.ts:1',
              source: 'todo-comment',
              location: 'src/missing.ts:1',
            },
            summary: 'The child drifted to a different TODO.',
            validation: [{ command: 'npm run lint', summary: 'passed' }],
          },
          null,
          2,
        ),
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
      'The isolated self-evolve run did not select one of the provided candidates.',
    );
    expect(result.selectedTask).toBeUndefined();
    expect(cleanupSession).toHaveBeenCalledWith(
      expect.stringContaining('-review'),
    );
  });
});
