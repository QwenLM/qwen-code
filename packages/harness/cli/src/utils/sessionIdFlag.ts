/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import {
  getSessionTranscriptPath,
  isValidSessionIdUuid,
} from '@qwen-code/core';
import type { CliArgs } from '../config/config.js';

export const SESSION_ID_USAGE_ERROR =
  '--session-id can only be used with --continue or --resume when --fork-session is also specified.';
export const INVALID_SESSION_ID_ERROR =
  'Invalid session ID. Must be a valid UUID.';
export const FORK_SESSION_USAGE_ERROR =
  '--fork-session must be used with --continue or --resume.';
export const RESUME_SESSION_AT_USAGE_ERROR =
  '--resume-session-at must be used with --resume.';
export const RESUME_DROPS_TURN_USAGE_ERROR =
  '--resume-drops-turn must be used with --resume-session-at.';

function usesLocalTranscriptSessionId(
  argv: Pick<CliArgs, 'sessionId' | 'remoteSession'>,
): boolean {
  return argv.sessionId !== undefined && argv.remoteSession === undefined;
}

export function getSessionIdUsageError(
  argv: Pick<
    CliArgs,
    | 'sessionId'
    | 'continue'
    | 'forkSession'
    | 'resume'
    | 'resumeSessionAt'
    | 'resumeDropsTurn'
    | 'remoteSession'
  >,
): string | null {
  if (argv.resumeSessionAt !== undefined && argv.resume === undefined) {
    return RESUME_SESSION_AT_USAGE_ERROR;
  }

  if (argv.resumeDropsTurn !== undefined && argv.resumeSessionAt === undefined) {
    return RESUME_DROPS_TURN_USAGE_ERROR;
  }

  if (argv.forkSession && !argv.continue && argv.resume === undefined) {
    return FORK_SESSION_USAGE_ERROR;
  }

  if (!usesLocalTranscriptSessionId(argv)) {
    return null;
  }

  // sessionId is guaranteed defined after usesLocalTranscriptSessionId
  const sessionId = argv.sessionId!;

  if ((argv.continue || argv.resume !== undefined) && !argv.forkSession) {
    return SESSION_ID_USAGE_ERROR;
  }

  if (!isValidSessionIdUuid(sessionId)) {
    return INVALID_SESSION_ID_ERROR;
  }

  return null;
}

export async function getSessionIdAvailabilityError(
  projectRoot: string,
  argv: Pick<CliArgs, 'sessionId' | 'remoteSession'>,
): Promise<string | null> {
  if (!usesLocalTranscriptSessionId(argv)) {
    return null;
  }

  // sessionId is guaranteed defined after usesLocalTranscriptSessionId
  const sessionId = argv.sessionId!;
  const transcriptPath = getSessionTranscriptPath(projectRoot, sessionId);
  try {
    await fs.access(transcriptPath);
    return `Session ID ${sessionId} is already in use.`;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}
