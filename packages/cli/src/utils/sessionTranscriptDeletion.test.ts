/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptWorktreeSession } from '@qwen-code/core';
import { deleteSessionTranscript } from './sessionTranscriptDeletion.js';

const mocks = vi.hoisted(() => ({
  resolveSessionWorktreeState: vi.fn(),
  releaseOwnership: vi.fn(),
  deleteLegacyState: vi.fn(),
}));

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    resolveSessionWorktreeState: mocks.resolveSessionWorktreeState,
    SessionStateStore: class {
      delete = mocks.deleteLegacyState;
    },
    releasePersistedWorktreeSessionOwnership: mocks.releaseOwnership,
  };
});

describe('session transcript deletion', () => {
  const ownerState: TranscriptWorktreeSession = {
    sessionId: 'owner-session',
    originalCwd: '/project',
    worktreePath: '/project/.qwen/worktrees/feature',
    worktreeName: 'feature',
    lifecycle: 'owner',
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.releaseOwnership.mockResolvedValue(undefined);
  });

  it('settles a persisted owner before deleting its transcript', async () => {
    const beforeDelete = vi.fn().mockResolvedValue(undefined);
    const deleteTranscript = vi.fn().mockResolvedValue(undefined);
    mocks.resolveSessionWorktreeState.mockResolvedValue(ownerState);

    await deleteSessionTranscript({
      transcriptStore: { deleteTranscript },
      sessionPath: '/tmp/owner-session.jsonl',
      sessionId: 'owner-session',
      beforeDelete,
    });

    expect(mocks.releaseOwnership).toHaveBeenCalledWith(
      ownerState,
      'owner-session',
    );
    expect(deleteTranscript).toHaveBeenCalledWith('/tmp/owner-session.jsonl');
    expect(mocks.releaseOwnership).toHaveBeenCalledBefore(beforeDelete);
    expect(beforeDelete).toHaveBeenCalledBefore(deleteTranscript);
  });

  it('keeps the transcript when durable ownership cannot be settled', async () => {
    const beforeDelete = vi.fn();
    const deleteTranscript = vi.fn().mockResolvedValue(undefined);
    const ownerError = new Error('owner unavailable');
    mocks.releaseOwnership.mockRejectedValue(ownerError);

    await expect(
      deleteSessionTranscript({
        transcriptStore: { deleteTranscript },
        sessionPath: '/tmp/owner-session.jsonl',
        sessionId: 'owner-session',
        worktreeSession: ownerState,
        beforeDelete,
      }),
    ).rejects.toBe(ownerError);

    expect(deleteTranscript).not.toHaveBeenCalled();
    expect(beforeDelete).not.toHaveBeenCalled();
  });

  it('deletes a pre-projected legacy sidecar without re-reading it', async () => {
    const deleteTranscript = vi.fn().mockResolvedValue(undefined);

    await deleteSessionTranscript({
      transcriptStore: { deleteTranscript },
      sessionPath: '/tmp/owner-session.jsonl',
      sessionId: 'owner-session',
      sessionArtifactProjectRoot: '/project',
      worktreeSession: ownerState,
    });

    expect(mocks.releaseOwnership).toHaveBeenCalledExactlyOnceWith(
      ownerState,
      'owner-session',
    );
    expect(mocks.resolveSessionWorktreeState).not.toHaveBeenCalled();
    expect(deleteTranscript).toHaveBeenCalledExactlyOnceWith(
      '/tmp/owner-session.jsonl',
    );
    expect(mocks.deleteLegacyState).toHaveBeenCalledExactlyOnceWith();
    expect(deleteTranscript).toHaveBeenCalledBefore(mocks.deleteLegacyState);
  });

  it('settles and removes a sidecar-only owner with its transcript', async () => {
    const deleteTranscript = vi.fn().mockResolvedValue(undefined);
    mocks.resolveSessionWorktreeState.mockResolvedValue(ownerState);

    await deleteSessionTranscript({
      transcriptStore: { deleteTranscript },
      sessionPath: '/tmp/owner-session.jsonl',
      sessionId: 'owner-session',
      sessionArtifactProjectRoot: '/project',
    });

    expect(mocks.resolveSessionWorktreeState).toHaveBeenCalledWith(
      '/tmp/owner-session.jsonl',
      'owner-session',
      expect.objectContaining({ delete: mocks.deleteLegacyState }),
      { failOnDecryptionError: true },
    );

    expect(mocks.releaseOwnership).toHaveBeenCalledExactlyOnceWith(
      ownerState,
      'owner-session',
    );
    expect(deleteTranscript).toHaveBeenCalledExactlyOnceWith(
      '/tmp/owner-session.jsonl',
    );
    expect(mocks.deleteLegacyState).toHaveBeenCalledOnce();
  });
});
