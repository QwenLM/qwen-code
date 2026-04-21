/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  GitWorktreeService,
  Storage,
  createDebugLogger,
  type Config,
} from '@qwen-code/qwen-code-core';

const execFileAsync = promisify(execFile);
const debugLogger = createDebugLogger('SELF_EVOLVE');

const SELF_EVOLVE_DIR = 'self-evolve';
const MAX_DISCOVERED_CANDIDATES = 8;
const DISCOVERY_TIMEOUT_MS = 45_000;
const QWEN_ATTEMPT_TIMEOUT_MS = 10 * 60_000;
const VALIDATION_TIMEOUT_MS = 5 * 60_000;
const TODO_PATTERN = /\b(?:TODO|FIXME|HACK)\b[:\s-]*(.*)$/;
const BACKLOG_FILE_PATTERN = /(^|\/)(backlog|roadmap|tasks?|todo)(\.[^/]+)?$/i;
const TEST_ARTIFACT_PATTERN =
  /(^|\/)(junit|test-results?|vitest-results?|failures?)(\.[^/]+)?$/i;
const SAFE_VALIDATION_PREFIXES = new Set([
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'node',
  'vitest',
  'eslint',
  'tsc',
]);

type CandidateSource =
  | 'failed-test'
  | 'lint-error'
  | 'type-error'
  | 'todo-comment'
  | 'backlog-file';

interface SelfEvolveCandidate {
  title: string;
  source: CandidateSource;
  details: string;
  location?: string;
  validationCommands: string[];
}

interface SelfEvolveAttemptReport {
  status?: 'success' | 'failed' | 'validation_failed' | 'no_safe_task';
  selectedTask?: {
    title?: string;
    source?: CandidateSource | string;
    location?: string;
    rationale?: string;
  };
  summary?: string;
  learnings?: string[];
  validation?: Array<{
    command?: string;
    summary?: string;
  }>;
  suggestedCommitMessage?: string;
  changedFiles?: string[];
}

interface CommandExecutionResult {
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface SelfEvolveSuccessResult {
  ok: true;
  attemptId: string;
  recordPath: string;
  branch: string;
  commitSha: string;
  summary: string;
  selectedTask: string;
  direction?: string;
  validation: string[];
  changedFiles: string[];
}

interface SelfEvolveFailureResult {
  ok: false;
  attemptId: string;
  recordPath: string;
  summary: string;
  selectedTask?: string;
  direction?: string;
  validation?: string[];
  learnings: string[];
}

export type SelfEvolveResult =
  | SelfEvolveSuccessResult
  | SelfEvolveFailureResult;

interface AttemptPaths {
  attemptDir: string;
  attemptLogPath: string;
  recordPath: string;
}

interface RuntimeDeps {
  createWorktreeService: (
    sourceRepoPath: string,
    customBaseDir: string,
  ) => GitWorktreeService;
  runCommand: (
    cwd: string,
    command: string,
    args: string[],
    options?: {
      timeoutMs?: number;
      env?: NodeJS.ProcessEnv;
    },
  ) => Promise<CommandExecutionResult>;
  runShellCommand: (
    cwd: string,
    command: string,
    options?: {
      timeoutMs?: number;
      env?: NodeJS.ProcessEnv;
    },
  ) => Promise<CommandExecutionResult>;
  runQwenAttempt: (params: {
    cwd: string;
    prompt: string;
    logPath: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
  }) => Promise<CommandExecutionResult>;
}

function getShellInvocation(command: string): {
  executable: string;
  args: string[];
} {
  if (process.platform === 'win32') {
    return {
      executable: 'cmd.exe',
      args: ['/d', '/s', '/c', command],
    };
  }
  return {
    executable: 'sh',
    args: ['-lc', command],
  };
}

export function getSelfEvolveAttemptNodeArgs(prompt: string): string[] {
  return [
    ...process.execArgv,
    path.resolve(process.argv[1] ?? ''),
    '--prompt',
    prompt,
    '--approval-mode',
    'yolo',
    '--output-format',
    'text',
  ];
}

function defaultDeps(): RuntimeDeps {
  return {
    createWorktreeService: (sourceRepoPath, customBaseDir) =>
      new GitWorktreeService(sourceRepoPath, customBaseDir),
    runCommand: async (cwd, command, args, options) => {
      try {
        const result = await execFileAsync(command, args, {
          cwd,
          env: options?.env,
          timeout: options?.timeoutMs,
          maxBuffer: 4 * 1024 * 1024,
        });
        return {
          command: [command, ...args].join(' '),
          cwd,
          exitCode: 0,
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
          timedOut: false,
        };
      } catch (error) {
        const execError = error as NodeJS.ErrnoException & {
          stdout?: string | Buffer;
          stderr?: string | Buffer;
          code?: number | string | null;
          signal?: string | null;
          killed?: boolean;
        };
        return {
          command: [command, ...args].join(' '),
          cwd,
          exitCode: typeof execError.code === 'number' ? execError.code : -1,
          stdout: String(execError.stdout ?? ''),
          stderr: String(execError.stderr ?? execError.message ?? ''),
          timedOut: execError.killed === true || execError.signal === 'SIGTERM',
        };
      }
    },
    runShellCommand: async (cwd, command, options) =>
      new Promise((resolve) => {
        const shell = getShellInvocation(command);
        const child = spawn(shell.executable, shell.args, {
          cwd,
          env: options?.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timeout =
          options?.timeoutMs == null
            ? undefined
            : setTimeout(() => {
                timedOut = true;
                child.kill('SIGTERM');
              }, options.timeoutMs);
        child.stdout?.on('data', (chunk: Buffer | string) => {
          stdout += chunk.toString();
        });
        child.stderr?.on('data', (chunk: Buffer | string) => {
          stderr += chunk.toString();
        });
        child.on('close', (code) => {
          if (timeout) {
            clearTimeout(timeout);
          }
          resolve({
            command,
            cwd,
            exitCode: code ?? -1,
            stdout,
            stderr,
            timedOut,
          });
        });
        child.on('error', (error) => {
          if (timeout) {
            clearTimeout(timeout);
          }
          resolve({
            command,
            cwd,
            exitCode: -1,
            stdout,
            stderr: `${stderr}${error.message}`,
            timedOut,
          });
        });
      }),
    runQwenAttempt: async ({ cwd, prompt, logPath, env, timeoutMs }) =>
      new Promise((resolve) => {
        const args = getSelfEvolveAttemptNodeArgs(prompt);
        const child = spawn(process.execPath, args, {
          cwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
        }, timeoutMs);
        child.stdout?.on('data', (chunk: Buffer | string) => {
          const text = chunk.toString();
          stdout += text;
        });
        child.stderr?.on('data', (chunk: Buffer | string) => {
          const text = chunk.toString();
          stderr += text;
        });
        const finalize = async (exitCode: number) => {
          clearTimeout(timeout);
          await fs.writeFile(logPath, `${stdout}\n\n--- STDERR ---\n${stderr}`);
          resolve({
            command: `node ${args.join(' ')}`,
            cwd,
            exitCode,
            stdout,
            stderr,
            timedOut,
          });
        };
        child.on('close', (code) => {
          void finalize(code ?? -1);
        });
        child.on('error', (error) => {
          stderr += error.message;
          void finalize(-1);
        });
      }),
  };
}

function formatCommandResult(result: CommandExecutionResult): string {
  const status = result.exitCode === 0 ? 'pass' : 'fail';
  const detail = result.timedOut
    ? ' (timed out)'
    : result.stderr.trim()
      ? ` (${result.stderr.trim().split('\n')[0]})`
      : '';
  return `${status}: ${result.command}${detail}`;
}

function sanitizeCommitMessage(
  message: string | undefined,
  selectedTask: string,
): string {
  const trimmed = message?.trim();
  if (trimmed) {
    return trimmed.slice(0, 120);
  }
  return `chore(self-evolve): ${selectedTask}`.slice(0, 120);
}

function buildSelfEvolveBranchToken(
  direction: string | undefined,
  attemptId: string,
): string | undefined {
  const trimmedDirection = direction?.trim();
  if (!trimmedDirection) {
    return undefined;
  }

  const slug = trimmedDirection
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 36)
    .replace(/-$/g, '');
  if (!slug) {
    return undefined;
  }

  const uniqueSuffix = attemptId.split('-').at(-1) ?? randomUUID().slice(0, 6);
  return `${slug}-${uniqueSuffix}`;
}

function summarizeOutput(output: string): string | undefined {
  const summary = output
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  return summary ? summary.slice(0, 200) : undefined;
}

async function safeReadJson<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export class SelfEvolveService {
  private readonly deps: RuntimeDeps;

  constructor(deps: Partial<RuntimeDeps> = {}) {
    this.deps = {
      ...defaultDeps(),
      ...deps,
    };
  }

  async run(
    config: Config,
    options: {
      direction?: string;
    } = {},
  ): Promise<SelfEvolveResult> {
    const projectRoot = config.getProjectRoot();
    const attemptId = `self-evolve-${Date.now()}-${randomUUID().slice(0, 6)}`;
    const attemptPaths = await this.createAttemptPaths(config, attemptId);
    const direction = options.direction?.trim() || undefined;
    const branchToken = buildSelfEvolveBranchToken(direction, attemptId);
    const baseBranch = await this.getCurrentBranch(projectRoot);
    const worktreeBaseDir = path.join(
      Storage.getRuntimeBaseDir(),
      SELF_EVOLVE_DIR,
    );
    const worktreeService = this.deps.createWorktreeService(
      projectRoot,
      worktreeBaseDir,
    );

    const candidates = await this.discoverCandidates(projectRoot);
    if (candidates.length === 0) {
      return this.finishFailure(
        attemptPaths.recordPath,
        attemptId,
        'No self-evolve candidates were found in this repository.',
        [
          'Candidate discovery did not find failed tests, lint/type errors, TODO comments, or backlog items.',
        ],
        undefined,
        undefined,
        direction,
      );
    }

    const attemptSessionId = `${attemptId}-attempt`;
    const reviewSessionId = `${attemptId}-review`;
    let reviewBranch: string | undefined;

    try {
      const attemptSetup = await worktreeService.setupWorktrees({
        sessionId: attemptSessionId,
        sourceRepoPath: projectRoot,
        worktreeNames: ['attempt'],
        baseBranch,
        branchToken,
      });
      if (!attemptSetup.success) {
        return this.finishFailure(
          attemptPaths.recordPath,
          attemptId,
          'Failed to create an isolated self-evolve worktree.',
          attemptSetup.errors.map((error) => error.error),
          undefined,
          undefined,
          direction,
        );
      }

      const attemptWorktree = attemptSetup.worktreesByName['attempt'];
      if (!attemptWorktree) {
        return this.finishFailure(
          attemptPaths.recordPath,
          attemptId,
          'The isolated self-evolve worktree was not created.',
          [
            'Git worktree creation returned without the expected worktree metadata.',
          ],
          undefined,
          undefined,
          direction,
        );
      }

      const reportPath = path.join(
        attemptWorktree.path,
        '.qwen',
        'self-evolve-report.json',
      );
      const attemptPrompt = this.buildPrompt({
        projectRoot,
        reportPath,
        candidates,
        direction,
      });

      await ensureDir(path.dirname(reportPath));
      const qwenResult = await this.deps.runQwenAttempt({
        cwd: attemptWorktree.path,
        prompt: attemptPrompt,
        logPath: attemptPaths.attemptLogPath,
        env: {
          ...process.env,
          QWEN_RUNTIME_DIR: path.join(attemptPaths.attemptDir, 'child-runtime'),
        },
        timeoutMs: QWEN_ATTEMPT_TIMEOUT_MS,
      });

      const report = await safeReadJson<SelfEvolveAttemptReport>(reportPath);
      if (
        qwenResult.exitCode !== 0 &&
        report?.status !== 'no_safe_task' &&
        report?.status !== 'validation_failed'
      ) {
        const learnings = [
          `The child Qwen run exited with code ${qwenResult.exitCode}.`,
        ];
        if (qwenResult.timedOut) {
          learnings.push('The child Qwen run timed out.');
        }
        if (qwenResult.stderr.trim()) {
          learnings.push(qwenResult.stderr.trim().split('\n')[0] ?? '');
        }
        await worktreeService.cleanupSession(attemptSessionId);
        return this.finishFailure(
          attemptPaths.recordPath,
          attemptId,
          'The isolated self-evolve run did not complete successfully.',
          learnings,
          report,
          undefined,
          direction,
        );
      }

      if (report?.status === 'no_safe_task') {
        await worktreeService.cleanupSession(attemptSessionId);
        return this.finishFailure(
          attemptPaths.recordPath,
          attemptId,
          report.summary?.trim() || 'No small safe task was selected.',
          report.learnings ?? [
            'The candidate list did not contain a clearly safe and verifiable task.',
          ],
          report,
          undefined,
          direction,
        );
      }

      const validationCommands = this.collectValidationCommands(
        report,
        candidates,
      );
      if (validationCommands.length === 0) {
        await worktreeService.cleanupSession(attemptSessionId);
        return this.finishFailure(
          attemptPaths.recordPath,
          attemptId,
          'The isolated self-evolve change did not provide a rerunnable validation command.',
          report?.learnings ?? [
            'The child run finished without reporting a safe validation command.',
          ],
          report,
          undefined,
          direction,
        );
      }
      const validationResults: string[] = [];
      for (const command of validationCommands) {
        const validationResult = await this.deps.runShellCommand(
          attemptWorktree.path,
          command,
          { timeoutMs: VALIDATION_TIMEOUT_MS },
        );
        validationResults.push(formatCommandResult(validationResult));
        if (validationResult.exitCode !== 0) {
          await worktreeService.cleanupSession(attemptSessionId);
          return this.finishFailure(
            attemptPaths.recordPath,
            attemptId,
            'The isolated self-evolve change failed validation.',
            [
              `Validation failed: ${command}`,
              summarizeOutput(validationResult.stderr) ??
                summarizeOutput(validationResult.stdout) ??
                'Validation command exited with a non-zero status.',
            ],
            report,
            validationResults,
            direction,
          );
        }
      }

      const statusResult = await this.deps.runCommand(
        attemptWorktree.path,
        'git',
        ['status', '--short'],
      );
      if (!statusResult.stdout.trim()) {
        await worktreeService.cleanupSession(attemptSessionId);
        return this.finishFailure(
          attemptPaths.recordPath,
          attemptId,
          'The isolated self-evolve run produced no code changes.',
          report?.learnings ?? [
            'The child Qwen run completed without leaving a diff to review.',
          ],
          report,
          validationResults,
          direction,
        );
      }

      const commitMessage = sanitizeCommitMessage(
        report?.suggestedCommitMessage,
        report?.selectedTask?.title || candidates[0]!.title,
      );
      await this.deps.runCommand(attemptWorktree.path, 'git', ['add', '--all']);
      const attemptCommitResult = await this.deps.runCommand(
        attemptWorktree.path,
        'git',
        ['commit', '--no-verify', '-m', commitMessage],
      );
      if (attemptCommitResult.exitCode !== 0) {
        await worktreeService.cleanupSession(attemptSessionId);
        return this.finishFailure(
          attemptPaths.recordPath,
          attemptId,
          'The isolated self-evolve change could not be committed.',
          [
            summarizeOutput(attemptCommitResult.stderr) ??
              'git commit exited with a non-zero status.',
          ],
          report,
          validationResults,
          direction,
        );
      }

      const attemptCommitSha = await this.readSingleLine(
        attemptWorktree.path,
        'git',
        ['rev-parse', 'HEAD'],
      );
      const reviewWorktreeResult = await worktreeService.createWorktree(
        reviewSessionId,
        'review',
        baseBranch,
        branchToken,
      );
      if (!reviewWorktreeResult.success || !reviewWorktreeResult.worktree) {
        await worktreeService.cleanupSession(attemptSessionId);
        return this.finishFailure(
          attemptPaths.recordPath,
          attemptId,
          'Failed to create the clean review branch for the validated change.',
          [
            reviewWorktreeResult.error ??
              'Git worktree creation returned no review worktree.',
          ],
          report,
          validationResults,
          direction,
        );
      }

      reviewBranch = reviewWorktreeResult.worktree.branch;
      const cherryPickResult = await this.deps.runCommand(
        reviewWorktreeResult.worktree.path,
        'git',
        ['cherry-pick', attemptCommitSha],
      );
      if (cherryPickResult.exitCode !== 0) {
        await worktreeService.cleanupSession(reviewSessionId);
        await worktreeService.cleanupSession(attemptSessionId);
        return this.finishFailure(
          attemptPaths.recordPath,
          attemptId,
          'The validated change could not be promoted into a clean review branch.',
          [
            summarizeOutput(cherryPickResult.stderr) ??
              'git cherry-pick exited with a non-zero status.',
          ],
          report,
          validationResults,
          direction,
        );
      }

      const commitSha = await this.readSingleLine(
        reviewWorktreeResult.worktree.path,
        'git',
        ['rev-parse', 'HEAD'],
      );
      const changedFilesOutput = await this.deps.runCommand(
        reviewWorktreeResult.worktree.path,
        'git',
        ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'],
      );
      const changedFiles = changedFilesOutput.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      await worktreeService.removeWorktree(reviewWorktreeResult.worktree.path);
      await fs.rm(
        GitWorktreeService.getSessionDir(reviewSessionId, worktreeBaseDir),
        { recursive: true, force: true },
      );
      await worktreeService.cleanupSession(attemptSessionId);

      const successResult: SelfEvolveSuccessResult = {
        ok: true,
        attemptId,
        recordPath: attemptPaths.recordPath,
        branch: reviewBranch,
        commitSha,
        summary:
          report?.summary?.trim() ||
          'Completed a self-evolve change and prepared a review commit.',
        selectedTask:
          report?.selectedTask?.title?.trim() || candidates[0]!.title,
        direction,
        validation: validationResults,
        changedFiles,
      };
      await fs.writeFile(
        attemptPaths.recordPath,
        JSON.stringify(
          {
            status: 'success',
            attemptId,
            branch: reviewBranch,
            commitSha,
            baseBranch,
            changedFiles,
            direction,
            validation: validationResults,
            report,
          },
          null,
          2,
        ),
      );
      return successResult;
    } catch (error) {
      debugLogger.error('Self evolve failed:', error);
      await worktreeService
        .cleanupSession(reviewSessionId)
        .catch(() => undefined);
      await worktreeService
        .cleanupSession(attemptSessionId)
        .catch(() => undefined);
      if (reviewBranch) {
        await this.deps
          .runCommand(projectRoot, 'git', ['branch', '-D', reviewBranch])
          .catch(() => undefined);
      }
      await this.deps
        .runCommand(projectRoot, 'git', ['worktree', 'prune'])
        .catch(() => undefined);
      return this.finishFailure(
        attemptPaths.recordPath,
        attemptId,
        'The self-evolve command hit an unexpected error.',
        [error instanceof Error ? error.message : String(error)],
        undefined,
        undefined,
        direction,
      );
    }
  }

  private async createAttemptPaths(
    config: Config,
    attemptId: string,
  ): Promise<AttemptPaths> {
    const attemptDir = path.join(
      config.storage.getProjectDir(),
      SELF_EVOLVE_DIR,
      attemptId,
    );
    await ensureDir(attemptDir);
    return {
      attemptDir,
      attemptLogPath: path.join(attemptDir, 'attempt.log'),
      recordPath: path.join(attemptDir, 'result.json'),
    };
  }

  private async getCurrentBranch(projectRoot: string): Promise<string> {
    return this.readSingleLine(projectRoot, 'git', [
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ]);
  }

  private async readSingleLine(
    cwd: string,
    command: string,
    args: string[],
  ): Promise<string> {
    const result = await this.deps.runCommand(cwd, command, args);
    return result.stdout.trim();
  }

  private async discoverCandidates(
    projectRoot: string,
  ): Promise<SelfEvolveCandidate[]> {
    const candidates: SelfEvolveCandidate[] = [];
    const packageJson = await safeReadJson<{
      scripts?: Record<string, string>;
    }>(path.join(projectRoot, 'package.json'));
    const scripts = packageJson?.scripts ?? {};

    const lintCommand =
      typeof scripts['lint'] === 'string'
        ? 'npm run lint -- --format unix'
        : null;
    const typecheckCommand =
      typeof scripts['typecheck'] === 'string' ? 'npm run typecheck' : null;

    if (lintCommand) {
      const lintResult = await this.deps.runShellCommand(
        projectRoot,
        lintCommand,
        {
          timeoutMs: DISCOVERY_TIMEOUT_MS,
        },
      );
      const lintCandidate = this.parseLintCandidate(
        lintResult.stdout || lintResult.stderr,
        lintCommand,
      );
      if (lintCandidate) {
        candidates.push(lintCandidate);
      }
    }

    if (typecheckCommand) {
      const typecheckResult = await this.deps.runShellCommand(
        projectRoot,
        typecheckCommand,
        { timeoutMs: DISCOVERY_TIMEOUT_MS },
      );
      const typeCandidate = this.parseTypecheckCandidate(
        typecheckResult.stdout || typecheckResult.stderr,
        typecheckCommand,
      );
      if (typeCandidate) {
        candidates.push(typeCandidate);
      }
    }

    const trackedFilesResult = await this.deps.runCommand(projectRoot, 'git', [
      'ls-files',
    ]);
    const trackedFiles = trackedFilesResult.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    const todoCandidates = await this.findTodoCandidates(
      projectRoot,
      trackedFiles,
    );
    candidates.push(...todoCandidates);

    const backlogCandidate = await this.findBacklogCandidate(
      projectRoot,
      trackedFiles,
    );
    if (backlogCandidate) {
      candidates.push(backlogCandidate);
    }

    const untrackedFilesResult = await this.deps.runCommand(
      projectRoot,
      'git',
      ['ls-files', '--others', '--exclude-standard'],
    );
    const artifactCandidate = await this.findFailedTestArtifactCandidate(
      projectRoot,
      [
        ...trackedFiles,
        ...untrackedFilesResult.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      ],
    );
    if (artifactCandidate) {
      candidates.unshift(artifactCandidate);
    }

    return candidates.slice(0, MAX_DISCOVERED_CANDIDATES);
  }

  private parseLintCandidate(
    output: string,
    validationCommand: string,
  ): SelfEvolveCandidate | null {
    const line = output
      .split('\n')
      .map((entry) => entry.trim())
      .find((entry) => /:\d+:\d+:/.test(entry));
    if (!line) {
      return null;
    }
    const match = line.match(/^(.*?):(\d+):(\d+):\s+(.*)$/);
    if (!match) {
      return null;
    }
    const [, file, row, col, message] = match;
    return {
      title: `Fix lint error in ${file}:${row}:${col}`,
      source: 'lint-error',
      details: message.trim(),
      location: `${file}:${row}:${col}`,
      validationCommands: [validationCommand],
    };
  }

  private parseTypecheckCandidate(
    output: string,
    validationCommand: string,
  ): SelfEvolveCandidate | null {
    const line = output
      .split('\n')
      .map((entry) => entry.trim())
      .find((entry) => entry.includes(' error TS'));
    if (!line) {
      return null;
    }
    const match =
      line.match(/^(.*)\((\d+),(\d+)\): error (TS\d+): (.*)$/) ??
      line.match(/^(.*?):(\d+):(\d+) - error (TS\d+): (.*)$/);
    if (!match) {
      return null;
    }
    const [, file, row, col, code, message] = match;
    return {
      title: `Fix type error ${code} in ${file}:${row}:${col}`,
      source: 'type-error',
      details: message.trim(),
      location: `${file}:${row}:${col}`,
      validationCommands: [validationCommand],
    };
  }

  private async findTodoCandidates(
    projectRoot: string,
    trackedFiles: string[],
  ): Promise<SelfEvolveCandidate[]> {
    const candidates: SelfEvolveCandidate[] = [];
    for (const relativePath of trackedFiles) {
      if (
        relativePath.startsWith('dist/') ||
        relativePath.startsWith('node_modules/') ||
        relativePath.endsWith('.snap')
      ) {
        continue;
      }
      if (!/\.(ts|tsx|js|jsx|md)$/.test(relativePath)) {
        continue;
      }
      let content: string;
      try {
        content = await fs.readFile(
          path.join(projectRoot, relativePath),
          'utf8',
        );
      } catch {
        continue;
      }
      const lines = content.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const match = lines[index]?.match(TODO_PATTERN);
        if (!match) {
          continue;
        }
        candidates.push({
          title: `Address TODO in ${relativePath}:${index + 1}`,
          source: 'todo-comment',
          details: match[1]?.trim() || 'Follow up on the noted TODO item.',
          location: `${relativePath}:${index + 1}`,
          validationCommands: [],
        });
        if (candidates.length >= 3) {
          return candidates;
        }
      }
    }
    return candidates;
  }

  private async findBacklogCandidate(
    projectRoot: string,
    trackedFiles: string[],
  ): Promise<SelfEvolveCandidate | null> {
    const backlogFile = trackedFiles.find((file) =>
      BACKLOG_FILE_PATTERN.test(file),
    );
    if (!backlogFile) {
      return null;
    }
    let content: string;
    try {
      content = await fs.readFile(path.join(projectRoot, backlogFile), 'utf8');
    } catch {
      return null;
    }
    const firstItem = content
      .split('\n')
      .map((line) => line.trim())
      .find((line) => /^[-*]\s+\[.\]/.test(line) || /^[-*]\s+/.test(line));
    if (!firstItem) {
      return null;
    }
    return {
      title: `Take a small backlog item from ${backlogFile}`,
      source: 'backlog-file',
      details: firstItem.replace(/^[-*]\s+/, ''),
      location: backlogFile,
      validationCommands: [],
    };
  }

  private async findFailedTestArtifactCandidate(
    projectRoot: string,
    files: string[],
  ): Promise<SelfEvolveCandidate | null> {
    const artifactFile = files.find((file) => TEST_ARTIFACT_PATTERN.test(file));
    if (!artifactFile) {
      return null;
    }
    try {
      const content = await fs.readFile(
        path.join(projectRoot, artifactFile),
        'utf8',
      );
      const snippet = content
        .split('\n')
        .map((line) => line.trim())
        .find((line) => /fail|error/i.test(line));
      return {
        title: `Investigate a recorded failing test from ${artifactFile}`,
        source: 'failed-test',
        details:
          snippet ||
          'Inspect the recent test artifact for a small failing case.',
        location: artifactFile,
        validationCommands: [],
      };
    } catch {
      return null;
    }
  }

  private buildPrompt(params: {
    projectRoot: string;
    reportPath: string;
    candidates: SelfEvolveCandidate[];
    direction?: string;
  }): string {
    const candidateList = params.candidates
      .map((candidate, index) => {
        const location = candidate.location ? ` @ ${candidate.location}` : '';
        const validations =
          candidate.validationCommands.length > 0
            ? ` Validation: ${candidate.validationCommands.join(' ; ')}`
            : '';
        return `${index + 1}. [${candidate.source}] ${candidate.title}${location}\n   ${candidate.details}${validations}`;
      })
      .join('\n');

    return [
      'You are running inside an isolated git worktree created by /self-evolve.',
      `Project root: ${params.projectRoot}`,
      '',
      'Pick exactly one small, safe, locally verifiable improvement task from the candidate list below.',
      'Priority order: failed tests, lint errors, type errors, TODO comments, backlog files.',
      params.direction
        ? `User direction for task selection: ${params.direction}`
        : undefined,
      params.direction
        ? 'Treat the user direction as advisory guidance for choosing among the discovered candidates. Ignore any part that would require risky, broad, externally dependent, or otherwise not-locally-verifiable work.'
        : undefined,
      'Do not push, open PRs, change remotes, or create commits.',
      'Keep the scope narrow. Avoid broad refactors.',
      'Run focused validation for the chosen task before finishing.',
      'If no candidate is clearly safe and verifiable, do not edit anything. Instead write a report with status "no_safe_task".',
      '',
      'Write a JSON report to this exact path before exiting:',
      params.reportPath,
      '',
      'Report schema:',
      JSON.stringify(
        {
          status: 'success | failed | validation_failed | no_safe_task',
          selectedTask: {
            title: 'string',
            source: 'string',
            location: 'string',
            rationale: 'string',
          },
          summary: 'string',
          learnings: ['string'],
          validation: [{ command: 'string', summary: 'string' }],
          suggestedCommitMessage: 'string',
          changedFiles: ['string'],
        },
        null,
        2,
      ),
      '',
      'Candidates:',
      candidateList,
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n');
  }

  private collectValidationCommands(
    report: SelfEvolveAttemptReport | null,
    candidates: SelfEvolveCandidate[],
  ): string[] {
    const reported = (report?.validation ?? [])
      .map((entry) => entry.command?.trim())
      .filter((entry): entry is string => Boolean(entry))
      .filter((entry) => SAFE_VALIDATION_PREFIXES.has(entry.split(/\s+/)[0]!));
    if (reported.length > 0) {
      return Array.from(new Set(reported));
    }
    const selectedTitle = report?.selectedTask?.title?.trim();
    const matchingCandidate = selectedTitle
      ? candidates.find((candidate) => candidate.title === selectedTitle)
      : undefined;
    return matchingCandidate?.validationCommands ?? [];
  }

  private async finishFailure(
    recordPath: string,
    attemptId: string,
    summary: string,
    learnings: string[],
    report?: SelfEvolveAttemptReport | null,
    validation?: string[],
    direction?: string,
  ): Promise<SelfEvolveFailureResult> {
    const result: SelfEvolveFailureResult = {
      ok: false,
      attemptId,
      recordPath,
      summary,
      selectedTask: report?.selectedTask?.title?.trim(),
      direction,
      validation,
      learnings,
    };
    await fs.writeFile(
      recordPath,
      JSON.stringify(
        {
          status:
            report?.status && report.status !== 'success'
              ? report.status
              : 'failed',
          attemptId,
          summary,
          selectedTask: report?.selectedTask,
          direction,
          validation,
          learnings,
          report,
        },
        null,
        2,
      ),
    );
    return result;
  }
}
