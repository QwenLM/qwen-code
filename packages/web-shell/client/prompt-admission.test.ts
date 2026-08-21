/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';
import {
  PromptAdmissionAttempt,
  getLatestUserBlock,
  matchesUserMessageIdentity,
  retryOwnerMatchesCurrent,
} from './prompt-admission';

function userBlock(
  id: string,
  sourceRecordIds?: string[],
): DaemonTranscriptBlock {
  return {
    id,
    kind: 'user',
    text: id,
    sourceRecordIds,
  } as DaemonTranscriptBlock;
}

describe('PromptAdmissionAttempt', () => {
  it('distinguishes rejection, unknown outcome, and post-admission failure', () => {
    const attempt = new PromptAdmissionAttempt();
    expect(attempt.classifyFailure(false)).toBe('rejected');
    attempt.markStarted();
    expect(attempt.classifyFailure(true)).toBe('rejected');
    expect(attempt.classifyFailure(false)).toBe('unknown');
    attempt.markAdmitted();
    expect(attempt.classifyFailure(false)).toBe('after-admission');
  });

  it('owns the current attachment predicate', () => {
    const isCurrent = vi.fn(() => false);
    expect(new PromptAdmissionAttempt(isCurrent).isCurrent()).toBe(false);
    expect(isCurrent).toHaveBeenCalledOnce();
  });
});

describe('prompt transcript identity', () => {
  it('skips background notifications when selecting the latest user block', () => {
    const expected = userBlock('expected');
    const background = {
      ...userBlock('background'),
      meta: { source: 'background_notification' },
    } as DaemonTranscriptBlock;
    expect(getLatestUserBlock([expected, background])).toBe(expected);
  });

  it('matches replayed blocks by source record identity', () => {
    const expected = userBlock('local', ['record-1']);
    const replayed = userBlock('server', ['record-1']);
    expect(matchesUserMessageIdentity(replayed, { block: expected })).toBe(
      true,
    );
  });
});

describe('retryOwnerMatchesCurrent', () => {
  it('rejects a stale source version even when the attachment still matches', () => {
    expect(
      retryOwnerMatchesCurrent(
        {
          sessionId: 'session-1',
          workspaceCwd: '/workspace',
          sourceVersion: 1,
          snapshot: { isCurrent: () => true },
        },
        'session-1',
        '/workspace',
        2,
      ),
    ).toBe(false);
  });
});
