/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import {
  coreEvents,
  ExitCodes,
  resolveLatestSameRepoTranscriptSession,
  resolveSameRepoTranscriptSession,
  TranscriptSessionError,
} from '@qwen-code/core';
import type { CliArgs } from '../config/config.js';
import { resolveHeadlessResume } from './sessionResume.js';
import { buildResumedSessionData } from '../utils/resumeSessionData.js';
import { runExitCleanupWithTimeout } from '../utils/cleanup.js';

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    resolveSameRepoTranscriptSession: vi.fn(),
    resolveLatestSameRepoTranscriptSession: vi.fn(),
  };
});

vi.mock('../utils/cleanup.js', () => ({
  runExitCleanupWithTimeout: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/resumeSessionData.js', () => ({
  buildResumedSessionData: vi.fn(),
}));

const WORKSPACE = '/workspace/demo';

function args(overrides: Partial<CliArgs> = {}): CliArgs {
  return { print: true, ...overrides } as unknown as CliArgs;
}

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit:${code}`);
  }
}

describe('resolveHeadlessResume', () => {
  let exitSpy: MockInstance<
    (code?: string | number | null | undefined) => never
  >;
  let feedbackSpy: MockInstance<typeof coreEvents.emitFeedback>;

  beforeEach(() => {
    vi.mocked(resolveSameRepoTranscriptSession).mockReset();
    vi.mocked(resolveLatestSameRepoTranscriptSession).mockReset();
    vi.mocked(buildResumedSessionData).mockReset();
    vi.mocked(runExitCleanupWithTimeout).mockClear();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitSignal(code ?? 0);
    }) as never);
    feedbackSpy = vi.spyOn(coreEvents, 'emitFeedback');
  });

  afterEach(() => {
    exitSpy.mockRestore();
    feedbackSpy.mockRestore();
  });

  it('rejects a remote session in headless mode', async () => {
    await expect(
      resolveHeadlessResume({
        cliArgs: args({ remoteSession: 'remote-id' }),
        workspaceRoot: WORKSPACE,
      }),
    ).rejects.toMatchObject({ code: ExitCodes.FATAL_INPUT_ERROR });

    expect(feedbackSpy).toHaveBeenCalledWith(
      'error',
      '--remote-session currently requires interactive mode.',
    );
    expect(runExitCleanupWithTimeout).toHaveBeenCalled();
  });

  it('requires a session identifier for --resume', async () => {
    await expect(
      resolveHeadlessResume({
        cliArgs: args({ resume: '  ' }),
        workspaceRoot: WORKSPACE,
      }),
    ).rejects.toMatchObject({ code: ExitCodes.FATAL_INPUT_ERROR });

    expect(feedbackSpy).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('--resume requires a session identifier'),
    );
  });

  it('reports resume resolution failures and exits 42', async () => {
    vi.mocked(resolveSameRepoTranscriptSession).mockRejectedValue(
      new Error('Session not found'),
    );

    await expect(
      resolveHeadlessResume({
        cliArgs: args({ resume: 'missing-id' }),
        workspaceRoot: WORKSPACE,
      }),
    ).rejects.toMatchObject({ code: ExitCodes.FATAL_INPUT_ERROR });

    expect(feedbackSpy).toHaveBeenCalledWith(
      'error',
      'Error resuming session: Session not found',
    );
  });

  it('reports an empty --continue history', async () => {
    vi.mocked(resolveLatestSameRepoTranscriptSession).mockRejectedValue(
      new TranscriptSessionError('NO_SESSIONS_FOUND', 'none'),
    );

    await expect(
      resolveHeadlessResume({
        cliArgs: args({ continue: true }),
        workspaceRoot: WORKSPACE,
      }),
    ).rejects.toMatchObject({ code: ExitCodes.FATAL_INPUT_ERROR });

    expect(feedbackSpy).toHaveBeenCalledWith(
      'error',
      'No conversation found to continue',
    );
  });

  it('builds resumed data for --continue without plan copying', async () => {
    const resolved = { sessionInfo: { id: 'source-id' } };
    const resumed = { sessionId: 'source-id' };
    vi.mocked(resolveLatestSameRepoTranscriptSession).mockResolvedValue(
      resolved as never,
    );
    vi.mocked(buildResumedSessionData).mockResolvedValue(resumed as never);

    const result = await resolveHeadlessResume({
      cliArgs: args({ continue: true, sessionId: 'current-id', forkSession: true }),
      workspaceRoot: WORKSPACE,
    });

    expect(result).toBe(resumed);
    expect(resolveLatestSameRepoTranscriptSession).toHaveBeenCalledWith(
      WORKSPACE,
      'current-id',
    );
    expect(buildResumedSessionData).toHaveBeenCalledWith(
      {
        transcriptStore: expect.anything(),
        sessionId: 'current-id',
        sessionArtifactProjectRoot: WORKSPACE,
      },
      resolved,
      { forkSession: true, targetSessionId: 'current-id' },
    );
  });

  it('builds resumed data for --resume with historical options', async () => {
    const resolved = { sessionInfo: { id: 'source-id' } };
    const resumed = { sessionId: 'source-id' };
    vi.mocked(resolveSameRepoTranscriptSession).mockResolvedValue(
      resolved as never,
    );
    vi.mocked(buildResumedSessionData).mockResolvedValue(resumed as never);

    const result = await resolveHeadlessResume({
      cliArgs: args({
        resume: '  source-id  ',
        resumeSessionAt: 'turn-3',
        resumeDropsTurn: 'turn-4',
      }),
      workspaceRoot: WORKSPACE,
    });

    expect(result).toBe(resumed);
    expect(resolveSameRepoTranscriptSession).toHaveBeenCalledWith(
      WORKSPACE,
      'source-id',
      expect.any(String),
    );
    expect(buildResumedSessionData).toHaveBeenCalledWith(
      expect.objectContaining({ sessionArtifactProjectRoot: WORKSPACE }),
      resolved,
      {
        forkSession: undefined,
        resumeSessionAt: 'turn-3',
        resumeDropsTurn: 'turn-4',
        targetSessionId: undefined,
      },
    );
  });

  it('returns undefined when no resume flag is present', async () => {
    await expect(
      resolveHeadlessResume({ cliArgs: args(), workspaceRoot: WORKSPACE }),
    ).resolves.toBeUndefined();
    expect(resolveSameRepoTranscriptSession).not.toHaveBeenCalled();
    expect(resolveLatestSameRepoTranscriptSession).not.toHaveBeenCalled();
  });
});
