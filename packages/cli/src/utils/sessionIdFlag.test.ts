/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSessionTranscriptPath, Storage } from '@qwen-code/core';
import {
  getSessionIdAvailabilityError,
  getSessionIdUsageError,
  FORK_SESSION_USAGE_ERROR,
  INVALID_SESSION_ID_ERROR,
  RESUME_DROPS_TURN_USAGE_ERROR,
  RESUME_SESSION_AT_USAGE_ERROR,
  SESSION_ID_USAGE_ERROR,
} from './sessionIdFlag.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function createProjectRoot() {
  const projectRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'session-id-flag-'),
  );
  tempDirs.push(projectRoot);
  return projectRoot;
}

describe('sessionIdFlag', () => {
  it('rejects --fork-session without --continue or --resume', () => {
    expect(
      getSessionIdUsageError({
        sessionId: undefined,
        continue: false,
        forkSession: true,
        resume: undefined,
        remoteSession: undefined,
      }),
    ).toBe(FORK_SESSION_USAGE_ERROR);
  });

  it('rejects --session-id with --resume when --fork-session is missing', () => {
    expect(
      getSessionIdUsageError({
        sessionId: '11111111-1111-4111-8111-111111111111',
        continue: false,
        forkSession: false,
        resume: '',
        remoteSession: undefined,
      }),
    ).toBe(SESSION_ID_USAGE_ERROR);
  });

  it('rejects --resume-session-at without --resume', () => {
    expect(
      getSessionIdUsageError({
        sessionId: undefined,
        continue: false,
        forkSession: false,
        resume: undefined,
        resumeSessionAt: '22222222-2222-4222-8222-222222222222',
        remoteSession: undefined,
      }),
    ).toBe(RESUME_SESSION_AT_USAGE_ERROR);
  });

  it('accepts an opaque --resume-session-at value for transcript lookup', () => {
    expect(
      getSessionIdUsageError({
        sessionId: undefined,
        continue: false,
        forkSession: false,
        resume: '11111111-1111-4111-8111-111111111111',
        resumeSessionAt: 'not-a-message-id',
        remoteSession: undefined,
      }),
    ).toBeNull();
  });

  it('rejects --resume-drops-turn without --resume-session-at', () => {
    expect(
      getSessionIdUsageError({
        sessionId: undefined,
        continue: false,
        forkSession: false,
        resume: '11111111-1111-4111-8111-111111111111',
        resumeDropsTurn: '22222222-2222-4222-8222-222222222222',
        remoteSession: undefined,
      }),
    ).toBe(RESUME_DROPS_TURN_USAGE_ERROR);
  });

  it('rejects a non-UUID session ID', () => {
    expect(
      getSessionIdUsageError({
        sessionId: 'invalid-id',
        continue: false,
        forkSession: false,
        resume: undefined,
        remoteSession: undefined,
      }),
    ).toBe(INVALID_SESSION_ID_ERROR);
  });

  it('accepts a standalone UUID session ID for a new session', () => {
    expect(
      getSessionIdUsageError({
        sessionId: '11111111-1111-4111-8111-111111111111',
        continue: false,
        forkSession: false,
        resume: undefined,
        remoteSession: undefined,
      }),
    ).toBeNull();
  });

  it('rejects a session ID that is already in use', async () => {
    const projectRoot = await createProjectRoot();
    const configHome = path.join(projectRoot, '.config');
    vi.spyOn(Storage, 'getGlobalConfigDir').mockReturnValue(configHome);

    const sessionId = '11111111-1111-4111-8111-111111111111';
    const transcriptPath = getSessionTranscriptPath(
      projectRoot,
      sessionId,
      configHome,
    );
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
    await fs.writeFile(transcriptPath, '', 'utf8');

    await expect(
      getSessionIdAvailabilityError(projectRoot, {
        sessionId,
        remoteSession: undefined,
      }),
    ).resolves.toBe(`Session ID ${sessionId} is already in use.`);
  });

  it('accepts a new session ID when no transcript exists', async () => {
    const projectRoot = await createProjectRoot();
    const configHome = path.join(projectRoot, '.config');
    vi.spyOn(Storage, 'getGlobalConfigDir').mockReturnValue(configHome);

    await expect(
      getSessionIdAvailabilityError(projectRoot, {
        sessionId: '11111111-1111-4111-8111-111111111111',
        remoteSession: undefined,
      }),
    ).resolves.toBeNull();
  });
});
