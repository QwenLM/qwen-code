/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  isInteractiveResumeInvocation,
  maybeRelinkResumeSession,
} from './session-relink.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const candidate = {
  sessionId: SESSION_ID,
  recordedCwd: '/workspace/before',
  sourceTranscriptPath: '/runtime/projects/old/chats/session.jsonl',
  sourceChatsDir: '/runtime/projects/old/chats',
  identity: { dev: 1, ino: 2, size: 3, mtimeMs: 4, ctimeMs: 5 },
};

function serviceWithLookup(lookup: unknown) {
  return {
    getSessionLocation: vi.fn().mockResolvedValue(undefined),
    findRelinkCandidate: vi.fn().mockResolvedValue(lookup),
    relinkSession: vi.fn().mockResolvedValue(undefined),
  };
}

describe('resume session relinking', () => {
  it('does not scan when the session is already in the current project', async () => {
    const service = serviceWithLookup({ status: 'not_found' });
    service.getSessionLocation.mockResolvedValue('active');
    await expect(
      maybeRelinkResumeSession({
        sessionId: SESSION_ID,
        cwd: '/workspace/after',
        interactive: true,
        service,
      }),
    ).resolves.toEqual({ status: 'unchanged' });
    expect(service.findRelinkCandidate).not.toHaveBeenCalled();
  });

  it('requires an interactive confirmation before moving a candidate', async () => {
    const service = serviceWithLookup({ status: 'candidate', candidate });
    const confirm = vi.fn().mockResolvedValue(true);
    await expect(
      maybeRelinkResumeSession({
        sessionId: SESSION_ID,
        cwd: '/workspace/after',
        interactive: true,
        service,
        confirm,
      }),
    ).resolves.toEqual({
      status: 'relinked',
      previousCwd: '/workspace/before',
    });
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining('/workspace/before'),
    );
    expect(service.relinkSession).toHaveBeenCalledWith(candidate);
  });

  it('leaves files unchanged when confirmation is declined', async () => {
    const service = serviceWithLookup({ status: 'candidate', candidate });
    await expect(
      maybeRelinkResumeSession({
        sessionId: SESSION_ID,
        cwd: '/workspace/after',
        interactive: true,
        service,
        confirm: vi.fn().mockResolvedValue(false),
      }),
    ).resolves.toEqual({ status: 'cancelled' });
    expect(service.relinkSession).not.toHaveBeenCalled();
  });

  it('explains how to confirm when invoked non-interactively', async () => {
    const service = serviceWithLookup({ status: 'candidate', candidate });
    const result = await maybeRelinkResumeSession({
      sessionId: SESSION_ID,
      cwd: '/workspace/after',
      interactive: false,
      service,
    });
    expect(result).toMatchObject({ status: 'blocked' });
    if (result.status !== 'blocked') throw new Error('expected blocked result');
    expect(result.message).toContain(`qwen --resume ${SESSION_ID}`);
    expect(service.relinkSession).not.toHaveBeenCalled();
  });

  it('reports ambiguous matches without prompting', async () => {
    const service = serviceWithLookup({
      status: 'ambiguous',
      matches: [{ transcriptPath: '/one' }, { transcriptPath: '/two' }],
    });
    const confirm = vi.fn();
    const result = await maybeRelinkResumeSession({
      sessionId: SESSION_ID,
      cwd: '/workspace/after',
      interactive: true,
      service,
      confirm,
    });
    expect(result).toMatchObject({ status: 'blocked' });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('treats only an interactive prompt or an empty TTY invocation as interactive', () => {
    expect(isInteractiveResumeInvocation({ promptInteractive: 'plan' })).toBe(
      true,
    );
    expect(isInteractiveResumeInvocation({ prompt: 'do work' })).toBe(false);
    expect(isInteractiveResumeInvocation({ query: 'do work' })).toBe(false);
  });
});
