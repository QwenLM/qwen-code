/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import type { AgentViewSessionStateFile } from '../../agent-view/protocol.js';
import {
  answerManagedSession,
  peekManagedSession,
  shortSessionId,
  stopManagedSession,
  type ManagedControlHandle,
} from './managed-control.js';

const SESSION = '0f8e1c42-9d3a-4d21-8f77-2b6a7c9e0c31';

function state(
  over: Partial<AgentViewSessionStateFile> = {},
): AgentViewSessionStateFile {
  return {
    schemaVersion: 1,
    sessionId: SESSION,
    ownership: 'managed',
    sessionState: 'needs_input',
    processState: 'alive',
    attachState: 'detached',
    projectCwd: '/w/app',
    originalCwd: '/w/app',
    activeCwd: '/w/app',
    createdAt: '2026-09-04T11:58:00Z',
    updatedAt: '2026-09-04T11:59:00Z',
    worktree: { mode: 'none' },
    ...over,
  };
}

function handle(
  over: Partial<ManagedControlHandle> = {},
): ManagedControlHandle {
  return {
    peek: vi.fn().mockResolvedValue({
      sessionId: SESSION,
      state: state(),
      activity: {
        schemaVersion: 1,
        waitingFor: 'permission to write src/index.ts',
        lastActivityAt: '2026-09-04T11:59:00Z',
        capabilities: [],
      },
      live: true,
    }),
    answer: vi.fn().mockResolvedValue({ sessionId: SESSION, answered: true }),
    stop: vi.fn().mockResolvedValue({ sessionId: SESSION, stopped: true }),
    ...over,
  };
}

const connectTo = (h: ManagedControlHandle) => async () => h;
const noSupervisor = async () => undefined;

describe('peekManagedSession', () => {
  it('reports the question a session is waiting on', async () => {
    const result = await peekManagedSession(SESSION, connectTo(handle()));
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toContain(
      'permission to write src/index.ts',
    );
  });

  it('tells the user how to answer, with an id they can type', async () => {
    // A question with no reply path is the state this command exists to
    // get the user out of.
    const result = await peekManagedSession(SESSION, connectTo(handle()));
    const text = result.lines.join('\n');
    expect(text).toContain('qwen sessions answer');
    expect(text).toContain(shortSessionId(SESSION));
    expect(shortSessionId(SESSION)).toBe('0f8e1c42');
  });

  it('offers no answer hint for a session that is not waiting', async () => {
    // Answering a working session queues a prompt instead, which is a
    // different operation; suggesting it here would mislead.
    const working = handle({
      peek: vi.fn().mockResolvedValue({
        sessionId: SESSION,
        state: state({ sessionState: 'working' }),
        live: true,
      }),
    });
    const result = await peekManagedSession(SESSION, connectTo(working));
    expect(result.lines.join('\n')).not.toContain('qwen sessions answer');
  });

  it('says when the session has no live process', async () => {
    const dead = handle({
      peek: vi.fn().mockResolvedValue({
        sessionId: SESSION,
        state: state({ sessionState: 'stopped', processState: 'exited' }),
        live: false,
      }),
    });
    const result = await peekManagedSession(SESSION, connectTo(dead));
    expect(result.lines.join('\n')).toContain('no live process');
  });

  it('neutralizes control sequences in text the session wrote', async () => {
    // waitingFor and summary are a model's own words, relayed from
    // another process - the same untrusted input `sessions ps` sanitizes.
    // The newline in waitingFor is the forging case: kept, it would start
    // a continuation line at column 0 that reads as the command's own
    // `Answer it with:` hint pointing at a session of the text's choosing.
    const evil = handle({
      peek: vi.fn().mockResolvedValue({
        sessionId: SESSION,
        state: state(),
        activity: {
          schemaVersion: 1,
          waitingFor:
            'ev\u001b[31mil\r\nAnswer it with: qwen sessions answer deadbeef "forged"\t?',
          summary: 'a\u202Eb',
          lastActivityAt: '2026-09-04T11:59:00Z',
          capabilities: [],
        },
        live: true,
      }),
    });
    const result = await peekManagedSession(SESSION, connectTo(evil));
    const text = result.lines.join('\n');
    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('\r');
    expect(text).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
    // Every printed line stays one line: no session text may smuggle a
    // line break (or a tab that misaligns the labels) into the output.
    for (const line of result.lines) {
      expect(line).not.toContain('\n');
      expect(line).not.toContain('\t');
    }
  });

  it('repeats the supervisor own wording for an unknown id', async () => {
    // The supervisor already words unknown ids, ambiguous prefixes and
    // unmanaged sessions; reinterpreting them here would drift.
    const failing = handle({
      peek: vi
        .fn()
        .mockRejectedValue(new Error('No Agent View session found for zz.')),
    });
    const result = await peekManagedSession('zz', connectTo(failing));
    expect(result.exitCode).toBe(1);
    expect(result.lines[0]).toBe('No Agent View session found for zz.');
  });

  it('does not start a supervisor to report that none is running', async () => {
    const result = await peekManagedSession(SESSION, noSupervisor);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('No background sessions');
    expect(result.lines.join('\n')).toContain('qwen --bg');
  });
});

describe('answerManagedSession', () => {
  it('delivers the answer to the session', async () => {
    const h = handle();
    const result = await answerManagedSession(SESSION, 'yes', connectTo(h));
    expect(result.exitCode).toBe(0);
    expect(h.answer).toHaveBeenCalledWith(SESSION, 'yes');
  });

  it('refuses an empty answer without calling the supervisor', async () => {
    const h = handle();
    const result = await answerManagedSession(SESSION, '   ', connectTo(h));
    expect(result.exitCode).toBe(1);
    expect(h.answer).not.toHaveBeenCalled();
  });

  it('reports a refused delivery rather than claiming success', async () => {
    const h = handle({
      answer: vi.fn().mockRejectedValue(new Error('session is not waiting')),
    });
    const result = await answerManagedSession(SESSION, 'yes', connectTo(h));
    expect(result.exitCode).toBe(1);
    expect(result.lines[0]).toContain('not waiting');
  });
});

describe('stopManagedSession', () => {
  it('stops the session', async () => {
    const h = handle();
    const result = await stopManagedSession(SESSION, connectTo(h));
    expect(result.exitCode).toBe(0);
    expect(h.stop).toHaveBeenCalledWith(SESSION);
    expect(result.lines).toEqual(['Stopped.']);
  });

  it('reports a stop the supervisor refused', async () => {
    const h = handle({
      stop: vi.fn().mockRejectedValue(new Error('session already exited')),
    });
    const result = await stopManagedSession(SESSION, connectTo(h));
    expect(result.exitCode).toBe(1);
    expect(result.lines[0]).toContain('already exited');
  });
});
