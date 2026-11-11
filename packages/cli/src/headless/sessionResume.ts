/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Headless 会话自己的恢复解析：`--continue` / `--resume` / fork 在 open 之前完成，
 * 不依赖入口 Config，也不再经过启动路由。读取会话历史用的是进程级 transcript 存储。
 */

import {
  coreEvents,
  ExitCodes,
  resolveLatestSameRepoTranscriptSession,
  resolveSameRepoTranscriptSession,
  sessionId as generatedSessionId,
  sessionLogger,
  TranscriptSessionError,
  TranscriptStore,
  type SessionResumeData,
} from '@qwen-code/core';
import type { CliArgs } from '../config/config.js';
import { runExitCleanupWithTimeout } from '../utils/cleanup.js';
import { buildResumedSessionData } from '../utils/resumeSessionData.js';

export interface HeadlessResumeInput {
  readonly cliArgs: CliArgs;
  readonly workspaceRoot: string;
}

export async function resolveHeadlessResume(
  input: HeadlessResumeInput,
): Promise<SessionResumeData | undefined> {
  const { cliArgs, workspaceRoot } = input;
  if (cliArgs.remoteSession) {
    coreEvents.emitFeedback(
      'error',
      '--remote-session currently requires interactive mode.',
    );
    await exitOnResumeError(
      '--remote-session requires interactive mode',
      'gemini.remoteSession',
    );
  }

  const currentSessionId = cliArgs.sessionId ?? generatedSessionId;
  const deps = {
    transcriptStore: new TranscriptStore(),
    sessionId: currentSessionId,
    sessionArtifactProjectRoot: workspaceRoot,
  };

  if (cliArgs.continue) {
    try {
      const resolved = await resolveLatestSameRepoTranscriptSession(
        workspaceRoot,
        currentSessionId,
      );
      return await buildResumedSessionData(deps, resolved, {
        forkSession: cliArgs.forkSession,
        sessionMirror: cliArgs.sessionMirror,
        targetSessionId: cliArgs.sessionId,
      });
    } catch (error) {
      const message =
        error instanceof TranscriptSessionError &&
        error.code === 'NO_SESSIONS_FOUND'
          ? 'No conversation found to continue'
          : `Error continuing session: ${describeError(error)}`;
      coreEvents.emitFeedback('error', message);
      await exitOnResumeError(message, 'gemini.resume', error);
    }
  }

  if (cliArgs.resume !== undefined) {
    const trimmedResume = cliArgs.resume.trim();
    if (!trimmedResume) {
      const message =
        'Error resuming session: --resume requires a session identifier outside interactive mode.';
      coreEvents.emitFeedback('error', message);
      await exitOnResumeError(
        '--resume requires a session identifier outside interactive mode',
        'gemini.resume',
      );
    }
    try {
      const resolved = await resolveSameRepoTranscriptSession(
        workspaceRoot,
        trimmedResume,
        currentSessionId,
      );
      return await buildResumedSessionData(deps, resolved, {
        forkSession: cliArgs.forkSession,
        sessionMirror: cliArgs.sessionMirror,
        resumeSessionAt: cliArgs.resumeSessionAt,
        resumeDropsTurn: cliArgs.resumeDropsTurn,
        targetSessionId: cliArgs.sessionId,
      });
    } catch (error) {
      const message = `Error resuming session: ${describeError(error)}`;
      coreEvents.emitFeedback('error', message);
      await exitOnResumeError(message, 'gemini.resume', error);
    }
  }

  return undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

async function exitOnResumeError(
  message: string,
  source: string,
  cause?: unknown,
): Promise<never> {
  await runExitCleanupWithTimeout();
  sessionLogger.setExitContext({
    reason: 'input_error',
    exit_code: ExitCodes.FATAL_INPUT_ERROR,
    message,
    source,
    error_name: cause instanceof Error ? cause.name : undefined,
    error_stack: cause instanceof Error ? cause.stack : undefined,
  });
  return process.exit(ExitCodes.FATAL_INPUT_ERROR);
}
