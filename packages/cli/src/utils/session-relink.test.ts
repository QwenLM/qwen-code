/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { maybeRelinkResumeSession } from './session-relink.js';

const mockPrompts = vi.hoisted(() => vi.fn());
vi.mock('prompts', () => ({ default: mockPrompts }));

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
    relinkSession: vi.fn().mockResolvedValue({ status: 'relinked' }),
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

  it('reports a relink refusal without throwing a fatal error', async () => {
    const service = serviceWithLookup({ status: 'candidate', candidate });
    service.relinkSession.mockRejectedValue(
      new Error('Session artifact already exists: /workspace/after/session'),
    );

    await expect(
      maybeRelinkResumeSession({
        sessionId: SESSION_ID,
        cwd: '/workspace/after',
        interactive: true,
        service,
        confirm: vi.fn().mockResolvedValue(true),
      }),
    ).resolves.toEqual({
      status: 'blocked',
      message:
        'Qwen Code could not safely complete session reattachment: Session artifact already exists: /workspace/after/session',
    });
  });

  it('preserves a refreshed structured refusal', async () => {
    const service = serviceWithLookup({ status: 'candidate', candidate });
    service.relinkSession.mockResolvedValue({
      status: 'blocked',
      result: { status: 'blocked', reason: 'active_writer' },
    });

    await expect(
      maybeRelinkResumeSession({
        sessionId: SESSION_ID,
        cwd: '/workspace/after',
        interactive: true,
        service,
        confirm: vi.fn().mockResolvedValue(true),
      }),
    ).resolves.toEqual({
      status: 'blocked',
      message:
        'The saved session appears to be active in another Qwen Code process, so it cannot be reattached.',
    });
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
      matches: [
        { transcriptPath: '/one', recordedCwd: '/workspace/one' },
        { transcriptPath: '/two', recordedCwd: '/workspace/two' },
        { transcriptPath: '/three' },
      ],
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
    if (result.status !== 'blocked') throw new Error('expected blocked result');
    expect(result.message).toContain('/workspace/one');
    expect(result.message).toContain('/workspace/two');
    expect(result.message).not.toContain('undefined');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('includes available scan diagnostics in the refusal', async () => {
    const service = serviceWithLookup({
      status: 'blocked',
      reason: 'scan_incomplete',
      detail: 'permission denied',
    });
    const result = await maybeRelinkResumeSession({
      sessionId: SESSION_ID,
      cwd: '/workspace/after',
      interactive: true,
      service,
    });
    expect(result).toMatchObject({
      status: 'blocked',
      message: expect.stringContaining('permission denied'),
    });
  });

  it('leaves managed sessions with their session authority', async () => {
    const service = serviceWithLookup({
      status: 'blocked',
      reason: 'managed_session',
    });
    const confirm = vi.fn();
    const result = await maybeRelinkResumeSession({
      sessionId: SESSION_ID,
      cwd: '/workspace/after',
      interactive: true,
      service,
      confirm,
    });

    expect(result).toEqual({
      status: 'blocked',
      message:
        "This session belongs to Qwen Code's managed session engine and cannot be reattached by the legacy project-move flow.",
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(service.relinkSession).not.toHaveBeenCalled();
  });

  it('uses the real default-No prompt and treats cancellation as declined', async () => {
    const service = serviceWithLookup({ status: 'candidate', candidate });
    mockPrompts.mockResolvedValueOnce({ confirmed: undefined });

    await expect(
      maybeRelinkResumeSession({
        sessionId: SESSION_ID,
        cwd: '/workspace/after',
        interactive: true,
        service,
      }),
    ).resolves.toEqual({ status: 'cancelled' });
    expect(mockPrompts).toHaveBeenCalledWith({
      type: 'confirm',
      name: 'confirmed',
      message: expect.stringMatching(/\/workspace\/before.*\/workspace\/after/),
      initial: false,
    });
    expect(service.relinkSession).not.toHaveBeenCalled();
  });
});
