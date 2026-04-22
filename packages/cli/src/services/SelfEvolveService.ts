/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import {
  GitWorktreeService,
  Storage,
  createDebugLogger,
  type Config,
} from '@qwen-code/qwen-code-core';
import type {
  CLIResultMessage,
  CLIUserMessage,
} from '../nonInteractive/types.js';
import { isCLIResultMessage } from '../nonInteractive/types.js';

const execFileAsync = promisify(execFile);
const debugLogger = createDebugLogger('SELF_EVOLVE');

const SELF_EVOLVE_DIR = 'self-evolve';
const MAX_DISCOVERED_CANDIDATES = 8;
const MAX_SELF_EVOLVE_ROUNDS = 5;
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
const DIRECTION_MATCH_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'focus',
  'focused',
  'for',
  'improve',
  'improvement',
  'improvements',
  'locally',
  'local',
  'narrow',
  'on',
  'optimize',
  'optimization',
  'polish',
  'safe',
  'small',
  'the',
]);

type SelfEvolveStatus = NonNullable<SelfEvolveAttemptReport['status']>;

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
  status?:
    | 'success'
    | 'failed'
    | 'validation_failed'
    | 'no_safe_task'
    | 'max_retries_exhausted';
  round?: number;
  selectedCandidateIndex?: number;
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
  status: 'success';
  roundsAttempted: number;
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
  status: Exclude<SelfEvolveStatus, 'success'>;
  roundsAttempted: number;
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

export interface SelfEvolveProgressEvent {
  stage:
    | 'discovering_candidates'
    | 'creating_worktree'
    | 'starting_session'
    | 'running_round'
    | 'validating'
    | 'committing'
    | 'finalizing'
    | 'cleaning_up';
  message: string;
  round?: number;
  totalRounds?: number;
  command?: string;
}

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
  createQwenSession: (params: {
    cwd: string;
    logPath: string;
    sessionId: string;
    env?: NodeJS.ProcessEnv;
  }) => QwenSession;
}

interface RunOptions {
  direction?: string;
  onProgress?: (event: SelfEvolveProgressEvent) => void;
}

interface QwenSessionTurnResult {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  childExited: boolean;
  exitCode?: number;
  result?: CLIResultMessage;
}

interface QwenSession {
  sendPrompt(prompt: string, timeoutMs: number): Promise<QwenSessionTurnResult>;
  shutdown(): Promise<CommandExecutionResult>;
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

export function getSelfEvolveSessionNodeArgs(sessionId: string): string[] {
  return [
    ...process.execArgv,
    path.resolve(process.argv[1] ?? ''),
    '--approval-mode',
    'yolo',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--session-id',
    sessionId,
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
    createQwenSession: ({ cwd, logPath, sessionId, env }) =>
      new PersistentQwenSession({
        cwd,
        logPath,
        sessionId,
        env,
      }),
  };
}

interface PersistentQwenSessionParams {
  cwd: string;
  logPath: string;
  sessionId: string;
  env?: NodeJS.ProcessEnv;
}

class PersistentQwenSession implements QwenSession {
  private readonly cwd: string;
  private readonly logPath: string;
  private readonly command: string;
  private readonly child: ReturnType<typeof spawn>;
  private readonly stdoutLines: string[] = [];
  private readonly stderrChunks: string[] = [];
  private readonly exitPromise: Promise<CommandExecutionResult>;
  private currentTurn:
    | {
        stdoutLines: string[];
        stderrOffset: number;
        timedOut: boolean;
        settle: (result: QwenSessionTurnResult) => void;
        timer: NodeJS.Timeout;
      }
    | undefined;
  private exitResult: CommandExecutionResult | undefined;

  constructor(private readonly params: PersistentQwenSessionParams) {
    this.cwd = params.cwd;
    this.logPath = params.logPath;
    const args = getSelfEvolveSessionNodeArgs(params.sessionId);
    this.command = `node ${args.join(' ')}`;
    this.child = spawn(process.execPath, args, {
      cwd: params.cwd,
      env: params.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutReader = createInterface({
      input: this.child.stdout!,
      crlfDelay: Number.POSITIVE_INFINITY,
      terminal: false,
    });
    stdoutReader.on('line', (line) => {
      this.stdoutLines.push(line);
      if (!this.currentTurn) {
        return;
      }
      this.currentTurn.stdoutLines.push(line);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      if (!isCLIResultMessage(parsed)) {
        return;
      }
      this.resolveCurrentTurn({
        stdout: this.currentTurn.stdoutLines.join('\n'),
        stderr: this.stderrChunks.slice(this.currentTurn.stderrOffset).join(''),
        timedOut: this.currentTurn.timedOut,
        childExited: false,
        result: parsed,
      });
    });

    this.child.stderr?.on('data', (chunk: Buffer | string) => {
      this.stderrChunks.push(chunk.toString());
    });

    this.exitPromise = new Promise((resolve) => {
      this.child.on('close', (code) => {
        const result = {
          command: this.command,
          cwd: this.cwd,
          exitCode: code ?? -1,
          stdout: this.stdoutLines.join('\n'),
          stderr: this.stderrChunks.join(''),
          timedOut: this.currentTurn?.timedOut ?? false,
        };
        this.exitResult = result;
        if (this.currentTurn) {
          this.resolveCurrentTurn({
            stdout: this.currentTurn.stdoutLines.join('\n'),
            stderr: this.stderrChunks
              .slice(this.currentTurn.stderrOffset)
              .join(''),
            timedOut: this.currentTurn.timedOut,
            childExited: true,
            exitCode: result.exitCode,
          });
        }
        void this.flushLogs().then(() => resolve(result));
      });
      this.child.on('error', (error) => {
        this.stderrChunks.push(error.message);
      });
    });
  }

  async sendPrompt(
    prompt: string,
    timeoutMs: number,
  ): Promise<QwenSessionTurnResult> {
    if (this.currentTurn) {
      throw new Error('A self-evolve child session turn is already running.');
    }
    if (this.exitResult) {
      return {
        stdout: '',
        stderr: this.exitResult.stderr,
        timedOut: false,
        childExited: true,
        exitCode: this.exitResult.exitCode,
      };
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.currentTurn) {
          return;
        }
        this.currentTurn.timedOut = true;
        this.child.kill('SIGTERM');
      }, timeoutMs);
      this.currentTurn = {
        stdoutLines: [],
        stderrOffset: this.stderrChunks.length,
        timedOut: false,
        settle: resolve,
        timer,
      };
      const message: CLIUserMessage = {
        type: 'user',
        session_id: this.params.sessionId,
        message: {
          role: 'user',
          content: prompt,
        },
        parent_tool_use_id: null,
      };
      this.child.stdin?.write(`${JSON.stringify(message)}\n`);
    });
  }

  async shutdown(): Promise<CommandExecutionResult> {
    if (!this.exitResult) {
      this.child.stdin?.end();
    }
    return this.exitPromise;
  }

  private resolveCurrentTurn(result: QwenSessionTurnResult): void {
    if (!this.currentTurn) {
      return;
    }
    clearTimeout(this.currentTurn.timer);
    const settle = this.currentTurn.settle;
    this.currentTurn = undefined;
    settle(result);
  }

  private async flushLogs(): Promise<void> {
    await fs.writeFile(
      this.logPath,
      `${this.stdoutLines.join('\n')}\n\n--- STDERR ---\n${this.stderrChunks.join('')}`,
    );
  }
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

function tokenizeDirectionText(value: string): string[] {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!normalized) {
    return [];
  }

  return normalized
    .split(/\s+/)
    .filter(
      (token) =>
        (token.length >= 3 || token === 'ui' || token === 'ux') &&
        !DIRECTION_MATCH_STOP_WORDS.has(token),
    );
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
    options: RunOptions = {},
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
    const emitProgress = (event: SelfEvolveProgressEvent) => {
      options.onProgress?.(event);
    };

    emitProgress({
      stage: 'discovering_candidates',
      message: 'Discovering a small, safe candidate task...',
    });
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
        'no_safe_task',
      );
    }

    const scopedCandidates = this.filterCandidatesByDirection(
      candidates,
      direction,
    );
    if (direction && scopedCandidates.length === 0) {
      return this.finishFailure(
        attemptPaths.recordPath,
        attemptId,
        'No discovered self-evolve candidates matched the requested direction.',
        [
          `Direction: ${direction}`,
          'Self-evolve only keeps working when it finds a small, safe candidate that clearly matches the requested area.',
        ],
        {
          status: 'no_safe_task',
          summary:
            'No discovered self-evolve candidates matched the requested direction.',
        },
        undefined,
        direction,
        'no_safe_task',
      );
    }

    const reviewSessionId = `${attemptId}-review`;
    let reviewBranch: string | undefined;

    try {
      emitProgress({
        stage: 'creating_worktree',
        message: 'Creating an isolated review worktree...',
      });
      const reviewSetup = await worktreeService.setupWorktrees({
        sessionId: reviewSessionId,
        sourceRepoPath: projectRoot,
        worktreeNames: ['review'],
        baseBranch,
        branchToken,
      } as Parameters<GitWorktreeService['setupWorktrees']>[0]);
      if (!reviewSetup.success) {
        return this.finishFailure(
          attemptPaths.recordPath,
          attemptId,
          'Failed to create an isolated self-evolve worktree.',
          reviewSetup.errors.map((error) => error.error),
          undefined,
          undefined,
          direction,
        );
      }

      const reviewWorktree = reviewSetup.worktreesByName['review'];
      if (!reviewWorktree) {
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
      reviewBranch = reviewWorktree.branch;

      const reportPath = path.join(
        reviewWorktree.path,
        '.qwen',
        'self-evolve-report.json',
      );
      await ensureDir(path.dirname(reportPath));
      const qwenSession = this.deps.createQwenSession({
        cwd: reviewWorktree.path,
        logPath: attemptPaths.attemptLogPath,
        sessionId: randomUUID(),
        env: {
          ...process.env,
          QWEN_RUNTIME_DIR: path.join(attemptPaths.attemptDir, 'child-runtime'),
        },
      });
      let report: SelfEvolveAttemptReport | null = null;
      let selectedCandidateSelection:
        | {
            candidate: SelfEvolveCandidate;
            index: number;
          }
        | undefined;
      let validationResults: string[] = [];
      let roundsAttempted = 0;
      let finalTurnResult: QwenSessionTurnResult | undefined;

      try {
        emitProgress({
          stage: 'starting_session',
          message: 'Starting the isolated self-evolve session...',
        });
        for (let round = 1; round <= MAX_SELF_EVOLVE_ROUNDS; round += 1) {
          roundsAttempted = round;
          emitProgress({
            stage: 'running_round',
            message:
              round === 1
                ? 'Running the first self-evolve implementation round...'
                : `Running repair round ${round} of ${MAX_SELF_EVOLVE_ROUNDS}...`,
            round,
            totalRounds: MAX_SELF_EVOLVE_ROUNDS,
          });
          const turnPrompt =
            round === 1
              ? this.buildPrompt({
                  projectRoot,
                  reportPath,
                  candidates: scopedCandidates,
                  direction,
                })
              : this.buildRepairPrompt({
                  reportPath,
                  round,
                  selectedCandidate: selectedCandidateSelection!.candidate,
                  selectedCandidateIndex: selectedCandidateSelection!.index + 1,
                  validationResults,
                  direction,
                  priorReport: report,
                  maxRounds: MAX_SELF_EVOLVE_ROUNDS,
                  childFailure:
                    this.summarizeSessionTurnFailure(finalTurnResult),
                });

          finalTurnResult = await qwenSession.sendPrompt(
            turnPrompt,
            QWEN_ATTEMPT_TIMEOUT_MS,
          );
          report = await safeReadJson<SelfEvolveAttemptReport>(reportPath);

          if (finalTurnResult.timedOut || finalTurnResult.childExited) {
            const learnings: string[] = [];
            if (finalTurnResult.timedOut) {
              learnings.push('The child Qwen session timed out.');
            }
            if (finalTurnResult.childExited) {
              learnings.push(
                `The child Qwen session exited with code ${finalTurnResult.exitCode ?? -1}.`,
              );
            }
            if (finalTurnResult.stderr.trim()) {
              learnings.push(
                finalTurnResult.stderr.trim().split('\n')[0] ?? '',
              );
            }
            await worktreeService.cleanupSession(reviewSessionId);
            return this.finishFailure(
              attemptPaths.recordPath,
              attemptId,
              'The isolated self-evolve session did not stay alive long enough to finish the task.',
              learnings,
              report,
              validationResults,
              direction,
              'failed',
              selectedCandidateSelection?.candidate.title,
              roundsAttempted,
            );
          }

          if (report?.status === 'no_safe_task' && round === 1) {
            await worktreeService.cleanupSession(reviewSessionId);
            return this.finishFailure(
              attemptPaths.recordPath,
              attemptId,
              report.summary?.trim() || 'No small safe task was selected.',
              report.learnings ?? [
                'The candidate list did not contain a clearly safe and verifiable task.',
              ],
              report,
              validationResults,
              direction,
              'no_safe_task',
              undefined,
              roundsAttempted,
            );
          }

          const resolvedSelection = this.resolveSelectedCandidateSelection(
            report,
            scopedCandidates,
          );
          if (!resolvedSelection) {
            await worktreeService.cleanupSession(reviewSessionId);
            return this.finishFailure(
              attemptPaths.recordPath,
              attemptId,
              'The isolated self-evolve run did not select one of the provided candidates.',
              [
                'The child run must pick exactly one discovered candidate and copy its title/location verbatim.',
              ],
              report,
              validationResults,
              direction,
              'failed',
              '',
              roundsAttempted,
            );
          }
          if (
            selectedCandidateSelection &&
            resolvedSelection.candidate.title !==
              selectedCandidateSelection.candidate.title
          ) {
            await worktreeService.cleanupSession(reviewSessionId);
            return this.finishFailure(
              attemptPaths.recordPath,
              attemptId,
              'The isolated self-evolve session drifted away from the originally selected task.',
              [
                'Retry rounds must stay on the first selected candidate until validation passes or retries are exhausted.',
              ],
              report,
              validationResults,
              direction,
              'failed',
              selectedCandidateSelection.candidate.title,
              roundsAttempted,
            );
          }
          selectedCandidateSelection =
            selectedCandidateSelection ?? resolvedSelection;

          const validationCommands = this.collectValidationCommands(
            report,
            selectedCandidateSelection.candidate,
          );
          if (validationCommands.length === 0) {
            await worktreeService.cleanupSession(reviewSessionId);
            return this.finishFailure(
              attemptPaths.recordPath,
              attemptId,
              'The isolated self-evolve change did not provide a rerunnable validation command.',
              report?.learnings ?? [
                'The child run finished without reporting a safe validation command.',
              ],
              report,
              validationResults,
              direction,
              'failed',
              selectedCandidateSelection.candidate.title,
              roundsAttempted,
            );
          }

          validationResults = [];
          let validationFailureLearning: string | undefined;
          for (const command of validationCommands) {
            emitProgress({
              stage: 'validating',
              message: `Running validation: ${command}`,
              round,
              totalRounds: MAX_SELF_EVOLVE_ROUNDS,
              command,
            });
            const validationResult = await this.deps.runShellCommand(
              reviewWorktree.path,
              command,
              { timeoutMs: VALIDATION_TIMEOUT_MS },
            );
            validationResults.push(formatCommandResult(validationResult));
            if (validationResult.exitCode !== 0) {
              validationFailureLearning =
                `Validation failed: ${command} | ` +
                (summarizeOutput(validationResult.stderr) ??
                  summarizeOutput(validationResult.stdout) ??
                  'Validation command exited with a non-zero status.');
              break;
            }
          }

          if (!validationFailureLearning) {
            break;
          }

          if (round === MAX_SELF_EVOLVE_ROUNDS) {
            await worktreeService.cleanupSession(reviewSessionId);
            return this.finishFailure(
              attemptPaths.recordPath,
              attemptId,
              `The isolated self-evolve change was discarded after ${MAX_SELF_EVOLVE_ROUNDS} unsuccessful validation rounds.`,
              [
                validationFailureLearning,
                'The change was rolled back after exhausting the retry budget for the same selected task.',
              ],
              report,
              validationResults,
              direction,
              'max_retries_exhausted',
              selectedCandidateSelection.candidate.title,
              roundsAttempted,
            );
          }
        }
      } finally {
        await qwenSession.shutdown().catch(() => undefined);
      }

      const statusResult = await this.deps.runCommand(
        reviewWorktree.path,
        'git',
        ['status', '--short'],
      );
      if (!statusResult.stdout.trim()) {
        await worktreeService.cleanupSession(reviewSessionId);
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
          'failed',
          selectedCandidateSelection?.candidate.title,
          roundsAttempted,
        );
      }

      const commitMessage = sanitizeCommitMessage(
        report?.suggestedCommitMessage,
        selectedCandidateSelection!.candidate.title,
      );
      emitProgress({
        stage: 'committing',
        message: `Creating review commit: ${commitMessage}`,
      });
      await this.deps.runCommand(reviewWorktree.path, 'git', ['add', '--all']);
      const reviewCommitResult = await this.deps.runCommand(
        reviewWorktree.path,
        'git',
        ['commit', '--no-verify', '-m', commitMessage],
      );
      if (reviewCommitResult.exitCode !== 0) {
        await worktreeService.cleanupSession(reviewSessionId);
        return this.finishFailure(
          attemptPaths.recordPath,
          attemptId,
          'The isolated self-evolve change could not be committed.',
          [
            summarizeOutput(reviewCommitResult.stderr) ??
              'git commit exited with a non-zero status.',
          ],
          report,
          validationResults,
          direction,
          'failed',
          selectedCandidateSelection!.candidate.title,
          roundsAttempted,
        );
      }

      // Collapse the review worktree to the final commit so no transient
      // validation artifacts remain in the filesystem presented to users.
      emitProgress({
        stage: 'finalizing',
        message: 'Finalizing the review worktree into a clean state...',
      });
      const resetResult = await this.deps.runCommand(
        reviewWorktree.path,
        'git',
        ['reset', '--hard', 'HEAD'],
      );
      if (resetResult.exitCode !== 0) {
        await worktreeService.cleanupSession(reviewSessionId);
        return this.finishFailure(
          attemptPaths.recordPath,
          attemptId,
          'The isolated self-evolve change could not be finalized into a clean review state.',
          [
            summarizeOutput(resetResult.stderr) ??
              'git reset --hard HEAD exited with a non-zero status.',
          ],
          report,
          validationResults,
          direction,
          'failed',
          selectedCandidateSelection!.candidate.title,
          roundsAttempted,
        );
      }

      const cleanResult = await this.deps.runCommand(
        reviewWorktree.path,
        'git',
        ['clean', '-fd'],
      );
      if (cleanResult.exitCode !== 0) {
        await worktreeService.cleanupSession(reviewSessionId);
        return this.finishFailure(
          attemptPaths.recordPath,
          attemptId,
          'The isolated self-evolve change could not remove temporary files after validation.',
          [
            summarizeOutput(cleanResult.stderr) ??
              'git clean -fd exited with a non-zero status.',
          ],
          report,
          validationResults,
          direction,
          'failed',
          selectedCandidateSelection!.candidate.title,
          roundsAttempted,
        );
      }

      const finalizedStatusResult = await this.deps.runCommand(
        reviewWorktree.path,
        'git',
        ['status', '--short'],
      );
      if (
        finalizedStatusResult.exitCode !== 0 ||
        finalizedStatusResult.stdout.trim()
      ) {
        await worktreeService.cleanupSession(reviewSessionId);
        return this.finishFailure(
          attemptPaths.recordPath,
          attemptId,
          'The isolated self-evolve change could not be finalized into a clean review state.',
          [
            summarizeOutput(finalizedStatusResult.stderr) ??
              summarizeOutput(finalizedStatusResult.stdout) ??
              'The review worktree still had uncommitted changes after cleanup.',
          ],
          report,
          validationResults,
          direction,
          'failed',
          selectedCandidateSelection!.candidate.title,
          roundsAttempted,
        );
      }

      const commitSha = await this.readSingleLine(reviewWorktree.path, 'git', [
        'rev-parse',
        'HEAD',
      ]);
      const changedFilesOutput = await this.deps.runCommand(
        reviewWorktree.path,
        'git',
        ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'],
      );
      const changedFiles = changedFilesOutput.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      emitProgress({
        stage: 'cleaning_up',
        message: 'Cleaning up temporary self-evolve worktree files...',
      });
      await worktreeService.removeWorktree(reviewWorktree.path);
      await fs.rm(
        GitWorktreeService.getSessionDir(reviewSessionId, worktreeBaseDir),
        { recursive: true, force: true },
      );

      const successResult: SelfEvolveSuccessResult = {
        ok: true,
        status: 'success',
        roundsAttempted,
        attemptId,
        recordPath: attemptPaths.recordPath,
        branch: reviewBranch,
        commitSha,
        summary:
          report?.summary?.trim() ||
          'Completed a self-evolve change and prepared a review commit.',
        selectedTask: selectedCandidateSelection!.candidate.title,
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
            roundsAttempted,
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
        'failed',
        undefined,
        0,
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
      'Pick by candidate index and keep the chosen title/location exactly as written in the candidate list.',
      'Do not rename, paraphrase, or synthesize a new task.',
      params.direction
        ? `User direction for task selection: ${params.direction}`
        : undefined,
      params.direction
        ? 'Only choose a candidate that clearly matches the user direction. If none do, write status "no_safe_task" and do not edit anything.'
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
          status:
            'success | failed | validation_failed | no_safe_task | max_retries_exhausted',
          round: 'number',
          selectedCandidateIndex:
            'number (1-based index from the candidate list)',
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

  private buildRepairPrompt(params: {
    reportPath: string;
    round: number;
    maxRounds: number;
    selectedCandidate: SelfEvolveCandidate;
    selectedCandidateIndex: number;
    validationResults: string[];
    direction?: string;
    priorReport: SelfEvolveAttemptReport | null;
    childFailure?: string;
  }): string {
    return [
      'Continue the same /self-evolve task inside the existing isolated worktree.',
      params.direction
        ? `Original user direction: ${params.direction}`
        : undefined,
      `This is repair round ${params.round} of ${params.maxRounds}.`,
      `Locked candidate index: ${params.selectedCandidateIndex}`,
      `Locked candidate title: ${params.selectedCandidate.title}`,
      params.selectedCandidate.location
        ? `Locked candidate location: ${params.selectedCandidate.location}`
        : undefined,
      'Do not switch to another candidate. Do not broaden scope.',
      'Fix the validation failure, stay on the locked task, and update the same report file before ending this turn.',
      params.childFailure
        ? `Previous child-session failure signal: ${params.childFailure}`
        : undefined,
      params.priorReport?.summary
        ? `Previous report summary: ${params.priorReport.summary}`
        : undefined,
      params.validationResults.length > 0
        ? `Latest external validation results: ${params.validationResults.join(' | ')}`
        : undefined,
      '',
      'Write a JSON report to this exact path before ending this turn:',
      params.reportPath,
      '',
      'Keep selectedCandidateIndex and selectedTask.title/location consistent with the locked candidate.',
      'If you are still not done, set status to "validation_failed" or "failed" with concise learnings. Do not abandon the locked task.',
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n');
  }

  private collectValidationCommands(
    report: SelfEvolveAttemptReport | null,
    selectedCandidate: SelfEvolveCandidate,
  ): string[] {
    const reported = (report?.validation ?? [])
      .map((entry) => entry.command?.trim())
      .filter((entry): entry is string => Boolean(entry))
      .filter((entry) => SAFE_VALIDATION_PREFIXES.has(entry.split(/\s+/)[0]!));
    if (reported.length > 0) {
      return Array.from(new Set(reported));
    }
    return selectedCandidate.validationCommands;
  }

  private filterCandidatesByDirection(
    candidates: SelfEvolveCandidate[],
    direction: string | undefined,
  ): SelfEvolveCandidate[] {
    const directionTerms = tokenizeDirectionText(direction ?? '');
    if (directionTerms.length === 0) {
      return candidates;
    }

    return candidates.filter((candidate) => {
      const candidateTerms = new Set(
        tokenizeDirectionText(
          [candidate.title, candidate.details, candidate.location]
            .filter(Boolean)
            .join(' '),
        ),
      );
      return directionTerms.some((term) => candidateTerms.has(term));
    });
  }

  private resolveSelectedCandidateSelection(
    report: SelfEvolveAttemptReport | null,
    candidates: SelfEvolveCandidate[],
  ):
    | {
        candidate: SelfEvolveCandidate;
        index: number;
      }
    | undefined {
    const selectedCandidateIndex = report?.selectedCandidateIndex;
    if (
      Number.isInteger(selectedCandidateIndex) &&
      selectedCandidateIndex != null &&
      selectedCandidateIndex >= 1 &&
      selectedCandidateIndex <= candidates.length
    ) {
      return {
        candidate: candidates[selectedCandidateIndex - 1]!,
        index: selectedCandidateIndex - 1,
      };
    }

    const selectedTitle = report?.selectedTask?.title?.trim();
    if (!selectedTitle) {
      return undefined;
    }

    const index = candidates.findIndex(
      (candidate) => candidate.title === selectedTitle,
    );
    if (index === -1) {
      return undefined;
    }
    return {
      candidate: candidates[index]!,
      index,
    };
  }

  private summarizeSessionTurnFailure(
    result: QwenSessionTurnResult | undefined,
  ): string | undefined {
    if (!result?.result?.is_error) {
      return undefined;
    }
    return (
      result.result.error?.message ||
      summarizeOutput(result.stderr) ||
      'The previous child-session turn ended with an error result.'
    );
  }

  private async finishFailure(
    recordPath: string,
    attemptId: string,
    summary: string,
    learnings: string[],
    report?: SelfEvolveAttemptReport | null,
    validation?: string[],
    direction?: string,
    status: Exclude<SelfEvolveStatus, 'success'> = 'failed',
    selectedTask?: string,
    roundsAttempted: number = 0,
  ): Promise<SelfEvolveFailureResult> {
    const result: SelfEvolveFailureResult = {
      ok: false,
      status,
      roundsAttempted,
      attemptId,
      recordPath,
      summary,
      selectedTask:
        selectedTask === undefined
          ? report?.selectedTask?.title?.trim()
          : selectedTask || undefined,
      direction,
      validation,
      learnings,
    };
    await fs.writeFile(
      recordPath,
      JSON.stringify(
        {
          status,
          roundsAttempted,
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
